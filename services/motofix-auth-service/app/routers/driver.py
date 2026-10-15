# app/routers/driver.py
# Driver (boda-boda / customer) registration and OTP-based login.

import logging
import re
from typing import Optional
import base64
import difflib
import json
import os

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
import bcrypt

# Ugandan number plates come in several shapes — accept them all, not just the
# classic private format (UAA 111A):
#   • Private / standard:    UAA 123A   (U + 2 letters · 3 digits · 1 letter)
#   • New digital / tracked: UA 123BG   (2 letters · 3 digits · 2 letters)
#   • Government:            UG 1234W
#   • Diplomatic / special:  CD 123A, UP 1234, UN 123A, etc.
# Permissive enough for every category, strict enough to reject nonsense.
_PLATE_RE = re.compile(r'^[A-Z]{1,3}\d{2,4}[A-Z]{0,3}$')

def _is_valid_plate(raw: Optional[str]) -> bool:
    s = re.sub(r'[^A-Z0-9]', '', (raw or '').upper())
    return 5 <= len(s) <= 8 and bool(_PLATE_RE.match(s))

from app.schemas.driver import (
    DriverRegisterRequest,
    OTPVerifyRequest,
    DriverLoginResponse,
    DriverOut,
    PhoneRequest,
)
from app.schemas.common import SuccessResponse
from app.services.otp import generate_otp, get_recent_otp, store_otp, verify_otp
from app.services.sms import send_sms, format_phone
from app.services.logger import log_event
from app.services.rate_limit import check_rate_limit, record_attempt
from app.services.token import create_access_token, decode_token, blacklist_token
from app.middleware.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Driver Auth"])


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


# ── POST /auth/register/driver ─────────────────────────────────────────────────

@router.post(
    "/register/driver",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Register driver and send OTP",
)
async def register_driver(body: DriverRegisterRequest, request: Request, background_tasks: BackgroundTasks):
    """
    Accepts phone + full_name.
    Generates a 6-digit OTP, stores it in DB, and delivers it via SMS.
    The driver then calls /auth/verify-otp to complete login.
    """
    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    otp = generate_otp()

    async with pool.acquire() as conn:
        await check_rate_limit(
            conn, f"otp:{phone}", max_attempts=10, window_seconds=600,
            message="Too many OTP requests for this number. Please wait before trying again.",
        )

        # If the app is retrying (a sleeping server answered slowly the first time), the
        # code from the first attempt is still valid: re-send that SAME code instead of
        # replacing it, so the SMS the user already received keeps working.
        reused_otp = await get_recent_otp(conn, phone)
        if reused_otp:
            otp = reused_otp

        # New users must provide full_name and number_plate; returning users just need phone
        existing = await conn.fetchrow("SELECT id FROM users WHERE phone = $1", phone)
        if not existing and (not body.full_name or not body.number_plate):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"error": True, "code": "MISSING_FIELDS",
                        "message": "Full name and number plate are required to create an account.",
                        "status_code": 422},
            )

        plate = None
        if body.number_plate:
            plate = body.number_plate.upper().strip()
            if not _is_valid_plate(plate):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"error": True, "code": "INVALID_NUMBER_PLATE",
                            "message": "Enter a valid Ugandan number plate (e.g. UAA 111A or UA 123BG).",
                            "status_code": 422},
                )

        if existing:
            # Returning driver — already a confirmed account. Apply any updated
            # details immediately; this is just a login OTP, not a new signup.
            if body.full_name or plate:
                await conn.execute(
                    """
                    UPDATE users
                       SET full_name    = COALESCE($2, full_name),
                           number_plate = COALESCE($3, number_plate)
                     WHERE phone = $1
                    """,
                    phone, body.full_name or None, plate,
                )
            if not reused_otp:
                await store_otp(conn, phone, otp)
        else:
            # NEW driver — DO NOT create the users row yet. The account is only
            # created once the OTP confirms the phone number (in verify-otp), so
            # unverified signups never appear in the admin Drivers list.
            if not reused_otp:
                await store_otp(
                    conn, phone, otp,
                    pending_full_name=body.full_name,
                    pending_number_plate=plate,
                )

        await record_attempt(conn, f"otp:{phone}")

        await log_event(
            conn,
            event_type="otp_sent",
            description=f"OTP sent to {phone}"
                        + ("" if existing else " (pending new-driver registration)"),
        )

    logger.info("Generated and stored driver OTP for phone ending %s; queueing SMS delivery", phone[-4:])
    # Deliver the SMS in the background so the response returns immediately and the
    # blocking Africa's Talking HTTP call never stalls the event loop. The OTP is
    # already persisted; if delivery fails the user can resend.
    background_tasks.add_task(
        send_sms, phone, f"MOTOFIX: Your verification code is {otp}. It expires in 5 minutes."
    )
    return SuccessResponse(message="OTP sent to your phone number.")


