# app/routers/provider.py
# Mechanic and Towing Provider registration + login.

import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Optional, List

import asyncpg
import bcrypt
import httpx
from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.schemas.provider import (
    ProviderRegisterRequest,
    ProviderLoginRequest,
    ProviderLoginResponse,
    ProviderOut,
)
from app.schemas.common import SuccessResponse
from app.services.logger import log_event
from app.services.rate_limit import check_rate_limit, record_attempt
from app.services.token import create_access_token, decode_token
from app.services.otp import generate_otp, store_otp, verify_otp
from app.services.sms import send_sms, format_phone

logger = logging.getLogger(__name__)

# ── Reverse-geocode helper ────────────────────────────────────────────────────

_COORD_RE = re.compile(r'^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$')
_GEOCODE_CACHE: dict = {}  # key → (address, expires)
_GEOCODE_TTL = 300          # 5 minutes

async def _geocode_location(loc: str) -> str:
    """Return a human-readable address for a 'lat,lng' string, or loc unchanged."""
    if not loc:
        return "your area"
    m = _COORD_RE.match(loc.strip())
    if not m:
        return loc  # already a text address

    lat, lng = m.group(1), m.group(2)
    cache_key = f"{round(float(lat), 4)},{round(float(lng), 4)}"

    cached = _GEOCODE_CACHE.get(cache_key)
    if cached and time.time() < cached[1]:
        return cached[0]

    dispatch_url = os.getenv("DISPATCH_SERVICE_URL", "http://dispatch-service:8001")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(
                f"{dispatch_url}/geocode/reverse",
                params={"lat": lat, "lon": lng},
            )
            if r.status_code == 200:
                address = r.json().get("display_name") or loc
                _GEOCODE_CACHE[cache_key] = (address, time.time() + _GEOCODE_TTL)
                return address
    except Exception:
        pass

    return f"{float(lat):.4f}°{'N' if float(lat) >= 0 else 'S'}, {float(lng):.4f}°{'E' if float(lng) >= 0 else 'W'}"


router = APIRouter(prefix="/auth", tags=["Provider Auth"])


# ── DB connection helper ───────────────────────────────────────────────────────

async def _get_conn(request: Request):
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": True, "code": "DB_UNAVAILABLE",
                    "message": "Database connection pool not initialised", "status_code": 503},
        )
    return pool


# ── Bcrypt helpers ─────────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


# ── POST /auth/register/provider ──────────────────────────────────────────────

@router.post(
    "/register/provider",
    response_model=SuccessResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register mechanic or towing provider",
)
async def register_provider(body: ProviderRegisterRequest, request: Request):
    """
    Creates a new mechanic or towing provider account.
    Account is created with is_verified=False and requires admin approval.
    """
    pool = await _get_conn(request)
    password_hash = _hash_password(body.password)
    now = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        if body.provider_type == "mechanic":
            # Check for duplicate phone
            existing = await conn.fetchrow(
                "SELECT id FROM mechanics WHERE phone = $1", body.phone
            )
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": True, "code": "PHONE_TAKEN",
                            "message": "A mechanic account with this phone already exists",
                            "status_code": 409},
                )

            service_area_ids = list(dict.fromkeys((body.service_area_ids or [])[:20]))
            row = await conn.fetchrow(
                """
                INSERT INTO mechanics
                    (full_name, phone, location, latitude, longitude, specialty,
                     provider_type, vehicle_type, service_area_ids, password_hash,
                     is_verified, rating, total_ratings, jobs_completed, is_available, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,0.0,0,0,FALSE,$11)
                RETURNING id
                """,
                body.full_name, body.phone, body.location,
                body.latitude, body.longitude, body.specialty,
                body.provider_type, body.vehicle_type, service_area_ids,
                password_hash, now,
            )
            provider_id = row["id"]

        else:  # towing_provider
            existing = await conn.fetchrow(
                "SELECT id FROM towing_providers WHERE phone = $1", body.phone
            )
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": True, "code": "PHONE_TAKEN",
                            "message": "A towing provider account with this phone already exists",
                            "status_code": 409},
                )

            service_area_ids = list(dict.fromkeys((body.service_area_ids or [])[:20]))
            row = await conn.fetchrow(
                """
                INSERT INTO towing_providers
                    (full_name, phone, location, latitude, longitude,
                     service_area_ids, password_hash, is_verified, rating,
                     total_ratings, jobs_completed, is_available, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,0.0,0,0,FALSE,$8)
                RETURNING id
                """,
                body.full_name, body.phone, body.location,
                body.latitude, body.longitude, service_area_ids,
                password_hash, now,
            )
            provider_id = row["id"]

        await log_event(
            conn,
            event_type="provider_registered",
            mechanic_id=provider_id,
            description=f"{body.provider_type} registered: {body.phone}",
        )

    return SuccessResponse(
        message="Registration successful. Your account is pending admin verification."
    )


