# motofix-core/app/main.py
#
# The "core gateway" — a small central service that the other MOTOFIX services
# and the admin dashboard talk to. It does three jobs:
#   1. Keeps the master list of where every other service lives (the registry).
#   2. Pings each service to check if it's alive (health checks).
#   3. Hands out shared settings like subscription price and bank details (config).
# It does NOT handle business logic itself — think of it as a switchboard/notice board.

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Dict, Optional

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

def _require_secret() -> str:
    secret = os.getenv("SECRET_KEY")
    if not secret:
        logger.critical("Missing required SECRET_KEY environment variable for motofix-core")
        raise RuntimeError(
            "Missing required SECRET_KEY environment variable for motofix-core. "
            "This service must fail loudly instead of accepting unsigned tokens."
        )
    return secret


SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM  = os.getenv("ALGORITHM", "HS256")

# ── Service registry ──────────────────────────────────────────────────────────
# Loaded from env so production URLs can differ from local dev.

SERVICES: Dict[str, str] = {
    "auth":          os.getenv("AUTH_SERVICE_URL",         "http://localhost:8000"),
    "dispatch":      os.getenv("DISPATCH_SERVICE_URL",     "http://localhost:8001"),
    "verification":  os.getenv("VERIFICATION_SERVICE_URL", "http://localhost:8002"),
    "matching":      os.getenv("MATCHING_SERVICE_URL",     "http://localhost:8003"),
    "notifications": os.getenv("NOTIFICATIONS_SERVICE_URL","http://localhost:8004"),
    "analytics":     os.getenv("ANALYTICS_SERVICE_URL",    "http://localhost:8005"),
    "insurance":     os.getenv("INSURANCE_SERVICE_URL",    "http://localhost:8006"),
    "diagnosis":     os.getenv("DIAGNOSIS_SERVICE_URL",    "http://localhost:8007"),
}


# ── App ───────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    _require_secret()
    logger.info("=" * 60)
    logger.info("🚀 MOTOFIX Core Gateway v1.0 starting")
    logger.info("Registered services: %s", list(SERVICES.keys()))
    logger.info("=" * 60)
    yield
    logger.info("MOTOFIX Core Gateway shutdown")


app = FastAPI(
    title="MOTOFIX — Core Gateway",
    description=(
        "Platform gateway for the MOTOFIX microservices ecosystem. "
        "Provides health aggregation, service registry, and shared platform configuration. "
        "All inter-service URLs are documented here."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────

_ALLOWED_ORIGINS = [
    "https://customer.motofix.org",
    "https://admin.motofix.org",
    "https://motofix.org",
    "https://motofix-control-center.onrender.com",
    "https://motofix-driver-assist.onrender.com",
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
    "http://localhost:8088",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8083",
    "http://127.0.0.1:8084",
    "http://127.0.0.1:8085",
    "http://127.0.0.1:8086",
    "http://192.168.1.3:8080",
    "http://192.168.1.3:5173",
    "http://192.168.1.3:3000",
    "http://192.168.1.3:8083",
    "http://192.168.1.3:8084",
    "http://192.168.1.3:8085",
    "http://192.168.1.3:8086",
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
    # Checks the "Authorization: Bearer <token>" header on a request and makes sure
    # the token is a valid, unexpired login token. Returns the token's contents if OK,
    # or raises a 401 (unauthorized) error if it's missing, malformed, or invalid.
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


# ── Health helpers ────────────────────────────────────────────────────────────

async def _probe_service(name: str, base_url: str, client: httpx.AsyncClient) -> dict:
    """Probe a single service's /health endpoint and return status info."""
    try:
        resp = await client.get(f"{base_url}/health", timeout=4.0)
        ok = resp.status_code == 200
        return {
            "name": name,
            "url": base_url,
            "status": "up" if ok else "degraded",
            "http_status": resp.status_code,
            "detail": resp.json() if ok else resp.text[:200],
        }
    except httpx.ConnectError:
        return {"name": name, "url": base_url, "status": "down", "error": "Connection refused"}
    except httpx.TimeoutException:
        return {"name": name, "url": base_url, "status": "down", "error": "Timeout"}
    except Exception as exc:
        return {"name": name, "url": base_url, "status": "down", "error": str(exc)}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health():
    """Core gateway liveness check."""
    return {
        "status": "ok",
        "service": "motofix-core",
        "jwt_secret_configured": bool(os.getenv("SECRET_KEY")),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/services", tags=["registry"])
async def list_services():
    """Return the full service registry (names → base URLs)."""
    return {
        "services": [
            {"name": name, "url": url}
            for name, url in SERVICES.items()
        ]
    }


@app.get("/health/all", tags=["system"])
async def health_all():
    """
    Probe every registered microservice's /health endpoint concurrently.
    Returns a summary of which services are up, degraded, or down.
    Useful for the admin dashboard status panel.
    """
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *[_probe_service(name, url, client) for name, url in SERVICES.items()]
        )

    # Sort the results into three buckets so we can summarise them.
    up    = [r for r in results if r["status"] == "up"]        # responding normally
    down  = [r for r in results if r["status"] == "down"]      # unreachable
    deg   = [r for r in results if r["status"] == "degraded"]  # replied, but not healthy

    # Overall verdict: all good = "healthy"; some slow but none dead = "degraded";
    # at least one service completely down = "critical".
    overall = "healthy" if not down and not deg else ("degraded" if not down else "critical")

    return {
        "overall": overall,
        "summary": {"up": len(up), "degraded": len(deg), "down": len(down)},
        "services": results,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/config", tags=["config"])
async def platform_config(_user: dict = Depends(_require_token)):
    """
    Return the platform-wide service configuration (URLs, feature flags).
    Requires a valid JWT — used by services during startup to discover peers.
    """
    return {
        "version": "1.0.0",
        "environment": os.getenv("ENV", "development"),
        "services": SERVICES,
        "features": {
            "subscriptions_enabled": True,
            "insurance_enabled": True,
            "ai_diagnosis_enabled": True,
            "whatsapp_enabled": bool(os.getenv("AT_API_KEY")),
            "fcm_push_enabled": bool(os.getenv("FCM_PROJECT_ID")),
        },
        "subscription": {
            "price_ugx": 20_000,
            "trial_days": 7,
            "grace_days": 3,
            "currency": "UGX",
        },
        "payments": {
            "bank_name": "Stanbic Bank Uganda",
            "account_name": "EKIDDUKA SERVICES LTD",
            "account_number": "9030005754210",
            "branch": "Kampala Main",
            "swift_code": "SBICUGKX",
        },
    }


@app.get("/", tags=["system"])
async def root():
    return {
        "message": "MOTOFIX Core Gateway — all systems routing",
        "docs": "/docs",
        "health": "/health",
        "services": "/services",
        "health_all": "/health/all",
    }