# ── POST /auth/verify-otp ──────────────────────────────────────────────────────

@router.post(
    "/verify-otp",
    response_model=DriverLoginResponse,
    status_code=status.HTTP_200_OK,
    summary="Verify OTP and receive JWT",
)
async def verify_driver_otp(body: OTPVerifyRequest, request: Request, response: Response):
    """
    Validates the OTP for the given phone number.
    On success returns an access token and the driver's profile.
    """
    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    async with pool.acquire() as conn:
        # Read any pending new-driver details BEFORE verify_otp consumes the row.
        pending = await conn.fetchrow(
            "SELECT pending_full_name, pending_number_plate FROM otp_store WHERE phone = $1",
            phone,
        )

        # Verify OTP — raises RuntimeError on failure
        try:
            await verify_otp(conn, phone, body.otp_code)
        except RuntimeError as exc:
            code = str(exc)
            await log_event(
                conn,
                event_type="otp_failed",
                description=f"OTP verification failed for {phone}: {code}",
            )
            _OTP_ERRORS = {
                "OTP_NOT_FOUND":   (404, "OTP not found — request a new one"),
                "OTP_EXPIRED":     (410, "OTP has expired — request a new one"),
                "OTP_MAX_ATTEMPTS":(429, "Too many incorrect attempts — request a new OTP"),
                "INVALID_OTP":     (400, "Incorrect OTP"),
            }
            http_status, message = _OTP_ERRORS.get(code, (400, "OTP verification failed"))
            raise HTTPException(
                status_code=http_status,
                detail={"error": True, "code": code, "message": message, "status_code": http_status},
            )

        # Fetch user. For a NEW driver the row doesn't exist yet — create it now
        # that the phone number is confirmed, using the data stashed at register.
        row = await conn.fetchrow(
            "SELECT id, phone, full_name, role, number_plate FROM users WHERE phone = $1",
            phone,
        )
        if not row:
            if not pending or not pending["pending_full_name"] or not pending["pending_number_plate"]:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={"error": True, "code": "USER_NOT_FOUND",
                            "message": "No pending registration found — please sign up again.",
                            "status_code": 404},
                )
            row = await conn.fetchrow(
                """
                INSERT INTO users (phone, full_name, number_plate, role)
                VALUES ($1, $2, $3, 'driver')
                ON CONFLICT (phone) DO UPDATE
                    SET full_name    = COALESCE(EXCLUDED.full_name,    users.full_name),
                        number_plate = COALESCE(EXCLUDED.number_plate, users.number_plate)
                RETURNING id, phone, full_name, role, number_plate
                """,
                phone, pending["pending_full_name"], pending["pending_number_plate"],
            )
            await log_event(
                conn,
                event_type="user_registered",
                user_id=row["id"],
                description=f"Driver account created after OTP verification: {phone}",
            )

        user = dict(row)
        token = create_access_token(
            data={"sub": str(user["id"]), "phone": phone},
            role=user["role"],
        )

        await log_event(
            conn,
            event_type="otp_verified",
            user_id=user["id"],
            description=f"Driver {phone} authenticated via OTP",
        )

    # Set httpOnly cookie
    import os
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

    return DriverLoginResponse(
        access_token=token,
        user=DriverOut(**user),
    )


# ── GET /auth/me ───────────────────────────────────────────────────────────────

@router.get(
    "/me",
    status_code=status.HTTP_200_OK,
    summary="Get current driver profile",
)
async def get_me(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Return the authenticated driver's profile from the database."""
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, phone, full_name, number_plate, role FROM users WHERE id = $1",
            int(user["sub"]),
        )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": True, "code": "USER_NOT_FOUND",
                    "message": "User not found", "status_code": 404},
        )
    return dict(row)


# ── POST /auth/logout ──────────────────────────────────────────────────────────

@router.post(
    "/logout",
    status_code=status.HTTP_200_OK,
    summary="Logout and invalidate token",
)
async def logout(request: Request, response: Response):
    """Blacklist the current token so it cannot be reused, then clear the cookie."""
    token = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
    if not token:
        token = request.cookies.get("access_token")

    if token:
        pool = await _get_conn(request)
        async with pool.acquire() as conn:
            await blacklist_token(conn, token)
            try:
                from jose import jwt as _jwt
                payload = _jwt.decode(
                    token,
                    os.getenv("SECRET_KEY"),
                    algorithms=[os.getenv("ALGORITHM", "HS256")],
                    options={"verify_exp": False},
                )
                user_id = int(payload.get("sub", 0)) or None
            except Exception:
                user_id = None
            await log_event(conn, event_type="user_logout", user_id=user_id,
                            description="Driver logged out and token blacklisted")

    response.delete_cookie(key="access_token", path="/")
    return {"message": "Logged out successfully"}


