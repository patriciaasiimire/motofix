# main.py — Mechanic Matching Service (the web/API layer)
#
# This is the entry point of the matching service. The actual "who's the best
# mechanic" maths lives in scoring.py; this file wires that up to the outside world.
#
# The typical flow when a driver breaks down:
#   1. Another service calls POST /match with the breakdown location + problem type.
#   2. We ask the Verification Service for the list of verified, available mechanics.
#   3. We skip anyone who already declined/ignored THIS request (so we don't re-ask them).
#   4. scoring.py ranks the rest; we save them as "pending" and return the top few.
#   5. As each mechanic responds, POST /dispatch/{id}/outcome records accepted/declined/expired.
#   6. If they decline, the caller calls /match again — step 3 now skips them automatically.
#
# All endpoints require a valid login token (see _require_token below).

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

import asyncpg
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt

load_dotenv()

from .areas import AREA_INDEX, AREA_NAMES, resolve_area, SERVICE_AREA_MATCH_AREAS
from .schemas import DispatchOutcome, MatchRequest, MatchResponse
from .scoring import rank_launch_fallback, rank_mechanics

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")


def _require_secret() -> str:
    secret = os.getenv("SECRET_KEY")
    if not secret:
        logger.critical("Missing required SECRET_KEY environment variable for motofix-matching-service")
        raise RuntimeError(
            "Missing required SECRET_KEY environment variable for motofix-matching-service. "
            "This service must fail loudly instead of accepting unsigned tokens."
        )
    return secret


SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
MECHANICS_SERVICE_URL = (
    os.getenv("MECHANICS_SERVICE_URL", "http://127.0.0.1:8002")
    .replace("://localhost", "://127.0.0.1", 1)
    .rstrip("/")
)
LAUNCH_MODE = os.getenv("LAUNCH_MODE", "false").strip().lower() == "true"

