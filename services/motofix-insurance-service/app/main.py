# app/main.py — Insurance Service
#
# Handles vehicle insurance inside MOTOFIX. Two main jobs:
#   1. Applications — a driver applies for cover; we record it as a lead and the
#      driver picks one of several insurers from a catalog.
#   2. Claims — a driver files a claim after an incident (with photos), and it moves
#      through statuses (pending → reviewed → approved/rejected).
#
# Uploaded claim photos are saved to the UPLOADS_DIR folder and served back to the apps.

import base64
import logging
import os
import random
import string
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import asyncpg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt

from .schemas import ApplicationCreate, ApplicationResponse, ClaimCreate, ClaimResponse

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

def _require_secret() -> str:
    secret = os.getenv("SECRET_KEY")
    if not secret:
        logger.critical("Missing required SECRET_KEY environment variable for motofix-insurance-service")
        raise RuntimeError(
            "Missing required SECRET_KEY environment variable for motofix-insurance-service. "
            "This service must fail loudly instead of accepting unsigned tokens."
        )
    return secret


SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM   = os.getenv("ALGORITHM", "HS256")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5433/motofix_insurance")
UPLOADS_DIR  = Path(os.getenv("UPLOADS_DIR", "./uploads/claims"))


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    _require_secret()
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    app.state.pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    await _create_tables(app.state.pool)
    logger.info("Insurance service ready — uploads at %s", UPLOADS_DIR.resolve())
    yield
    await app.state.pool.close()
    logger.info("Insurance service shutdown")


async def _create_tables(pool: asyncpg.Pool):
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claims (
                id               SERIAL PRIMARY KEY,
                reference        VARCHAR(20)  UNIQUE NOT NULL,
                user_id          INTEGER      NOT NULL,
                user_phone       VARCHAR(20)  NOT NULL DEFAULT '',
                claim_type       VARCHAR(30)  NOT NULL,
                claim_type_label VARCHAR(50)  NOT NULL,
                incident_date    DATE         NOT NULL,
                incident_time    VARCHAR(10)  NOT NULL,
                location         TEXT         NOT NULL,
                description      TEXT         NOT NULL,
                injuries         BOOLEAN,
                third_party      BOOLEAN,
                status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
                created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
                updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claim_photos (
                id         SERIAL  PRIMARY KEY,
                claim_id   INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
                slot       VARCHAR(50) NOT NULL,
                file_path  TEXT        NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS applications (
                id            SERIAL PRIMARY KEY,
                reference     VARCHAR(20) UNIQUE NOT NULL,
                user_id       INTEGER NOT NULL,
                user_phone    VARCHAR(20) NOT NULL DEFAULT '',
                insurer_id    VARCHAR(40) NOT NULL,
                insurer_name  VARCHAR(120) NOT NULL,
                cover_type    VARCHAR(40) NOT NULL,
                cover_label   VARCHAR(80) NOT NULL,
                vehicle_reg   VARCHAR(40) NOT NULL,
                vehicle_make  VARCHAR(60) DEFAULT '',
                vehicle_model VARCHAR(60) DEFAULT '',
                vehicle_year  VARCHAR(10) DEFAULT '',
                period        VARCHAR(30) NOT NULL DEFAULT '1 year',
                notes         TEXT DEFAULT '',
                status        VARCHAR(20) NOT NULL DEFAULT 'pending',
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        # Tie claims to the driver's chosen insurer (added after the original schema).
        await conn.execute("ALTER TABLE claims ADD COLUMN IF NOT EXISTS insurer_id VARCHAR(40)")
        await conn.execute("ALTER TABLE claims ADD COLUMN IF NOT EXISTS insurer_name VARCHAR(120)")
    logger.info("Insurance tables ready")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="MOTOFIX — Insurance Claims Service",
    description="Stores and tracks insurance claims filed by MOTOFIX drivers.",
    version="1.0.0",
    lifespan=lifespan,
)

# Serve uploaded photos as static files at /uploads/claims/<ref>/<slot>.jpg
UPLOADS_DIR.parent.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR.parent)), name="uploads")

# ── CORS ──────────────────────────────────────────────────────────────────────