# ── POST /auth/login/provider ──────────────────────────────────────────────────

@router.post(
    "/login/provider",
    response_model=ProviderLoginResponse,
    status_code=status.HTTP_200_OK,
    summary="Provider login (mechanic or towing provider)",
)
async def login_provider(body: ProviderLoginRequest, request: Request, response: Response):
    """
    Authenticates a mechanic or towing provider by phone + password.
    Searches mechanics table first, then towing_providers.
    Returns a JWT and provider profile on success.
    """
    pool = await _get_conn(request)

    async with pool.acquire() as conn:
        import re as _re
        identifier = body.identifier.strip()

        if not identifier.upper().startswith("SPN"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": True, "code": "INVALID_IDENTIFIER",
                        "message": "Use your Service Provider ID (e.g. SPN-0042) to sign in.",
                        "status_code": 401},
            )

        # Normalise: extract the numeric part so SPN-0042, SPN042, SPN-42 all resolve to 42
        _digits = _re.sub(r'[^0-9]', '', identifier)
        spn_int = int(_digits) if _digits else -1

        await check_rate_limit(
            conn, f"login:SPN:{spn_int}", max_attempts=5, window_seconds=900,
            message="Too many failed login attempts. Please wait 15 minutes before trying again.",
        )

        provider_row = await conn.fetchrow(
            """
            SELECT id, full_name, phone, COALESCE(spn,'') AS spn,
                   specialty, provider_type, location,
                   rating, jobs_completed, password_hash, is_verified,
                   COALESCE(password_changed, FALSE) AS password_changed
            FROM mechanics
            WHERE NULLIF(REGEXP_REPLACE(spn, '[^0-9]', '', 'g'), '')::integer = $1
            """,
            spn_int,
        )
        if not provider_row:
            provider_row = await conn.fetchrow(
                """
                SELECT id, full_name, phone, COALESCE(spn,'') AS spn,
                       NULL AS specialty, 'towing_provider' AS provider_type, location,
                       rating, jobs_completed, password_hash, is_verified,
                       COALESCE(password_changed, FALSE) AS password_changed
                FROM towing_providers
                WHERE NULLIF(REGEXP_REPLACE(spn, '[^0-9]', '', 'g'), '')::integer = $1
                """,
                spn_int,
            )

        if not provider_row:
            await record_attempt(conn, f"login:{identifier.upper()}")
            await log_event(
                conn,
                event_type="provider_login_failed",
                description=f"Login attempt for unknown SPN: {identifier}",
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": True, "code": "INVALID_CREDENTIALS",
                        "message": "Invalid SPN or password.",
                        "status_code": 401},
            )

        provider = dict(provider_row)

        if not _verify_password(body.password, provider["password_hash"]):
            await record_attempt(conn, f"login:{identifier.upper()}")
            await log_event(
                conn,
                event_type="provider_login_failed",
                mechanic_id=provider["id"],
                description=f"Wrong password for identifier: {identifier}",
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": True, "code": "INVALID_CREDENTIALS",
                        "message": "Invalid SPN or password.", "status_code": 401},
            )

        if not provider["is_verified"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": True, "code": "ACCOUNT_PENDING",
                        "message": "Your account is awaiting admin verification",
                        "status_code": 403},
            )

        role = provider["provider_type"]
        token = create_access_token(
            data={"sub": str(provider["id"]), "phone": provider["phone"]},
            role=role,
        )

        await log_event(
            conn,
            event_type="provider_login",
            mechanic_id=provider["id"],
            description=f"{role} logged in via SPN: {identifier}",
        )

    cookie_max_age = int(os.getenv("ACCESS_TOKEN_EXPIRE_SECONDS", 60 * 60 * 24))
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=os.getenv("ENV", "development") == "production",
        samesite="lax",
        max_age=cookie_max_age,
        path="/",
    )

    specialty_str = provider.get("specialty") or ""
    specializations = [s.strip() for s in specialty_str.split(",") if s.strip()]

    return ProviderLoginResponse(
        access_token=token,
        provider=ProviderOut(
            id=str(provider["id"]),
            full_name=provider["full_name"],
            phone=provider["phone"],
            spn=provider.get("spn") or None,
            specialty=provider.get("specialty"),
            provider_type=provider["provider_type"],
            rating=provider["rating"],
            jobs_completed=provider["jobs_completed"],
            is_verified=provider["is_verified"],
            verification_status="approved" if provider["is_verified"] else "pending",
            service_area=provider.get("location"),
            specializations=specializations,
            password_changed=bool(provider.get("password_changed", False)),
        ),
    )


