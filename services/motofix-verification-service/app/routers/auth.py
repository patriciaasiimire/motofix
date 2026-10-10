# app/routers/auth.py
# Mechanic authentication - login, profile, availability, location

import os
import logging
from datetime import datetime, timedelta
from typing import Optional
import secrets

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from jose import jwt, JWTError
import asyncpg
import hashlib
import hmac

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Auth"])

# ────────────────────────────── HELPERS ──────────────────────────────

def _get_secret() -> str:
    secret = os.getenv("SECRET_KEY")
    if not secret:
        raise RuntimeError("SECRET_KEY environment variable is not set")
    return secret

def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def _generate_password() -> str:
    return secrets.token_urlsafe(12)  # Generate a secure random password

def _verify_password(plain: str, hashed: str) -> bool:
    return hmac.compare_digest(hashlib.sha256(plain.encode()).hexdigest(), hashed)

def _create_token(mechanic_id: int, phone: str) -> str:
    expire = datetime.utcnow() + timedelta(hours=int(os.getenv("TOKEN_EXPIRE_HOURS", "72")))
    payload = {
        "sub": str(mechanic_id),
        "phone": phone,
        "role": "mechanic",
        "exp": expire,
    }
    return jwt.encode(payload, _get_secret(), algorithm="HS256")

async def _get_db_pool():
    from ..main import pool
    return pool