# ── POST /auth/resend-otp ──────────────────────────────────────────────────────

@router.post(
    "/resend-otp",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Resend OTP to an existing account",
)
async def resend_otp(body: PhoneRequest, request: Request, background_tasks: BackgroundTasks):
    """
    Generate and send a fresh OTP for an existing user.
    Invalidates any previous OTP for the same number.
    """
    phone = format_phone(body.phone)
    pool  = await _get_conn(request)

    async with pool.acquire() as conn:
        await check_rate_limit(
            conn, f"otp:{phone}", max_attempts=10, window_seconds=600,
            message="Too many OTP requests for this number. Please wait before trying again.",
        )

        row = await conn.fetchrow("SELECT id FROM users WHERE phone = $1", phone)
        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": True, "code": "USER_NOT_FOUND",
                        "message": "No account found for this number", "status_code": 404},
            )

        otp = generate_otp()
        await store_otp(conn, phone, otp)
        await record_attempt(conn, f"otp:{phone}")
        await log_event(conn, event_type="otp_resent",
                        description=f"OTP resent to {phone}")

    logger.info("Generated and stored replacement driver OTP for phone ending %s; queueing SMS delivery", phone[-4:])
    background_tasks.add_task(
        send_sms, phone, f"MOTOFIX: Your verification code is {otp}. It expires in 5 minutes."
    )
    return SuccessResponse(message="OTP sent to your phone number.")


# ── POST /auth/refresh-token ───────────────────────────────────────────────────

@router.post(
    "/refresh-token",
    status_code=status.HTTP_200_OK,
    summary="Exchange a valid token for a fresh one",
)
async def refresh_token(request: Request, response: Response):
    """
    Issues a new JWT and blacklists the old one.
    Works for drivers, providers, and admins — role is preserved from the original token.
    The token must not be expired.
    """
    token = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
    if not token:
        token = request.cookies.get("access_token")

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": "UNAUTHORIZED",
                    "message": "No token provided", "status_code": 401},
        )

    try:
        payload = decode_token(token)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": True, "code": str(exc),
                    "message": "Cannot refresh: token is expired or invalid", "status_code": 401},
        )

    role = payload.get("role", "driver")
    new_token = create_access_token(
        data={k: v for k, v in payload.items() if k not in ("exp", "iat")},
        role=role,
    )

    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        await blacklist_token(conn, token)
        user_id = int(payload.get("sub", 0)) or None
        await log_event(conn, event_type="token_refreshed", user_id=user_id,
                        description=f"Token refreshed for role={role}")

    cookie_max_age = int(os.getenv("ACCESS_TOKEN_EXPIRE_SECONDS", 60 * 60 * 24))
    response.set_cookie(
        key="access_token",
        value=new_token,
        httponly=True,
        secure=os.getenv("ENV", "development") == "production",
        samesite="lax",
        max_age=cookie_max_age,
        path="/",
    )

    return {"access_token": new_token, "token_type": "bearer"}


# ── POST /auth/verify-document ─────────────────────────────────────────────────

_ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_MODEL        = "claude-sonnet-4-6"
_ANTHROPIC_VERSION      = "2023-06-01"
_DOC_PROMPT = """You are an expert document verification AI specializing in Ugandan driving licences and permits.
Analyze this image and extract all visible information. Assess whether it appears genuine.
Return ONLY valid JSON — no markdown, no explanation — in exactly this structure:
{
  "is_genuine_document": true or false or null,
  "document_type": "driving_licence" or "permit" or "unknown",
  "confidence": 0.0 to 1.0,
  "extracted": {
    "name": string or null,
    "licence_number": string or null,
    "date_of_birth": "YYYY-MM-DD" or null,
    "issue_date": "YYYY-MM-DD" or null,
    "expiry_date": "YYYY-MM-DD" or null,
    "vehicle_categories": [],
    "issuing_authority": string or null
  },
  "tampering_detected": true or false,
  "tampering_indicators": [],
  "quality_issues": [],
  "flags": [],
  "summary": "one sentence summary of the verification result"
}"""


def _stub(reason: str, flag: str) -> dict:
    return {
        "is_genuine_document": None,
        "document_type": "unknown",
        "confidence": 0.0,
        "extracted": {
            "name": None, "licence_number": None, "date_of_birth": None,
            "issue_date": None, "expiry_date": None,
            "vehicle_categories": [], "issuing_authority": None,
        },
        "tampering_detected": False,
        "tampering_indicators": [],
        "quality_issues": [reason],
        "name_matches": None,
        "licence_number_matches": None,
        "flags": [flag],
        "summary": reason,
    }