# ── PATCH /auth/provider/me/availability ──────────────────────────────────────

@router.patch(
    "/provider/me/availability",
    status_code=status.HTTP_200_OK,
    summary="Toggle provider online/offline availability",
)
async def update_provider_availability(
    request: Request,
    authorization: Optional[str] = Header(None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "UNAUTHORIZED",
                    "message": "No token provided", "status_code": 401},
        )

    token = authorization[7:]
    try:
        payload = decode_token(token)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": str(exc),
                    "message": "Token expired or invalid", "status_code": 401},
        )

    try:
        provider_id = int(payload.get("sub", 0))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "TOKEN_INVALID",
                    "message": "Token payload invalid", "status_code": 401},
        )

    body = await request.json()
    is_available = bool(body.get("is_available", False))
    role = payload.get("role", "mechanic")

    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        if role == "towing_provider":
            row = await conn.fetchrow(
                "UPDATE towing_providers SET is_available=$1 WHERE id=$2 RETURNING id, is_available",
                is_available, provider_id,
            )
        else:
            row = await conn.fetchrow(
                "UPDATE mechanics SET is_available=$1 WHERE id=$2 RETURNING id, is_available",
                is_available, provider_id,
            )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": True, "code": "NOT_FOUND",
                    "message": "Provider not found", "status_code": 404},
        )

    return {"id": row["id"], "is_available": row["is_available"]}


# ── PATCH /auth/provider/me/location ─────────────────────────────────────────

@router.patch(
    "/provider/me/location",
    status_code=status.HTTP_200_OK,
    summary="Update provider GPS location",
)
async def update_provider_location(
    request: Request,
    authorization: Optional[str] = Header(None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "UNAUTHORIZED",
                    "message": "No token provided", "status_code": 401},
        )

    token = authorization[7:]
    try:
        payload = decode_token(token)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": str(exc),
                    "message": "Token expired or invalid", "status_code": 401},
        )

    try:
        provider_id = int(payload.get("sub", 0))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "TOKEN_INVALID",
                    "message": "Token payload invalid", "status_code": 401},
        )

    body = await request.json()
    latitude  = body.get("latitude")
    longitude = body.get("longitude")
    location  = body.get("location") or (f"{latitude},{longitude}" if latitude and longitude else None)

    if latitude is None or longitude is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": True, "code": "MISSING_COORDS",
                    "message": "latitude and longitude are required", "status_code": 422},
        )

    role = payload.get("role", "mechanic")
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        if role == "towing_provider":
            row = await conn.fetchrow(
                "UPDATE towing_providers SET latitude=$1, longitude=$2, location=$3 WHERE id=$4 RETURNING id",
                float(latitude), float(longitude), location, provider_id,
            )
        else:
            row = await conn.fetchrow(
                "UPDATE mechanics SET latitude=$1, longitude=$2, location=$3 WHERE id=$4 RETURNING id",
                float(latitude), float(longitude), location, provider_id,
            )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": True, "code": "NOT_FOUND",
                    "message": "Provider not found", "status_code": 404},
        )

    return {"id": row["id"], "latitude": latitude, "longitude": longitude, "location": location}


# ── GET /auth/me/provider ──────────────────────────────────────────────────────