async def get_current_mechanic(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, _get_secret(), algorithms=["HS256"])
        mechanic_id = int(payload.get("sub", 0))
        if not mechanic_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        return {"id": mechanic_id, "phone": payload.get("phone"), "role": "mechanic"}
    except JWTError as e:
        logger.warning(f"JWT decode failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# ────────────────────────────── SCHEMAS ──────────────────────────────

class LoginRequest(BaseModel):
    phone: str
    password: str

class RegisterRequest(BaseModel):
    name: Optional[str] = None
    full_name: Optional[str] = None
    phone: str
    password: Optional[str] = None
    location: Optional[str] = None
    specialty: Optional[str] = "General Repair"
    vehicle_type: Optional[str] = "car"
    service_area_ids: list[int] = Field(default_factory=list)

class TokenResponse(BaseModel):
    token: str
    mechanic_id: int
    name: str
    phone: str
    location: Optional[str] = None
    service_area_ids: list[int] = Field(default_factory=list)
    is_verified: bool = False
    is_available: bool = True
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class AvailabilityUpdate(BaseModel):
    is_available: bool

class LocationUpdate(BaseModel):
    latitude: float
    longitude: float
    location: Optional[str] = None

class FcmTokenUpdate(BaseModel):
    fcm_token: str


# ────────────────────────────── ENDPOINTS ──────────────────────────────

@router.post("/auth/register", response_model=TokenResponse)
async def register(body: RegisterRequest):
    """Register a new mechanic account."""
    mechanic_name = (body.name or body.full_name or "").strip()
    if not mechanic_name:
        raise HTTPException(status_code=422, detail="name is required")
    phone = body.phone.strip()
    if not phone:
        raise HTTPException(status_code=422, detail="phone is required")
    try:
        secret = _get_secret()
    except RuntimeError as e:
        logger.error(f"SECRET_KEY missing: {e}")
        raise HTTPException(status_code=500, detail="Server misconfiguration: SECRET_KEY is not set")

    pool = await _get_db_pool()
    async with pool.acquire() as db:
        # Check phone not already taken
        try:
            existing = await db.fetchrow(
                "SELECT id FROM mechanics WHERE phone = $1", phone
            )
            if existing:
                raise HTTPException(status_code=409, detail="Phone number already registered")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Phone check failed: {e}")
            raise HTTPException(status_code=500, detail=f"Database error during phone check: {str(e)}")

        hashed = _hash_password(body.password if body.password else _generate_password())

        # Try insert - use only columns we know exist, let DB use defaults for the rest
        try:
            row = await db.fetchrow(
                """
                INSERT INTO mechanics
                    (name, phone, location, specialty, vehicle_type,
                     service_area_ids, is_available, rating, total_ratings,
                     is_verified, jobs_completed, password_hash)
                VALUES ($1, $2, $3, $4, $5, $6, true, 0, 0, false, 0, $7)
                RETURNING id, name, phone, location, service_area_ids,
                          is_verified, is_available, latitude, longitude
                """,
                mechanic_name,
                phone,
                body.location,
                body.specialty or "General Repair",
                body.vehicle_type or "car",
                body.service_area_ids,
                hashed,
            )
        except Exception as e:
            logger.error(f"INSERT failed: {type(e).__name__}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to create account: {str(e)}")

        if not row:
            raise HTTPException(status_code=500, detail="Insert returned no row")

        try:
            token = _create_token(row["id"], row["phone"])
        except Exception as e:
            logger.error(f"Token creation failed: {e}")
            raise HTTPException(status_code=500, detail=f"Token error: {str(e)}")

        logger.info(f"✅ New mechanic registered: id={row['id']} phone={row['phone']}")
        return TokenResponse(
            token=token,
            mechanic_id=row["id"],
            name=row["name"],
            phone=row["phone"],
            location=row["location"],
            service_area_ids=list(row["service_area_ids"] or []),
            is_verified=row["is_verified"],
            is_available=row["is_available"],
            latitude=row["latitude"],
            longitude=row["longitude"],
        )


@router.post("/auth/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    """Mechanic login with phone + password."""
    try:
        _get_secret()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail="Server misconfiguration: SECRET_KEY is not set")

    pool = await _get_db_pool()
    async with pool.acquire() as db:
        try:
            identifier = body.phone.strip()
            if identifier.upper().startswith("SPN-"):
                try:
                    mechanic_id = int(identifier.split("-", 1)[1])
                    row = await db.fetchrow(
                        "SELECT id, name, phone, password_hash FROM mechanics WHERE id = $1",
                        mechanic_id,
                    )
                except (ValueError, IndexError):
                    row = None
            else:
                row = await db.fetchrow(
                    "SELECT id, name, phone, password_hash FROM mechanics WHERE phone = $1",
                    identifier,
                )
        except Exception as e:
            logger.error(f"Login DB query failed: {e}")
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

        if not row:
            raise HTTPException(status_code=401, detail="Invalid phone number or password")

        stored_hash = row["password_hash"]
        if not stored_hash:
            raise HTTPException(
                status_code=401,
                detail="No password set for this account. Contact your supervisor.",
            )

        if not _verify_password(body.password, stored_hash):
            raise HTTPException(status_code=401, detail="Invalid phone number or password")

        token = _create_token(row["id"], row["phone"])
        logger.info(f"✅ Mechanic logged in: id={row['id']}")
        return TokenResponse(
            token=token,
            mechanic_id=row["id"],
            name=row["name"],
            phone=row["phone"],
        )


@router.get("/auth/me")
async def get_me(current: dict = Depends(get_current_mechanic)):
    """Return full mechanic profile for the authenticated mechanic."""
    pool = await _get_db_pool()
    async with pool.acquire() as db:
        try:
            row = await db.fetchrow(
                """
                SELECT id, name, phone, location, latitude, longitude,
                       specialty, vehicle_type, is_available,
                       rating, total_ratings, is_verified, jobs_completed
                FROM mechanics WHERE id = $1
                """,
                current["id"],
            )
        except Exception as e:
            logger.error(f"get_me DB query failed: {e}")
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

        if not row:
            raise HTTPException(status_code=404, detail="Mechanic not found")
        return dict(row)


@router.patch("/mechanics/me/availability")
async def update_availability(
    body: AvailabilityUpdate,
    current: dict = Depends(get_current_mechanic),
):
    """Toggle the mechanic's online/offline availability status."""
    pool = await _get_db_pool()
    async with pool.acquire() as db:
        row = await db.fetchrow(
            "UPDATE mechanics SET is_available = $1 WHERE id = $2 RETURNING id, is_available",
            body.is_available, current["id"],
        )
        if not row:
            raise HTTPException(status_code=404, detail="Mechanic not found")
        return {"id": row["id"], "is_available": row["is_available"]}


@router.patch("/mechanics/me/location")
async def update_location(
    body: LocationUpdate,
    current: dict = Depends(get_current_mechanic),
):
    """Update the mechanic's GPS coordinates."""
    pool = await _get_db_pool()
    async with pool.acquire() as db:
        if body.location:
            row = await db.fetchrow(
                """
                UPDATE mechanics SET latitude = $1, longitude = $2, location = $3
                WHERE id = $4 RETURNING id, latitude, longitude, location
                """,
                body.latitude, body.longitude, body.location, current["id"],
            )
        else:
            row = await db.fetchrow(
                """
                UPDATE mechanics SET latitude = $1, longitude = $2
                WHERE id = $3 RETURNING id, latitude, longitude, location
                """,
                body.latitude, body.longitude, current["id"],
            )
        if not row:
            raise HTTPException(status_code=404, detail="Mechanic not found")
        return dict(row)


@router.get("/mechanics/me/current-job")
async def get_current_job(current: dict = Depends(get_current_mechanic)):
    """Return the active job for this mechanic by proxying to the dispatch service."""
    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{dispatch_url}/mechanics/{current['id']}/current-job")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"Could not fetch current job from dispatch service: {e}")
    return {"job": None}


@router.get("/mechanics/me/completed-jobs")
async def get_my_completed_jobs(current: dict = Depends(get_current_mechanic)):
    """This mechanic's completed-job history — proxied from the dispatch service."""
    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{dispatch_url}/mechanics/{current['id']}/completed-jobs")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"Could not fetch completed jobs from dispatch service: {e}")
    return {"mechanic_id": current["id"], "total": 0, "jobs": []}


@router.get("/mechanics/me/handled-jobs")
async def get_my_handled_jobs(current: dict = Depends(get_current_mechanic)):
    """This mechanic's handled jobs (accepted, not cancelled) — proxied from dispatch.
    Powers the Today / This-Week dashboard counts."""
    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{dispatch_url}/mechanics/{current['id']}/handled-jobs")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"Could not fetch handled jobs from dispatch service: {e}")
    return {"mechanic_id": current["id"], "total": 0, "jobs": []}


@router.get("/mechanics/me/job-history")
async def get_my_job_history(current: dict = Depends(get_current_mechanic)):
    """This mechanic's finished jobs — completed AND cancelled — proxied from dispatch."""
    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{dispatch_url}/mechanics/{current['id']}/job-history")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"Could not fetch job history from dispatch service: {e}")
    return {"mechanic_id": current["id"], "total": 0, "jobs": []}


@router.get("/mechanics/me/strikes")
async def get_my_strikes(current: dict = Depends(get_current_mechanic)):
    """This mechanic's consecutive-cancellation strikes + suspension state — proxied from dispatch."""
    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{dispatch_url}/mechanics/{current['id']}/strikes")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"Could not fetch strikes from dispatch service: {e}")
    return {"mechanic_id": current["id"], "strikes": 0, "suspended": False, "limit": 3}


@router.get("/mechanics/me/reviews")
async def get_my_reviews(current: dict = Depends(get_current_mechanic)):
    """This mechanic's reviews + average rating — proxied from the dispatch service."""
    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{dispatch_url}/mechanics/{current['id']}/reviews")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"Could not fetch reviews from dispatch service: {e}")
    return {"mechanic_id": current["id"], "total_reviews": 0, "average_rating": None, "reviews": []}


@router.post("/mechanics/me/fcm-token")
async def register_fcm_token(
    body: FcmTokenUpdate,
    current: dict = Depends(get_current_mechanic),
):
    """
    Register or refresh the mechanic's Firebase Cloud Messaging device token.
    The mechanic app should call this after login and whenever the FCM token refreshes.
    Used to send push notifications for new job assignments.
    """
    pool = await _get_db_pool()
    async with pool.acquire() as db:
        # Ensure column exists (idempotent)
        try:
            await db.execute("ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS fcm_token TEXT")
        except Exception:
            pass
        await db.execute(
            "UPDATE mechanics SET fcm_token = $1 WHERE id = $2",
            body.fcm_token, current["id"],
        )
    logger.info("FCM token registered for mechanic id=%s", current["id"])
    return {"detail": "FCM token registered successfully"}