pool: Optional[asyncpg.Pool] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    _require_secret()
    if DATABASE_URL:
        # Open a small pool of reusable database connections (faster than opening
        # a fresh connection for every request).
        pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        async with pool.acquire() as conn:
            # Make sure our one table exists. It logs every time we offer a request
            # to a mechanic and what happened (pending → accepted/declined/expired).
            # The UNIQUE rule stops the same mechanic being logged twice for one request.
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS dispatch_attempts (
                    id           SERIAL PRIMARY KEY,
                    request_id   INTEGER      NOT NULL,
                    mechanic_id  INTEGER      NOT NULL,
                    attempted_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                    outcome      VARCHAR(20)  NOT NULL DEFAULT 'pending',
                    UNIQUE (request_id, mechanic_id)
                )
            """)
        logger.info("Mechanic matching service: DB pool ready")
    else:
        logger.warning("DATABASE_URL not set — dispatch history tracking disabled")
    yield
    if pool:
        await pool.close()
        logger.info("Mechanic matching service: DB pool closed")


app = FastAPI(
    title="MOTOFIX - Intelligent Mechanic Matching Service",
    description=(
        "Ranks and selects the most suitable available verified service provider "
        "for each breakdown request using a weighted scoring algorithm that considers "
        "proximity, specialisation, star rating, and historical performance. "
        "Manages re-dispatch when a provider declines or fails to respond."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
_ALLOWED_ORIGINS = [
    "https://motofixug.netlify.app",
    "https://admin.motofix.org",
    "https://motofix.org",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:8083",
    "http://localhost:8084",
    "http://localhost:8084",
    "http://localhost:8085",
    "http://localhost:8086",
    "http://localhost:8087",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8083",
    "http://127.0.0.1:8084",
    "http://192.168.1.3:8080",
    "http://192.168.1.3:5173",
    "http://192.168.1.3:3000",
    "http://192.168.1.3:8083",
    "http://192.168.1.3:8084",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    # Also allow ANY local-network origin (localhost / 127.0.0.1 / private LAN IPs) on any
    # port. The apps are served on whatever host:port the demo machine happens to use (e.g.
    # http://192.168.1.3:8088), and that IP/port changes between networks — without this,
    # cross-origin calls get CORS-blocked when the apps are opened over the LAN from a phone.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    max_age=3600,
)


# ── Auth ──────────────────────────────────────────────────────────────────────

def _require_token(authorization: str = Header(...)) -> dict:
    try:
        scheme, token = authorization.split(" ", 1)
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid authentication scheme")
    except ValueError:
        raise HTTPException(status_code=401, detail="Malformed Authorization header")
    try:
        return jwt.decode(token, _require_secret(), algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health():
    return {
        "status": "ok",
        "service": "mechanic-matching",
        "jwt_secret_configured": bool(os.getenv("SECRET_KEY")),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/match", response_model=MatchResponse, tags=["matching"])
async def match_mechanics(
    body: MatchRequest,
    _user: dict = Depends(_require_token),
):
    """
    Find the best available mechanics for a breakdown request.

    Fetches verified + available mechanics from the Mechanic Verification Service,
    scores each one using the weighted algorithm, excludes any mechanics who have
    already declined or timed out on this request, and returns the top candidates.
    """
    # Build the "don't offer to these mechanics" list. It combines any IDs the
    # caller passed in manually with anyone who already declined or ran out of
    # time on this same request (looked up from the dispatch_attempts table).
    excluded_ids: List[int] = list(body.excluded_mechanic_ids or [])
    if pool and body.request_id:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT mechanic_id FROM dispatch_attempts
                   WHERE request_id = $1 AND outcome IN ('declined', 'expired')""",
                body.request_id,
            )
            excluded_ids.extend(r["mechanic_id"] for r in rows)

    # Fetch verified mechanics from the Mechanic Verification Service
    async with httpx.AsyncClient(follow_redirects=True) as client:
        try:
            resp = await client.get(
                f"{MECHANICS_SERVICE_URL}/mechanics",
                params={"verified_only": "true", "available_only": "true"},
                timeout=10.0,
            )
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload, list):
                mechanics = payload
            elif isinstance(payload, dict) and isinstance(payload.get("mechanics"), list):
                mechanics = payload["mechanics"]
            else:
                logger.error("Mechanic Verification Service returned an invalid mechanics payload")
                raise HTTPException(
                    status_code=502,
                    detail="Mechanic Verification Service returned an invalid mechanics list.",
                )
        except HTTPException:
            raise
        except httpx.HTTPStatusError as exc:
            logger.error(
                "Mechanic Verification Service returned HTTP %s: %s",
                exc.response.status_code,
                exc.response.text[:300],
            )
            raise HTTPException(
                status_code=502,
                detail=f"Mechanic Verification Service returned HTTP {exc.response.status_code}.",
            )
        except Exception as exc:
            logger.error("Failed to reach Mechanic Verification Service: %s", exc)
            raise HTTPException(
                status_code=503,
                detail=f"Could not reach Mechanic Verification Service: {exc}",
            )

    # Resolve the matching area id. The v1 flow passes an integer launch-area id
    # (e.g. 15 = Ntinda) from the verification service; the matching service works
    # with string area ids, so we convert integers via the launch-area mapping.
    raw_area = body.area_id
    if isinstance(raw_area, int):
        mapped = SERVICE_AREA_MATCH_AREAS.get(raw_area)
        driver_area_id = mapped[0] if mapped else None
    elif isinstance(raw_area, str):
        driver_area_id = raw_area
    else:
        driver_area_id = resolve_area(body.latitude, body.longitude)

    if driver_area_id is None:
        raise HTTPException(
            status_code=404,
            detail="We couldn't find mechanics for a covered area from this location. Please try a different area.",
        )

    # When there are no GPS coordinates, use the area centroid as the effective
    # request location so proximity scoring still works without a driver pin.
    request_lat = body.latitude
    request_lon = body.longitude
    if (request_lat is None or request_lon is None) and driver_area_id:
        area = AREA_INDEX.get(driver_area_id)
        if area:
            request_lat = float(area["center_lat"])
            request_lon = float(area["center_lng"])
        else:
            request_lat = 0.0
            request_lon = 0.0

    ranked = rank_mechanics(
        mechanics=mechanics,
        request_lat=request_lat,
        request_lon=request_lon,
        service_type=body.service_type,
        excluded_ids=excluded_ids,
        top_n=body.top_n or 5,
        preferred_mechanic_id=body.preferred_mechanic_id,
        area_id=driver_area_id,
    )

    if not ranked:
        if LAUNCH_MODE:
            ranked = rank_launch_fallback(
                mechanics=mechanics,
                request_lat=request_lat,
                request_lon=request_lon,
                excluded_ids=excluded_ids,
                top_n=body.top_n or 5,
                service_type=body.service_type,
                preferred_mechanic_id=body.preferred_mechanic_id,
                area_id=driver_area_id,
            )
            if ranked:
                logger.warning(
                    "Launch matching fallback used: request_id=%s area=%s considered=%s returned=%s",
                    body.request_id,
                    driver_area_id,
                    len(mechanics),
                    len(ranked),
                )

        if not ranked:
            raise HTTPException(
                status_code=404,
                detail=f"No eligible mechanics found in the covered area '{AREA_NAMES.get(driver_area_id, driver_area_id)}' for this request.",
            )

    # Save the chosen mechanics as 'pending' so that if we re-run /match later
    # (because someone declined) we remember who we already contacted.
    # ON CONFLICT DO NOTHING = quietly skip ones already logged for this request.
    if pool and body.request_id:
        async with pool.acquire() as conn:
            for candidate in ranked:
                await conn.execute(
                    """INSERT INTO dispatch_attempts (request_id, mechanic_id, outcome)
                       VALUES ($1, $2, 'pending')
                       ON CONFLICT (request_id, mechanic_id) DO NOTHING""",
                    body.request_id,
                    candidate["mechanic_id"],
                )

    return MatchResponse(
        request_id=body.request_id,
        candidates=ranked,
        total_eligible=len(ranked),
        resolved_area_id=driver_area_id,
        resolved_area_name=AREA_NAMES.get(driver_area_id, driver_area_id),
    )