@router.get(
    "/me/provider",
    response_model=ProviderOut,
    status_code=status.HTTP_200_OK,
    summary="Get current provider profile from token",
)
async def me_provider(request: Request, authorization: Optional[str] = Header(None)):
    """
    Returns the authenticated provider's profile.
    Used by the frontend on app mount / page refresh to restore session.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "UNAUTHORIZED",
                    "message": "No token provided", "status_code": 401},
        )

    token = authorization[7:]
    try:
        payload = decode_token(token)
    except RuntimeError as exc:
        code = str(exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": code,
                    "message": "Token expired or invalid", "status_code": 401},
        )

    try:
        provider_id = int(payload.get("sub", 0))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "TOKEN_INVALID",
                    "message": "Token payload invalid", "status_code": 401},
        )

    role = payload.get("role", "")
    pool = await _get_conn(request)

    async with pool.acquire() as conn:
        if role == "towing_provider":
            row = await conn.fetchrow(
                """
                SELECT id, full_name, phone, COALESCE(spn,'') AS spn,
                       NULL AS specialty, 'towing_provider' AS provider_type, location,
                       is_verified, rating, jobs_completed,
                       COALESCE(password_changed, FALSE) AS password_changed
                FROM towing_providers WHERE id = $1
                """,
                provider_id,
            )
        else:
            row = await conn.fetchrow(
                """
                SELECT id, full_name, phone, COALESCE(spn,'') AS spn,
                       specialty, provider_type, location,
                       is_verified, rating, jobs_completed,
                       COALESCE(password_changed, FALSE) AS password_changed
                FROM mechanics WHERE id = $1
                """,
                provider_id,
            )

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": True, "code": "NOT_FOUND",
                    "message": "Provider not found", "status_code": 404},
        )

    provider = dict(row)
    specialty_str = provider.get("specialty") or ""
    specializations = [s.strip() for s in specialty_str.split(",") if s.strip()]

    return ProviderOut(
        id=str(provider["id"]),
        full_name=provider["full_name"],
        phone=provider["phone"],
        spn=provider.get("spn") or None,
        specialty=provider.get("specialty"),
        provider_type=provider["provider_type"],
        rating=provider["rating"],
        jobs_completed=provider["jobs_completed"],
        is_verified=provider["is_verified"],
        verification_status="approved" if provider["is_verified"] else "pending",
        service_area=provider.get("location"),
        specializations=specializations,
        password_changed=bool(provider.get("password_changed", False)),
    )


# ── POST /auth/provider/phone-otp ─────────────────────────────────────────────

class ProviderPhoneOTPRequest(BaseModel):
    phone: str


@router.post(
    "/provider/phone-otp",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Send OTP to a registered provider's phone (fallback login)",
)
async def provider_phone_otp(body: ProviderPhoneOTPRequest, request: Request):
    """
    Fallback login step 1: verify the phone belongs to a registered, verified provider,
    then send a one-time code via SMS. Unregistered numbers are rejected immediately.
    """
    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    async with pool.acquire() as conn:
        await check_rate_limit(
            conn, f"otp:{phone}", max_attempts=10, window_seconds=600,
            message="Too many OTP requests for this number. Please wait before trying again.",
        )

        row = await conn.fetchrow(
            "SELECT id FROM mechanics WHERE phone = $1 AND is_verified = TRUE", phone
        )
        if not row:
            row = await conn.fetchrow(
                "SELECT id FROM towing_providers WHERE phone = $1 AND is_verified = TRUE", phone
            )

        if not row:
            pending = await conn.fetchrow(
                "SELECT id FROM mechanics WHERE phone = $1", phone
            ) or await conn.fetchrow(
                "SELECT id FROM towing_providers WHERE phone = $1", phone
            )
            if pending:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={"error": True, "code": "ACCOUNT_PENDING",
                            "message": "Your account is still awaiting admin verification.",
                            "status_code": 403},
                )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": True, "code": "PHONE_NOT_FOUND",
                        "message": "No registered provider account found for this phone number.",
                        "status_code": 404},
            )

        otp = generate_otp()
        await store_otp(conn, phone, otp)
        await record_attempt(conn, f"otp:{phone}")
        await log_event(conn, event_type="provider_login",
                        mechanic_id=row["id"],
                        description=f"Phone OTP requested for {phone}")

    return SuccessResponse(message=f"Your OTP is: {otp}")


# ── POST /auth/provider/verify-phone-otp ──────────────────────────────────────

class ProviderVerifyPhoneOTPRequest(BaseModel):
    phone: str
    otp_code: str


@router.post(
    "/provider/verify-phone-otp",
    response_model=ProviderLoginResponse,
    status_code=status.HTTP_200_OK,
    summary="Verify OTP and complete provider phone-based login",
)
async def provider_verify_phone_otp(
    body: ProviderVerifyPhoneOTPRequest,
    request: Request,
    response: Response,
):
    """
    Fallback login step 2: validate the OTP and issue a JWT, identical to a normal SPN login.
    """
    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    _OTP_ERRORS = {
        "OTP_NOT_FOUND":    (404, "OTP not found — request a new one"),
        "OTP_EXPIRED":      (410, "OTP has expired — request a new one"),
        "OTP_MAX_ATTEMPTS": (429, "Too many incorrect attempts — request a new OTP"),
        "INVALID_OTP":      (400, "Incorrect OTP"),
    }

    async with pool.acquire() as conn:
        try:
            await verify_otp(conn, phone, body.otp_code)
        except RuntimeError as exc:
            code = str(exc)
            http_status, message = _OTP_ERRORS.get(code, (400, "OTP verification failed"))
            raise HTTPException(
                status_code=http_status,
                detail={"error": True, "code": code,
                        "message": message, "status_code": http_status},
            )

        row = await conn.fetchrow(
            """
            SELECT id, full_name, phone, COALESCE(spn,'') AS spn,
                   specialty, provider_type, location,
                   is_verified, rating, jobs_completed,
                   COALESCE(password_changed, FALSE) AS password_changed
            FROM mechanics WHERE phone = $1
            """,
            phone,
        )
        if not row:
            row = await conn.fetchrow(
                """
                SELECT id, full_name, phone, COALESCE(spn,'') AS spn,
                       NULL AS specialty, 'towing_provider' AS provider_type, location,
                       is_verified, rating, jobs_completed,
                       COALESCE(password_changed, FALSE) AS password_changed
                FROM towing_providers WHERE phone = $1
                """,
                phone,
            )

        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": True, "code": "NOT_FOUND",
                        "message": "Provider not found", "status_code": 404},
            )

        provider = dict(row)
        role  = provider["provider_type"]
        token = create_access_token(
            data={"sub": str(provider["id"]), "phone": phone},
            role=role,
        )

        await log_event(conn, event_type="provider_login",
                        mechanic_id=provider["id"],
                        description=f"{role} {phone} authenticated via phone OTP")

    cookie_max_age = int(os.getenv("ACCESS_TOKEN_EXPIRE_SECONDS", 60 * 60 * 24))
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=os.getenv("ENV", "development") == "production",
        samesite="lax",
        max_age=cookie_max_age,
        path="/",
    )

    specialty_str = provider.get("specialty") or ""
    specializations = [s.strip() for s in specialty_str.split(",") if s.strip()]

    return ProviderLoginResponse(
        access_token=token,
        provider=ProviderOut(
            id=str(provider["id"]),
            full_name=provider["full_name"],
            phone=provider["phone"],
            spn=provider.get("spn") or None,
            specialty=provider.get("specialty"),
            provider_type=provider["provider_type"],
            rating=provider["rating"],
            jobs_completed=provider["jobs_completed"],
            is_verified=provider["is_verified"],
            verification_status="approved" if provider["is_verified"] else "pending",
            service_area=provider.get("location"),
            specializations=specializations,
            password_changed=bool(provider.get("password_changed", False)),
        ),
    )


# ── PATCH /auth/provider/me/password ──────────────────────────────────────────

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.patch(
    "/provider/me/password",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Change provider password (forced on first login, voluntary thereafter)",
)
async def change_provider_password(
    body: ChangePasswordRequest,
    request: Request,
    authorization: Optional[str] = Header(None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "UNAUTHORIZED",
                    "message": "No token provided", "status_code": 401},
        )

    token = authorization[7:]
    try:
        payload = decode_token(token)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": str(exc),
                    "message": "Token expired or invalid", "status_code": 401},
        )

    try:
        provider_id = int(payload.get("sub", 0))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "TOKEN_INVALID",
                    "message": "Token payload invalid", "status_code": 401},
        )

    if len(body.new_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": True, "code": "PASSWORD_TOO_SHORT",
                    "message": "New password must be at least 8 characters", "status_code": 422},
        )

    role = payload.get("role", "mechanic")
    pool = await _get_conn(request)

    async with pool.acquire() as conn:
        if role == "towing_provider":
            row = await conn.fetchrow(
                "SELECT id, password_hash FROM towing_providers WHERE id = $1", provider_id
            )
        else:
            row = await conn.fetchrow(
                "SELECT id, password_hash FROM mechanics WHERE id = $1", provider_id
            )

        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": True, "code": "NOT_FOUND",
                        "message": "Provider not found", "status_code": 404},
            )

        if not _verify_password(body.current_password, row["password_hash"]):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": True, "code": "WRONG_PASSWORD",
                        "message": "Current password is incorrect", "status_code": 401},
            )

        new_hash = _hash_password(body.new_password)

        if role == "towing_provider":
            await conn.execute(
                "UPDATE towing_providers SET password_hash = $1, password_changed = TRUE WHERE id = $2",
                new_hash, provider_id,
            )
        else:
            await conn.execute(
                "UPDATE mechanics SET password_hash = $1, password_changed = TRUE WHERE id = $2",
                new_hash, provider_id,
            )

        await log_event(conn, event_type="password_changed", mechanic_id=provider_id,
                        description=f"{role} {provider_id} changed their password")

    return SuccessResponse(message="Password changed successfully.")


# ── POST /auth/provider/reset-password-otp ────────────────────────────────────

class ResetPasswordOTPRequest(BaseModel):
    phone: str


@router.post(
    "/provider/reset-password-otp",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Send OTP to verify identity before resetting password",
)
async def reset_password_otp(body: ResetPasswordOTPRequest, request: Request):
    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    async with pool.acquire() as conn:
        await check_rate_limit(
            conn, f"otp:{phone}", max_attempts=10, window_seconds=600,
            message="Too many OTP requests for this number. Please wait before trying again.",
        )

        row = await conn.fetchrow(
            "SELECT id FROM mechanics WHERE phone = $1 AND is_verified = TRUE", phone
        )
        if not row:
            row = await conn.fetchrow(
                "SELECT id FROM towing_providers WHERE phone = $1 AND is_verified = TRUE", phone
            )

        if not row:
            pending = await conn.fetchrow(
                "SELECT id FROM mechanics WHERE phone = $1", phone
            ) or await conn.fetchrow(
                "SELECT id FROM towing_providers WHERE phone = $1", phone
            )
            if pending:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={"error": True, "code": "ACCOUNT_PENDING",
                            "message": "Your account is still awaiting admin verification.",
                            "status_code": 403},
                )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": True, "code": "PHONE_NOT_FOUND",
                        "message": "No registered provider account found for this phone number.",
                        "status_code": 404},
            )

        otp = generate_otp()
        await store_otp(conn, phone, otp)
        await record_attempt(conn, f"otp:{phone}")
        await log_event(conn, event_type="password_reset_requested",
                        mechanic_id=row["id"],
                        description=f"Password reset OTP requested for {phone}")

    return SuccessResponse(message=f"Your reset code is: {otp}")


# ── POST /auth/provider/confirm-reset-password ────────────────────────────────

class ConfirmResetPasswordRequest(BaseModel):
    phone: str
    otp_code: str
    new_password: str


@router.post(
    "/provider/confirm-reset-password",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Verify OTP and set a new password",
)
async def confirm_reset_password(body: ConfirmResetPasswordRequest, request: Request):
    if len(body.new_password) < 8:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": True, "code": "PASSWORD_TOO_SHORT",
                    "message": "New password must be at least 8 characters", "status_code": 422},
        )

    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    _OTP_ERRORS = {
        "OTP_NOT_FOUND":    (404, "OTP not found — request a new one"),
        "OTP_EXPIRED":      (410, "OTP has expired — request a new one"),
        "OTP_MAX_ATTEMPTS": (429, "Too many incorrect attempts — request a new OTP"),
        "INVALID_OTP":      (400, "Incorrect OTP"),
    }

    async with pool.acquire() as conn:
        try:
            await verify_otp(conn, phone, body.otp_code)
        except RuntimeError as exc:
            code = str(exc)
            http_status, message = _OTP_ERRORS.get(code, (400, "OTP verification failed"))
            raise HTTPException(
                status_code=http_status,
                detail={"error": True, "code": code,
                        "message": message, "status_code": http_status},
            )

        new_hash = _hash_password(body.new_password)

        # Try mechanics first, then towing_providers
        result = await conn.execute(
            "UPDATE mechanics SET password_hash = $1, password_changed = TRUE WHERE phone = $2",
            new_hash, phone,
        )
        if result == "UPDATE 0":
            await conn.execute(
                "UPDATE towing_providers SET password_hash = $1, password_changed = TRUE WHERE phone = $2",
                new_hash, phone,
            )

        await log_event(conn, event_type="password_reset_completed",
                        description=f"Password reset completed for {phone}")

    return SuccessResponse(message="Password reset successfully. You can now log in with your new password.")


# ── GET /auth/me/notifications ────────────────────────────────────────────────
# Lazy dispatch-DB pool (service_requests, payments, reviews live there)

_dispatch_pool: Optional[asyncpg.Pool] = None


async def _get_dispatch_pool() -> Optional[asyncpg.Pool]:
    global _dispatch_pool
    if _dispatch_pool is not None:
        return _dispatch_pool
    url = os.getenv("DISPATCH_DATABASE_URL")
    if not url:
        return None
    try:
        _dispatch_pool = await asyncpg.create_pool(url, min_size=1, max_size=5)
        logger.info("✅ Dispatch DB pool ready (notifications)")
    except Exception as exc:
        logger.warning("⚠️  Dispatch DB pool failed (notifications will be partial): %s", exc)
    return _dispatch_pool


@router.get(
    "/me/notifications",
    status_code=status.HTTP_200_OK,
    summary="Get in-app notifications for the authenticated provider",
)
async def me_notifications(
    request: Request,
    authorization: Optional[str] = Header(None),
    limit: int = 30,
):
    """
    Returns a feed of context-specific in-app notifications for the mechanic
    or towing provider: job assignments, payments, reviews, account events.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "UNAUTHORIZED",
                    "message": "Not authenticated", "status_code": 401},
        )
    token = authorization[7:]
    try:
        payload = decode_token(token)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": str(exc),
                    "message": "Token expired or invalid", "status_code": 401},
        )

    try:
        provider_id = int(payload.get("sub", 0))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "TOKEN_INVALID",
                    "message": "Token payload invalid", "status_code": 401},
        )

    role = payload.get("role", "mechanic")
    phone = payload.get("phone", "")
    events: list = []

    # ── Auth DB: account & application events ──────────────────────
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        # Verification status
        try:
            if role == "towing_provider":
                m_row = await conn.fetchrow(
                    "SELECT id, is_verified, created_at FROM towing_providers WHERE id = $1",
                    provider_id,
                )
            else:
                m_row = await conn.fetchrow(
                    "SELECT id, is_verified, created_at FROM mechanics WHERE id = $1",
                    provider_id,
                )
            if m_row and m_row["is_verified"]:
                events.append({
                    "id": f"verified-{provider_id}",
                    "type": "account",
                    "title": "Account Verified",
                    "message": "Your account has been verified. You can now receive job requests.",
                    "created_at": m_row["created_at"].isoformat(),
                    "is_read": False,
                    "data": {},
                })
        except Exception:
            pass

        # Provider application events
        try:
            app_rows = await conn.fetch(
                """SELECT id, verification_status, submitted_at, reviewed_at
                   FROM provider_applications WHERE phone = $1
                   ORDER BY submitted_at DESC LIMIT 3""",
                phone,
            )
            for app in app_rows:
                vstatus = app["verification_status"]
                ts = app["reviewed_at"] or app["submitted_at"]
                if vstatus == "approved":
                    events.append({
                        "id": f"app-approved-{app['id']}",
                        "type": "account",
                        "title": "Application Approved",
                        "message": "Your provider application has been approved. Welcome to the MOTOFIX network!",
                        "created_at": ts.isoformat() if ts else datetime.utcnow().isoformat(),
                        "is_read": False,
                        "data": {"application_id": app["id"]},
                    })
                elif vstatus == "rejected":
                    events.append({
                        "id": f"app-rejected-{app['id']}",
                        "type": "account",
                        "title": "Application Not Approved",
                        "message": "Your application was reviewed and was not approved. Contact support for more information.",
                        "created_at": ts.isoformat() if ts else datetime.utcnow().isoformat(),
                        "is_read": False,
                        "data": {"application_id": app["id"]},
                    })
                else:
                    events.append({
                        "id": f"app-pending-{app['id']}",
                        "type": "account",
                        "title": "Application Under Review",
                        "message": "Your provider application has been received and is currently under review.",
                        "created_at": app["submitted_at"].isoformat() if app["submitted_at"] else datetime.utcnow().isoformat(),
                        "is_read": False,
                        "data": {"application_id": app["id"]},
                    })
        except Exception:
            pass

    # ── Dispatch DB: jobs, payments, reviews ────────────────────────
    dispatch_pool = await _get_dispatch_pool()
    if dispatch_pool:
        try:
            async with dispatch_pool.acquire() as dconn:
                # Jobs assigned to this mechanic
                try:
                    rows = await dconn.fetch(
                        """SELECT id, customer_name, service_type, location, status,
                                  created_at, accepted_at, completed_at
                           FROM service_requests
                           WHERE mechanic_id = $1
                           ORDER BY created_at DESC
                           LIMIT 15""",
                        provider_id,
                    )
                    for r in rows:
                        cname = r["customer_name"] or "A driver"
                        stype = (r["service_type"] or "service").lower()
                        loc   = await _geocode_location(r["location"] or "")
                        st    = r["status"] or "accepted"

                        if st == "completed":
                            ntype = "job_completed"
                            title = "Job Completed"
                            msg   = f"You successfully completed a {stype} job for {cname}."
                            ts    = r["completed_at"] or r["created_at"]
                        else:
                            ntype = "new_job"
                            title = "Job Assigned"
                            msg   = f"You have been assigned a {stype} request from {cname} near {loc}."
                            ts    = r["accepted_at"] or r["created_at"]

                        events.append({
                            "id":         f"req-{r['id']}",
                            "type":       ntype,
                            "title":      title,
                            "message":    msg,
                            "created_at": ts.isoformat() if ts else datetime.utcnow().isoformat(),
                            "is_read":    False,
                            "data":       {"request_id": r["id"], "status": st},
                        })
                except Exception:
                    pass

                # Payments for this mechanic
                try:
                    rows = await dconn.fetch(
                        """SELECT p.id, p.request_id, p.mechanic_payout,
                                  p.disbursement_status, p.created_at,
                                  sr.service_type, sr.customer_name
                           FROM payments p
                           LEFT JOIN service_requests sr ON p.request_id = sr.id
                           WHERE p.mechanic_id = $1
                           ORDER BY p.created_at DESC
                           LIMIT 10""",
                        provider_id,
                    )
                    for r in rows:
                        payout  = int(r["mechanic_payout"] or 0)
                        stype   = (r["service_type"] or "service").lower()
                        dstatus = r["disbursement_status"] or "pending"

                        if dstatus == "success":
                            title = "Payment Received"
                            msg   = f"UGX {payout:,} has been sent to your mobile money for the {stype} job."
                        else:
                            title = "Payment Initiated"
                            msg   = f"UGX {payout:,} for the {stype} job is being processed to your mobile money."

                        events.append({
                            "id":         f"pay-{r['id']}",
                            "type":       "payment",
                            "title":      title,
                            "message":    msg,
                            "created_at": r["created_at"].isoformat(),
                            "is_read":    False,
                            "data":       {"request_id": r["request_id"], "amount": payout},
                        })
                except Exception:
                    pass

                # Reviews left for this mechanic
                try:
                    rows = await dconn.fetch(
                        """SELECT r.id, r.rating, r.comment, r.created_at,
                                  sr.service_type, sr.customer_name
                           FROM reviews r
                           LEFT JOIN service_requests sr ON r.request_id = sr.id
                           WHERE r.mechanic_id = $1
                           ORDER BY r.created_at DESC
                           LIMIT 10""",
                        provider_id,
                    )
                    for r in rows:
                        rating  = r["rating"] or 0
                        cname   = r["customer_name"] or "A driver"
                        stype   = (r["service_type"] or "service").lower()
                        comment = r["comment"] or ""
                        msg     = f"{cname} rated your {stype} job {rating}/5."
                        if comment:
                            msg += f' "{comment[:80]}"'

                        events.append({
                            "id":         f"rev-{r['id']}",
                            "type":       "review",
                            "title":      f"New Review — {rating}/5 stars",
                            "message":    msg,
                            "created_at": r["created_at"].isoformat(),
                            "is_read":    False,
                            "data":       {"rating": rating},
                        })
                except Exception:
                    pass
        except Exception:
            pass

    events.sort(key=lambda x: x["created_at"], reverse=True)
    return events[:limit]