_MIME_MAP = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif"}


@router.post("/verify-document", status_code=200, summary="AI-based driving licence verification")
async def verify_document(
    file: Optional[UploadFile] = File(None),
    image_url: Optional[str] = Form(None),
    expected_name: Optional[str] = Form(None),
    expected_licence_number: Optional[str] = Form(None),
):
    """
    Accepts either a direct file upload or an image_url (relative path stored in DB).
    Uses Claude vision to verify authenticity and extract fields.
    Result is advisory — does NOT block registration if verification fails.
    Requires ANTHROPIC_API_KEY environment variable.
    """
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    if not anthropic_key:
        return _stub("AI verification not configured (ANTHROPIC_API_KEY missing)", "VERIFICATION_SKIPPED")

    # ── Obtain raw image bytes ────────────────────────────────────────────────
    contents: bytes = b""
    mime = "image/jpeg"

    if file is not None and file.filename:
        contents = await file.read()
        raw_mime = file.content_type or ""
        mime = raw_mime if raw_mime in ("image/jpeg", "image/png", "image/gif", "image/webp") else "image/jpeg"

    elif image_url:
        # image_url is stored as "/uploads/applications/xxx.jpg" — strip leading slash
        # to get the path relative to the service working directory.
        rel_path = image_url.lstrip("/")
        ext = rel_path.rsplit(".", 1)[-1].lower() if "." in rel_path else ""
        mime = _MIME_MAP.get(ext, "image/jpeg")
        try:
            with open(rel_path, "rb") as fh:
                contents = fh.read()
        except FileNotFoundError:
            return _stub("Document file not found on server", "FILE_NOT_FOUND")
        except OSError as exc:
            logger.error("verify-document: cannot open %s: %s", rel_path, exc)
            return _stub("Could not read document file", "FILE_READ_ERROR")

    if not contents:
        return _stub("No document provided", "NO_DOCUMENT")

    b64 = base64.b64encode(contents).decode()

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                _ANTHROPIC_MESSAGES_URL,
                headers={
                    "x-api-key": anthropic_key,
                    "anthropic-version": _ANTHROPIC_VERSION,
                    "content-type": "application/json",
                },
                json={
                    "model": _ANTHROPIC_MODEL,
                    "max_tokens": 1024,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": mime,
                                    "data": b64,
                                },
                            },
                            {"type": "text", "text": _DOC_PROMPT},
                        ],
                    }],
                },
            )
            resp.raise_for_status()
            raw = resp.json()["content"][0]["text"].strip()

        # Strip markdown fences if the model wrapped JSON in them
        if "```" in raw:
            parts = raw.split("```")
            raw = parts[1].lstrip("json").strip() if len(parts) > 1 else raw

        data: dict = json.loads(raw)

    except (httpx.HTTPError, json.JSONDecodeError, KeyError, Exception) as exc:
        logger.error("verify-document AI call failed: %s", exc)
        return _stub("AI verification failed — please try again later", "VERIFICATION_FAILED")

    extracted = data.get("extracted") or {}

    # Cross-check extracted fields against expected values
    name_matches = None
    if expected_name and extracted.get("name"):
        ratio = difflib.SequenceMatcher(
            None,
            expected_name.lower().strip(),
            extracted["name"].lower().strip(),
        ).ratio()
        name_matches = ratio >= 0.80

    licence_number_matches = None
    if expected_licence_number and extracted.get("licence_number"):
        licence_number_matches = (
            expected_licence_number.upper().strip() == extracted["licence_number"].upper().strip()
        )

    flags = list(data.get("flags") or [])
    if name_matches is False:
        flags.append("NAME_MISMATCH")
    if licence_number_matches is False:
        flags.append("LICENCE_NUMBER_MISMATCH")

    return {
        "is_genuine_document": data.get("is_genuine_document"),
        "document_type": data.get("document_type", "unknown"),
        "confidence": float(data.get("confidence") or 0),
        "extracted": {
            "name":              extracted.get("name"),
            "licence_number":    extracted.get("licence_number"),
            "date_of_birth":     extracted.get("date_of_birth"),
            "issue_date":        extracted.get("issue_date"),
            "expiry_date":       extracted.get("expiry_date"),
            "vehicle_categories": extracted.get("vehicle_categories") or [],
            "issuing_authority": extracted.get("issuing_authority"),
        },
        "tampering_detected":     bool(data.get("tampering_detected")),
        "tampering_indicators":   list(data.get("tampering_indicators") or []),
        "quality_issues":         list(data.get("quality_issues") or []),
        "name_matches":           name_matches,
        "licence_number_matches": licence_number_matches,
        "flags":                  flags,
        "summary":                data.get("summary", "Verification complete."),
    }