@app.post("/dispatch/{request_id}/outcome", tags=["dispatch"])
async def record_outcome(
    request_id: int,
    body: DispatchOutcome,
    _user: dict = Depends(_require_token),
):
    """
    Record the outcome of a dispatch attempt (accepted / declined / expired).

    Called by the Request and Dispatch Management Service after a mechanic
    responds — or fails to respond within the time window. A 'declined' or
    'expired' outcome triggers the caller to re-invoke POST /match, which will
    automatically exclude mechanics already recorded here.
    """
    if not pool:
        raise HTTPException(status_code=503, detail="Database not configured — set DATABASE_URL")
    if body.outcome not in ("accepted", "declined", "expired"):
        raise HTTPException(status_code=422, detail="outcome must be one of: accepted, declined, expired")

    async with pool.acquire() as conn:
        result = await conn.execute(
            """UPDATE dispatch_attempts SET outcome = $1
               WHERE request_id = $2 AND mechanic_id = $3""",
            body.outcome,
            request_id,
            body.mechanic_id,
        )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="No matching dispatch attempt found")

    logger.info(
        "Dispatch outcome recorded: request=%s mechanic=%s outcome=%s",
        request_id,
        body.mechanic_id,
        body.outcome,
    )
    return {
        "message": f"Outcome '{body.outcome}' recorded for mechanic {body.mechanic_id} on request {request_id}"
    }


@app.get("/dispatch/{request_id}/history", tags=["dispatch"])
async def dispatch_history(
    request_id: int,
    _user: dict = Depends(_require_token),
):
    """Return the full dispatch attempt history for a request (for audit / re-dispatch logic)."""
    if not pool:
        raise HTTPException(status_code=503, detail="Database not configured — set DATABASE_URL")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT mechanic_id, attempted_at, outcome
               FROM dispatch_attempts
               WHERE request_id = $1
               ORDER BY attempted_at""",
            request_id,
        )

    return {
        "request_id": request_id,
        "attempts": [dict(r) for r in rows],
    }