_ALLOWED_ORIGINS = [
    "https://customer.motofix.org",
    "https://admin.motofix.org",
    "https://motofix.org",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:8083",
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
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def _user_id(payload: dict) -> int:
    return int(payload.get("user_id") or payload.get("sub") or 0)

def _user_phone(payload: dict) -> str:
    return str(payload.get("phone") or "")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _generate_ref() -> str:
    year   = datetime.now().year
    suffix = "".join(random.choices(string.digits, k=6))
    return f"CLM-{year}-{suffix}"


def _app_ref() -> str:
    return f"POL-{datetime.now().year}-{''.join(random.choices(string.digits, k=6))}"


# ── Insurer catalog — motor insurers commonly used in Kampala/Uganda ────────────
# Real companies; contacts are intentionally left for admin to configure. Edit here
# (or later move to a DB table) to add/remove insurers.
INSURERS = [
    {"id": "uap",       "name": "UAP Old Mutual Insurance",         "short": "UAP Old Mutual",   "tagline": "One of Uganda's largest general insurers."},
    {"id": "jubilee",   "name": "Jubilee Allianz General Insurance","short": "Jubilee Allianz",  "tagline": "Backed by global insurer Allianz."},
    {"id": "sanlam",    "name": "Sanlam General Insurance Uganda",  "short": "Sanlam",           "tagline": "Pan-African insurer with strong motor cover."},
    {"id": "britam",    "name": "Britam Insurance Uganda",          "short": "Britam",           "tagline": "Wide branch network and quick claims."},
    {"id": "icea",      "name": "ICEA Lion General Insurance",      "short": "ICEA Lion",        "tagline": "Trusted East-African insurer."},
    {"id": "goldstar",  "name": "Goldstar Insurance",               "short": "Goldstar",         "tagline": "Known for affordable motor cover."},
    {"id": "cic",       "name": "CIC Africa Insurance (Uganda)",    "short": "CIC Africa",       "tagline": "Co-operative insurer with flexible plans."},
    {"id": "nic",       "name": "NIC General Insurance",            "short": "NIC",              "tagline": "Long-established Ugandan insurer."},
    {"id": "liberty",   "name": "Liberty General Insurance Uganda", "short": "Liberty",          "tagline": "Part of the Liberty group."},
    {"id": "apa",       "name": "APA Insurance (Uganda)",           "short": "APA",              "tagline": "Regional insurer with quick turnaround."},
    {"id": "statewide", "name": "Statewide Insurance Company",      "short": "Statewide (SWICO)","tagline": "One of Uganda's oldest insurers."},
]

COVER_TYPES = [
    {"id": "third_party",            "label": "Third-Party Only",          "blurb": "The legal minimum. Covers injury or damage you cause to other people and their property."},
    {"id": "third_party_fire_theft", "label": "Third-Party, Fire & Theft", "blurb": "Adds cover if your vehicle is stolen or damaged by fire."},
    {"id": "comprehensive",          "label": "Comprehensive",             "blurb": "Full cover — including accidental damage to your own vehicle."},
]


def _save_photo(claim_ref: str, slot: str, data_url: str) -> Optional[str]:
    try:
        header, b64 = data_url.split(",", 1)
        ext = "png" if "png" in header else "jpg"
        claim_dir = UPLOADS_DIR / claim_ref
        claim_dir.mkdir(parents=True, exist_ok=True)
        safe_slot = slot.lower().replace(" ", "_").replace("/", "_")
        path = claim_dir / f"{safe_slot}.{ext}"
        path.write_bytes(base64.b64decode(b64))
        return str(path)
    except Exception as exc:
        logger.error("Photo save failed — slot=%s err=%s", slot, exc)
        return None


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health():
    return {
        "status": "ok",
        "service": "motofix-insurance-service",
        "jwt_secret_configured": bool(os.getenv("SECRET_KEY")),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/insurers", tags=["insurers"])
async def list_insurers():
    """Public catalog of motor insurers + cover types the driver can apply for."""
    return {"insurers": INSURERS, "cover_types": COVER_TYPES}


# ── Applications (apply for cover) ──────────────────────────────────────────────

@app.post("/applications", response_model=ApplicationResponse, status_code=201, tags=["applications"])
async def apply_insurance(body: ApplicationCreate, user: dict = Depends(_require_token)):
    """File an application to be connected to an insurer for cover (lead — insurer follows up)."""
    pool: asyncpg.Pool = app.state.pool
    uid = _user_id(user); phone = _user_phone(user)
    ref = _app_ref()
    for _ in range(10):
        if not await pool.fetchval("SELECT 1 FROM applications WHERE reference=$1", ref):
            break
        ref = _app_ref()
    row = await pool.fetchrow("""
        INSERT INTO applications (
            reference, user_id, user_phone, insurer_id, insurer_name,
            cover_type, cover_label, vehicle_reg, vehicle_make, vehicle_model,
            vehicle_year, period, notes, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
        RETURNING *
    """,
        ref, uid, phone, body.insurer_id, body.insurer_name,
        body.cover_type, body.cover_label, body.vehicle_reg, body.vehicle_make, body.vehicle_model,
        body.vehicle_year, body.period, body.notes,
    )
    logger.info("Insurance application — ref=%s user=%s insurer=%s cover=%s", ref, uid, body.insurer_id, body.cover_type)
    return ApplicationResponse.from_record(dict(row))


@app.get("/applications", response_model=list[ApplicationResponse], tags=["applications"])
async def list_applications(user: dict = Depends(_require_token)):
    """All of the authenticated driver's insurance applications/policies, newest first."""
    pool: asyncpg.Pool = app.state.pool
    rows = await pool.fetch(
        "SELECT * FROM applications WHERE user_id=$1 ORDER BY created_at DESC", _user_id(user)
    )
    return [ApplicationResponse.from_record(dict(r)) for r in rows]


@app.patch("/applications/{reference}/status", response_model=ApplicationResponse, tags=["applications"])
async def update_application_status(reference: str, status: str, user: dict = Depends(_require_token)):
    """Update an application's status (admin/insurer use)."""
    valid = {"pending", "under_review", "active", "rejected", "expired", "cancelled"}
    if status not in valid:
        raise HTTPException(status_code=400, detail=f"Status must be one of: {', '.join(valid)}")
    pool: asyncpg.Pool = app.state.pool
    row = await pool.fetchrow(
        "UPDATE applications SET status=$1, updated_at=NOW() WHERE reference=$2 RETURNING *", status, reference
    )
    if not row:
        raise HTTPException(status_code=404, detail="Application not found")
    return ApplicationResponse.from_record(dict(row))


@app.post("/claims", response_model=ClaimResponse, status_code=201, tags=["claims"])
async def submit_claim(body: ClaimCreate, user: dict = Depends(_require_token)):
    """Submit a new insurance claim. Photos are accepted as base64 data URLs."""
    pool: asyncpg.Pool = app.state.pool
    uid   = _user_id(user)
    phone = _user_phone(user)

    # Generate a unique reference
    ref = _generate_ref()
    for _ in range(10):
        exists = await pool.fetchval("SELECT 1 FROM claims WHERE reference=$1", ref)
        if not exists:
            break
        ref = _generate_ref()

    async with pool.acquire() as conn:
        claim_id = await conn.fetchval("""
            INSERT INTO claims (
                reference, user_id, user_phone,
                claim_type, claim_type_label,
                incident_date, incident_time,
                location, description,
                injuries, third_party, insurer_id, insurer_name, status
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
            RETURNING id
        """,
            ref, uid, phone,
            body.type, body.type_label,
            body.incident_date, body.incident_time,
            body.location, body.description,
            body.injuries, body.third_party, body.insurer_id, body.insurer_name,
        )

        # Persist photos to disk and record paths
        for photo in body.photos:
            file_path = _save_photo(ref, photo.slot, photo.preview)
            if file_path:
                await conn.execute("""
                    INSERT INTO claim_photos (claim_id, slot, file_path)
                    VALUES ($1, $2, $3)
                """, claim_id, photo.slot, file_path)

        row    = await conn.fetchrow("SELECT * FROM claims WHERE id=$1", claim_id)
        photos = await conn.fetch("SELECT * FROM claim_photos WHERE claim_id=$1 ORDER BY id", claim_id)

    logger.info("Claim submitted — ref=%s user=%s type=%s", ref, uid, body.type)
    return ClaimResponse.from_record(dict(row), [dict(p) for p in photos])


@app.get("/claims", response_model=list[ClaimResponse], tags=["claims"])
async def list_claims(user: dict = Depends(_require_token)):
    """Return all claims filed by the authenticated user, newest first."""
    pool: asyncpg.Pool = app.state.pool
    uid = _user_id(user)

    rows = await pool.fetch(
        "SELECT * FROM claims WHERE user_id=$1 ORDER BY created_at DESC", uid
    )
    result = []
    for row in rows:
        photos = await pool.fetch(
            "SELECT * FROM claim_photos WHERE claim_id=$1 ORDER BY id", row["id"]
        )
        result.append(ClaimResponse.from_record(dict(row), [dict(p) for p in photos]))
    return result


@app.get("/claims/{reference}", response_model=ClaimResponse, tags=["claims"])
async def get_claim(reference: str, user: dict = Depends(_require_token)):
    """Fetch a single claim by its reference number."""
    pool: asyncpg.Pool = app.state.pool
    uid = _user_id(user)

    row = await pool.fetchrow(
        "SELECT * FROM claims WHERE reference=$1 AND user_id=$2", reference, uid
    )
    if not row:
        raise HTTPException(status_code=404, detail="Claim not found")

    photos = await pool.fetch(
        "SELECT * FROM claim_photos WHERE claim_id=$1 ORDER BY id", row["id"]
    )
    return ClaimResponse.from_record(dict(row), [dict(p) for p in photos])


@app.patch("/claims/{reference}/status", response_model=ClaimResponse, tags=["claims"])
async def update_status(reference: str, status: str, user: dict = Depends(_require_token)):
    """Update the status of a claim (admin use)."""
    valid = {"pending", "under_review", "approved", "rejected", "settled"}
    if status not in valid:
        raise HTTPException(status_code=400, detail=f"Status must be one of: {', '.join(valid)}")

    pool: asyncpg.Pool = app.state.pool
    row = await pool.fetchrow("""
        UPDATE claims SET status=$1, updated_at=NOW()
        WHERE reference=$2 RETURNING *
    """, status, reference)
    if not row:
        raise HTTPException(status_code=404, detail="Claim not found")

    photos = await pool.fetch(
        "SELECT * FROM claim_photos WHERE claim_id=$1 ORDER BY id", row["id"]
    )
    return ClaimResponse.from_record(dict(row), [dict(p) for p in photos])
