# app/routers/admin.py
# Admin login and provider verification endpoints.

import logging
import secrets
import string
from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Path, Request, status

import bcrypt

from app.schemas.admin import AdminLoginRequest, AdminLoginResponse, AdminOut
from app.schemas.provider import VerifyProviderRequest
from app.schemas.common import SuccessResponse
from app.services.logger import log_event
from app.services.rate_limit import check_rate_limit, record_attempt
from app.services.sms import send_sms
from app.services.token import create_access_token
from app.middleware.auth import get_current_user, require_role

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Admin"])


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


def _verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


# ── POST /auth/login/admin ─────────────────────────────────────────────────────

@router.post(
    "/login/admin",
    response_model=AdminLoginResponse,
    status_code=status.HTTP_200_OK,
    summary="Admin login (email + password)",
)
async def login_admin(body: AdminLoginRequest, request: Request):
    """
    Authenticates an admin by email and password.
    Returns a short-lived JWT (8 h) and admin profile.
    """
    pool = await _get_conn(request)

    async with pool.acquire() as conn:
        await check_rate_limit(
            conn, f"login:{body.email.lower()}", max_attempts=5, window_seconds=900,
            message="Too many failed login attempts. Please wait 15 minutes before trying again.",
        )

        row = await conn.fetchrow(
            "SELECT id, full_name, email, role, password_hash FROM admins WHERE email = $1",
            body.email,
        )

        if not row or not _verify_password(body.password, row["password_hash"]):
            await record_attempt(conn, f"login:{body.email.lower()}")
            await log_event(
                conn,
                event_type="admin_login_failed",
                description=f"Failed admin login attempt for email: {body.email}",
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": True, "code": "INVALID_CREDENTIALS",
                        "message": "Invalid email or password", "status_code": 401},
            )

        admin = dict(row)
        token = create_access_token(
            data={"sub": str(admin["id"]), "email": admin["email"]},
            role="admin",
        )

        await log_event(
            conn,
            event_type="admin_login",
            description=f"Admin logged in: {admin['email']}",
        )

    return AdminLoginResponse(
        access_token=token,
        admin=AdminOut(
            id=admin["id"],
            full_name=admin["full_name"],
            email=admin["email"],
            role=admin["role"],
        ),
    )


# ── POST /auth/admin/verify-provider/{provider_id} ────────────────────────────

@router.post(
    "/admin/verify-provider/{provider_id}",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Approve or reject a provider account (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def verify_provider(
    provider_id: int,
    body: VerifyProviderRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    """
    Approves or rejects a mechanic or towing provider account.
    Requires admin JWT.
    Body: { decision: "approved"|"rejected", provider_type: "mechanic"|"towing_provider", reason?: str }
    """
    pool = await _get_conn(request)
    is_approved = body.decision == "approved"
    event = "provider_approved" if is_approved else "provider_rejected"

    async with pool.acquire() as conn:
        # Fetch provider to get phone number for SMS
        if body.provider_type == "mechanic":
            provider_row = await conn.fetchrow(
                "SELECT id, full_name, phone FROM mechanics WHERE id = $1", provider_id
            )
        else:
            provider_row = await conn.fetchrow(
                "SELECT id, full_name, phone FROM towing_providers WHERE id = $1", provider_id
            )

        if not provider_row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": True, "code": "PROVIDER_NOT_FOUND",
                        "message": f"{body.provider_type} with id {provider_id} not found",
                        "status_code": 404},
            )

        if is_approved:
            # Generate unique SPN: count all existing SPNs across both tables
            count_row = await conn.fetchrow(
                """
                SELECT (SELECT COUNT(*) FROM mechanics        WHERE spn IS NOT NULL)
                     + (SELECT COUNT(*) FROM towing_providers WHERE spn IS NOT NULL) AS total
                """
            )
            spn_num  = (count_row["total"] or 0) + 1
            spn      = f"SPN-{spn_num:04d}"

            # Generate a random 10-char temporary password (uppercase + digits)
            alphabet = string.ascii_uppercase + string.digits
            temp_pw  = ''.join(secrets.choice(alphabet) for _ in range(10))
            pw_hash  = bcrypt.hashpw(temp_pw.encode(), bcrypt.gensalt()).decode()

            if body.provider_type == "mechanic":
                result = await conn.execute(
                    "UPDATE mechanics SET is_verified = TRUE, spn = $1, password_hash = $2 WHERE id = $3",
                    spn, pw_hash, provider_id,
                )
            else:
                result = await conn.execute(
                    "UPDATE towing_providers SET is_verified = TRUE, spn = $1, password_hash = $2 WHERE id = $3",
                    spn, pw_hash, provider_id,
                )

            if result == "UPDATE 0":
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={"error": True, "code": "PROVIDER_NOT_FOUND",
                            "message": f"{body.provider_type} with id {provider_id} not found",
                            "status_code": 404},
                )

            # Send credentials via SMS
            sms_body = (
                f"MOTOFIX: Congratulations {provider_row['full_name']}! "
                f"Your provider account has been approved.\n\n"
                f"Service Provider Number: {spn}\n"
                f"Temporary Password: {temp_pw}\n\n"
                f"Log in at the MOTOFIX Provider app using your SPN or phone number. "
                f"Please change your password after first login."
            )
            send_sms(provider_row["phone"], sms_body)

        else:
            # Rejected — just update is_verified to False (already False but explicit)
            if body.provider_type == "mechanic":
                result = await conn.execute(
                    "UPDATE mechanics SET is_verified = FALSE WHERE id = $1", provider_id
                )
            else:
                result = await conn.execute(
                    "UPDATE towing_providers SET is_verified = FALSE WHERE id = $1", provider_id
                )

            if result == "UPDATE 0":
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={"error": True, "code": "PROVIDER_NOT_FOUND",
                            "message": f"{body.provider_type} with id {provider_id} not found",
                            "status_code": 404},
                )

            # Notify provider of rejection via SMS
            reason_text = f" Reason: {body.reason}" if body.reason else ""
            sms_body = (
                f"MOTOFIX: We regret to inform you that your provider application "
                f"has not been approved at this time.{reason_text} "
                f"You may re-apply after addressing the issues noted."
            )
            send_sms(provider_row["phone"], sms_body)

        reason_note = f" Reason: {body.reason}" if body.reason else ""
        await log_event(
            conn,
            event_type=event,
            mechanic_id=provider_id,
            description=f"Admin {admin.get('sub')} {body.decision} {body.provider_type} {provider_id}.{reason_note}",
        )

    action = "approved" if is_approved else "rejected"
    spn_note = f" SPN: {spn}." if is_approved else ""
    return SuccessResponse(message=f"Provider {provider_id} has been {action}.{spn_note}")


# ── POST /auth/admin/ban-provider/{provider_id} ───────────────────────────────

from pydantic import BaseModel as _BaseModel


class BanProviderRequest(_BaseModel):
    provider_type: str
    reason: str


class UpdatePlatformFeesRequest(_BaseModel):
    service_fee_pct: float
    provider_cut_pct: float


# ── GET /auth/admin/platform-fees ─────────────────────────────────────────────

@router.get(
    "/admin/platform-fees",
    status_code=status.HTTP_200_OK,
    summary="Get current platform fee configuration",
    dependencies=[Depends(require_role("admin"))],
)
async def get_platform_fees(request: Request):
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT service_fee_pct, provider_cut_pct FROM platform_config WHERE id = 1"
        )
    return {
        "service_fee_pct": float(row["service_fee_pct"]),
        "provider_cut_pct": float(row["provider_cut_pct"]),
    }


# ── PATCH /auth/admin/platform-fees ──────────────────────────────────────────

@router.patch(
    "/admin/platform-fees",
    status_code=status.HTTP_200_OK,
    summary="Update platform fees and notify all active providers via SMS",
    dependencies=[Depends(require_role("admin"))],
)
async def update_platform_fees(
    body: UpdatePlatformFeesRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    pool = await _get_conn(request)
    admin_id = int(admin["sub"])

    async with pool.acquire() as conn:
        old = await conn.fetchrow(
            "SELECT service_fee_pct, provider_cut_pct FROM platform_config WHERE id = 1"
        )
        fees_changed = (
            float(old["service_fee_pct"]) != body.service_fee_pct or
            float(old["provider_cut_pct"]) != body.provider_cut_pct
        )

        await conn.execute(
            "UPDATE platform_config SET service_fee_pct = $1, provider_cut_pct = $2, "
            "updated_at = NOW(), updated_by = $3 WHERE id = 1",
            body.service_fee_pct, body.provider_cut_pct, admin_id,
        )

        notified = 0
        if fees_changed:
            sms_body = (
                f"MOTOFIX Platform Update: Our fee structure has been updated.\n\n"
                f"Platform Service Fee: {body.service_fee_pct:.1f}%\n"
                f"Provider Revenue Cut: {body.provider_cut_pct:.1f}%\n\n"
                f"These changes take effect immediately. For questions contact:\n"
                f"support@motofix.ug | +256 700 000000\n\nMOTOFIX Team"
            )
            providers = await conn.fetch(
                "SELECT phone FROM mechanics WHERE is_verified = TRUE AND is_banned = FALSE"
            )
            providers += await conn.fetch(
                "SELECT phone FROM towing_providers WHERE is_verified = TRUE AND is_banned = FALSE"
            )
            for p in providers:
                send_sms(p["phone"], sms_body)
                notified += 1

        await log_event(
            conn, event_type="platform_fees_updated",
            description=f"Admin {admin_id} updated fees: fee={body.service_fee_pct}%, cut={body.provider_cut_pct}%. Notified {notified} providers.",
        )

    return {"message": f"Fees updated. {notified} providers notified via SMS.", "notified": notified}


class MaintenanceRequest(_BaseModel):
    active: bool
    start_time: Optional[str] = None   # ISO datetime string
    end_time: Optional[str] = None
    message: Optional[str] = None


# ── GET /auth/maintenance-status (public) ─────────────────────────────────────

@router.get(
    "/maintenance-status",
    status_code=status.HTTP_200_OK,
    summary="Check whether the platform is in maintenance mode (public)",
)
async def get_maintenance_status(request: Request):
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT maintenance_active, maintenance_start, maintenance_end, maintenance_message "
            "FROM platform_config WHERE id = 1"
        )
    if not row or not row["maintenance_active"]:
        return {"maintenance": False}
    return {
        "maintenance": True,
        "start_time":  row["maintenance_start"].isoformat() if row["maintenance_start"] else None,
        "end_time":    row["maintenance_end"].isoformat()   if row["maintenance_end"]   else None,
        "message":     row["maintenance_message"],
    }


# ── POST /auth/admin/maintenance ──────────────────────────────────────────────

@router.post(
    "/admin/maintenance",
    status_code=status.HTTP_200_OK,
    summary="Enable or disable maintenance mode and notify all users",
    dependencies=[Depends(require_role("admin"))],
)
async def set_maintenance_mode(
    body: MaintenanceRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    pool = await _get_conn(request)
    admin_id = int(admin["sub"])
    notified = 0

    async with pool.acquire() as conn:
        if body.active:
            start_dt = datetime.fromisoformat(body.start_time) if body.start_time else None
            end_dt   = datetime.fromisoformat(body.end_time)   if body.end_time   else None

            await conn.execute(
                "UPDATE platform_config SET maintenance_active = TRUE, "
                "maintenance_start = $1, maintenance_end = $2, maintenance_message = $3, "
                "updated_by = $4, updated_at = NOW() WHERE id = 1",
                start_dt, end_dt, body.message, admin_id,
            )

            # Format times for SMS
            def fmt(dt):
                if not dt:
                    return "TBD"
                return dt.strftime("%A, %d %b %Y at %I:%M %p")

            custom = f"\n\n{body.message}" if body.message else ""
            sms_body = (
                f"MOTOFIX: Scheduled Maintenance Notice\n\n"
                f"Our platform will be temporarily unavailable:\n"
                f"From: {fmt(start_dt)}\n"
                f"To:   {fmt(end_dt)}\n"
                f"{custom}\n\n"
                f"We apologise for the inconvenience. For urgent help:\n"
                f"support@motofix.ug | +256 700 000000\n\n"
                f"MOTOFIX Team"
            )

            # Notify all active drivers
            drivers = await conn.fetch(
                "SELECT phone FROM users WHERE status = 'active' AND phone IS NOT NULL"
            )
            # Notify all verified providers
            mechanics = await conn.fetch(
                "SELECT phone FROM mechanics WHERE is_verified = TRUE AND is_banned = FALSE"
            )
            towing = await conn.fetch(
                "SELECT phone FROM towing_providers WHERE is_verified = TRUE AND is_banned = FALSE"
            )

            for row in list(drivers) + list(mechanics) + list(towing):
                send_sms(row["phone"], sms_body)
                notified += 1

            await log_event(conn, event_type="maintenance_scheduled",
                            description=f"Admin {admin_id} scheduled maintenance {fmt(start_dt)} → {fmt(end_dt)}. {notified} users notified.")

        else:
            await conn.execute(
                "UPDATE platform_config SET maintenance_active = FALSE, "
                "maintenance_start = NULL, maintenance_end = NULL, maintenance_message = NULL "
                "WHERE id = 1"
            )
            await log_event(conn, event_type="maintenance_ended",
                            description=f"Admin {admin_id} ended maintenance mode.")

    msg = (f"Maintenance scheduled. {notified} users notified via SMS."
           if body.active else "Maintenance mode deactivated.")
    return {"message": msg, "notified": notified}


class CreateProviderRequest(_BaseModel):
    full_name: str
    phone: str
    location: str
    provider_type: str   # "mechanic" or "towing_provider"
    specialty: Optional[str] = None


# ── POST /auth/admin/create-provider ─────────────────────────────────────────

@router.post(
    "/admin/create-provider",
    status_code=status.HTTP_201_CREATED,
    summary="Admin directly creates a verified provider account",
    dependencies=[Depends(require_role("admin"))],
)
async def create_provider(
    body: CreateProviderRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if body.provider_type not in ("mechanic", "towing_provider"):
        raise HTTPException(status_code=400, detail="provider_type must be 'mechanic' or 'towing_provider'.")

    pool = await _get_conn(request)
    now = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        # Check duplicate phone
        table = "mechanics" if body.provider_type == "mechanic" else "towing_providers"
        existing = await conn.fetchrow(f"SELECT id FROM {table} WHERE phone = $1", body.phone)
        if existing:
            raise HTTPException(status_code=409, detail="A provider with this phone number already exists.")

        # Assign SPN
        count_row = await conn.fetchrow(
            """
            SELECT (SELECT COUNT(*) FROM mechanics        WHERE spn IS NOT NULL)
                 + (SELECT COUNT(*) FROM towing_providers WHERE spn IS NOT NULL) AS total
            """
        )
        spn_num = (count_row["total"] or 0) + 1
        spn = f"SPN-{spn_num:04d}"

        # Generate temp password
        alphabet = string.ascii_uppercase + string.digits
        temp_pw = ''.join(secrets.choice(alphabet) for _ in range(10))
        pw_hash = bcrypt.hashpw(temp_pw.encode(), bcrypt.gensalt()).decode()

        if body.provider_type == "mechanic":
            row = await conn.fetchrow(
                """
                INSERT INTO mechanics
                    (full_name, phone, location, latitude, longitude, specialty,
                     provider_type, password_hash, is_verified, spn, password_changed,
                     rating, total_ratings, jobs_completed, is_available, created_at)
                VALUES ($1,$2,$3,0,0,$4,'mechanic',$5,TRUE,$6,FALSE,0.0,0,0,FALSE,$7)
                RETURNING id, full_name AS name, phone, location, spn, created_at
                """,
                body.full_name, body.phone, body.location, body.specialty,
                pw_hash, spn, now,
            )
        else:
            row = await conn.fetchrow(
                """
                INSERT INTO towing_providers
                    (full_name, phone, location, latitude, longitude,
                     password_hash, is_verified, spn, password_changed,
                     rating, total_ratings, jobs_completed, is_available, created_at)
                VALUES ($1,$2,$3,0,0,$4,TRUE,$5,FALSE,0.0,0,0,FALSE,$6)
                RETURNING id, full_name AS name, phone, location, spn, created_at
                """,
                body.full_name, body.phone, body.location,
                pw_hash, spn, now,
            )

        await log_event(
            conn, event_type="provider_created_by_admin",
            description=f"Admin {admin.get('sub')} directly created {body.provider_type}: {body.phone} → {spn}",
        )

    return {
        "id": row["id"],
        "name": row["name"],
        "phone": row["phone"],
        "location": row["location"],
        "spn": spn,
        "temp_password": temp_pw,
        "provider_type": body.provider_type,
        "message": f"Provider created and verified. SPN: {spn}",
    }


class ResetProviderCredsRequest(_BaseModel):
    provider_type: str  # "mechanic" or "towing_provider"


# ── POST /auth/admin/reset-provider-credentials/{provider_id} ────────────────

@router.post(
    "/admin/reset-provider-credentials/{provider_id}",
    status_code=status.HTTP_200_OK,
    summary="Reset a provider's SPN and temporary password (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def reset_provider_credentials(
    provider_id: int,
    body: ResetProviderCredsRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if body.provider_type not in ("mechanic", "towing_provider"):
        raise HTTPException(status_code=400, detail="Invalid provider_type")

    pool = await _get_conn(request)
    table = "mechanics" if body.provider_type == "mechanic" else "towing_providers"

    async with pool.acquire() as conn:
        provider_row = await conn.fetchrow(
            f"SELECT id, full_name, phone, spn FROM {table} WHERE id = $1", provider_id
        )
        if not provider_row:
            raise HTTPException(status_code=404, detail="Provider not found")

        # Keep existing SPN; generate a new one only if the provider has none
        spn = provider_row["spn"]
        if not spn:
            count_row = await conn.fetchrow(
                """
                SELECT (SELECT COUNT(*) FROM mechanics        WHERE spn IS NOT NULL)
                     + (SELECT COUNT(*) FROM towing_providers WHERE spn IS NOT NULL) AS total
                """
            )
            spn_num = (count_row["total"] or 0) + 1
            spn = f"SPN-{spn_num:04d}"

        # Generate new 10-char temp password (uppercase + digits)
        alphabet = string.ascii_uppercase + string.digits
        temp_pw = ''.join(secrets.choice(alphabet) for _ in range(10))
        pw_hash = bcrypt.hashpw(temp_pw.encode(), bcrypt.gensalt()).decode()

        await conn.execute(
            f"UPDATE {table} SET spn = $1, password_hash = $2, password_changed = FALSE WHERE id = $3",
            spn, pw_hash, provider_id,
        )

        sms_body = (
            f"MOTOFIX: Your login credentials have been reset by an administrator.\n\n"
            f"Service Provider Number: {spn}\n"
            f"New Temporary Password: {temp_pw}\n\n"
            f"Log in at the MOTOFIX Provider app and change your password immediately."
        )
        send_sms(provider_row["phone"], sms_body)

        await log_event(
            conn, event_type="provider_credentials_reset",
            mechanic_id=provider_id,
            description=f"Admin {admin.get('sub')} reset credentials for {body.provider_type} {provider_id} (SPN: {spn})",
        )

    return {
        "spn": spn,
        "temp_password": temp_pw,
        "phone": provider_row["phone"],
        "message": f"Credentials reset. New password sent to {provider_row['phone']} via SMS.",
    }


class CreateAdminRequest(_BaseModel):
    full_name: str
    email: str
    password: str


class UpdateAdminProfileRequest(_BaseModel):
    full_name: str
    email: str


class ChangePasswordRequest(_BaseModel):
    current_password: str
    new_password: str


# ── GET /auth/admin/admins ────────────────────────────────────────────────────

@router.get(
    "/admin/admins",
    status_code=status.HTTP_200_OK,
    summary="List all admin accounts (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def list_admins(request: Request):
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, full_name, email, role, created_at FROM admins ORDER BY created_at ASC"
        )
    return [
        {
            "id": r["id"],
            "full_name": r["full_name"],
            "email": r["email"],
            "role": r["role"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in rows
    ]


# ── POST /auth/admin/register ─────────────────────────────────────────────────

@router.post(
    "/admin/register",
    status_code=status.HTTP_201_CREATED,
    summary="Register a new admin account (existing admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def register_admin(
    body: CreateAdminRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        existing = await conn.fetchrow("SELECT id FROM admins WHERE email = $1", body.email)
        if existing:
            raise HTTPException(status_code=400, detail="An admin with this email already exists.")
        pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
        row = await conn.fetchrow(
            "INSERT INTO admins (full_name, email, password_hash) VALUES ($1, $2, $3) "
            "RETURNING id, full_name, email, role, created_at",
            body.full_name, body.email, pw_hash,
        )
        await log_event(
            conn, event_type="admin_registered",
            description=f"Admin {admin.get('sub')} created new admin account: {body.email}",
        )
    return {
        "id": row["id"],
        "full_name": row["full_name"],
        "email": row["email"],
        "role": row["role"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


# ── DELETE /auth/admin/admins/{admin_id} ─────────────────────────────────────

@router.delete(
    "/admin/admins/{admin_id}",
    status_code=status.HTTP_200_OK,
    summary="Remove an admin account (admin only, cannot remove self)",
    dependencies=[Depends(require_role("admin"))],
)
async def delete_admin(
    admin_id: int,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if int(admin["sub"]) == admin_id:
        raise HTTPException(status_code=400, detail="You cannot remove your own account.")
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "DELETE FROM admins WHERE id = $1 RETURNING id, full_name, email",
            admin_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Admin not found.")
        await log_event(
            conn, event_type="admin_deleted",
            description=f"Admin {admin.get('sub')} removed admin {admin_id} ({row['email']}).",
        )
    return {"message": f"Admin account for {row['full_name']} has been removed."}


# ── PATCH /auth/admin/profile ─────────────────────────────────────────────────

@router.patch(
    "/admin/profile",
    status_code=status.HTTP_200_OK,
    summary="Update admin profile (name + email)",
    dependencies=[Depends(require_role("admin"))],
)
async def update_admin_profile(
    body: UpdateAdminProfileRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    pool = await _get_conn(request)
    admin_id = int(admin["sub"])
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE admins SET full_name = $1, email = $2 WHERE id = $3 "
            "RETURNING id, full_name, email, role",
            body.full_name, body.email, admin_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Admin not found")
        await log_event(conn, event_type="admin_profile_updated",
                        description=f"Admin {admin_id} updated their profile.")
    return {"id": row["id"], "full_name": row["full_name"], "email": row["email"], "role": row["role"]}


# ── POST /auth/admin/change-password ─────────────────────────────────────────

@router.post(
    "/admin/change-password",
    status_code=status.HTTP_200_OK,
    summary="Change admin password",
    dependencies=[Depends(require_role("admin"))],
)
async def change_admin_password(
    body: ChangePasswordRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
    pool = await _get_conn(request)
    admin_id = int(admin["sub"])
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT password_hash FROM admins WHERE id = $1", admin_id
        )
        if not row or not _verify_password(body.current_password, row["password_hash"]):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
        new_hash = bcrypt.hashpw(body.new_password.encode(), bcrypt.gensalt()).decode()
        await conn.execute(
            "UPDATE admins SET password_hash = $1 WHERE id = $2", new_hash, admin_id
        )
        await log_event(conn, event_type="admin_password_changed",
                        description=f"Admin {admin_id} changed their password.")
    return {"message": "Password changed successfully."}


# ── GET /admin/mechanics ──────────────────────────────────────────────────────

from fastapi import Query as _Query

@router.get(
    "/admin/mechanics",
    status_code=status.HTTP_200_OK,
    summary="List all mechanics (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def list_mechanics(
    request: Request,
    search: Optional[str] = _Query(None),
    verified: Optional[bool] = _Query(None),
    page: int = _Query(1, ge=1),
    pageSize: int = _Query(10, ge=1, le=200),
):
    pool = await _get_conn(request)
    conditions, params = [], []
    if search:
        params.append(f"%{search.lower()}%")
        conditions.append(f"(lower(full_name) LIKE ${len(params)} OR phone LIKE ${len(params)})")
    if verified is not None:
        params.append(verified)
        conditions.append(f"is_verified = ${len(params)}")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    offset = (page - 1) * pageSize
    async with pool.acquire() as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM mechanics {where}", *params)
        rows = await conn.fetch(
            f"""SELECT id, full_name AS name, phone, location,
                       is_verified, is_available, COALESCE(is_banned, FALSE) AS is_banned,
                       ban_reason, rating, jobs_completed, created_at
                FROM mechanics {where}
                ORDER BY created_at DESC
                LIMIT ${len(params)+1} OFFSET ${len(params)+2}""",
            *params, pageSize, offset,
        )
    return {
        "data": [dict(r) for r in rows],
        "page": page, "pageSize": pageSize,
        "total": total,
        "totalPages": max(1, (total + pageSize - 1) // pageSize) if total else 1,
    }


# ── PATCH /admin/mechanics/{mechanic_id} ─────────────────────────────────────

@router.patch(
    "/admin/mechanics/{mechanic_id}",
    status_code=status.HTTP_200_OK,
    summary="Update mechanic record (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def update_mechanic(mechanic_id: int, request: Request):
    body = await request.json()
    pool = await _get_conn(request)
    sets, params = [], []
    field_map = {"name": "full_name", "phone": "phone", "location": "location", "is_verified": "is_verified"}
    for key, col in field_map.items():
        if key in body:
            params.append(body[key])
            sets.append(f"{col} = ${len(params)}")
    if not sets:
        raise HTTPException(status_code=400, detail="No updatable fields provided.")
    params.append(mechanic_id)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE mechanics SET {', '.join(sets)} WHERE id = ${len(params)} "
            f"RETURNING id, full_name AS name, phone, location, is_verified, rating, jobs_completed, created_at",
            *params,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Mechanic not found.")
    return dict(row)


# ── DELETE /admin/mechanics/{mechanic_id} ────────────────────────────────────

@router.delete(
    "/admin/mechanics/{mechanic_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete mechanic account (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def delete_mechanic(
    mechanic_id: int,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    body = await request.json()
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise HTTPException(status_code=422, detail="Deletion reason is required")

    pool = await _get_conn(request)
    admin_id = int(admin.get("sub", 0))

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "DELETE FROM mechanics WHERE id = $1 RETURNING id, full_name, phone", mechanic_id
        )
        if not row:
            raise HTTPException(status_code=404, detail="Mechanic not found.")

        await conn.execute(
            """
            UPDATE provider_applications
            SET verification_status = 'revoked',
                rejection_reason    = $1,
                reviewed_at         = NOW(),
                reviewed_by         = $2
            WHERE phone = $3 AND verification_status = 'approved'
            """,
            f"Account permanently deleted. Reason: {reason}",
            admin_id,
            row["phone"],
        )

        await log_event(
            conn,
            event_type="provider_deleted",
            user_id=admin_id,
            mechanic_id=mechanic_id,
            description=f"Admin {admin_id} deleted mechanic #{mechanic_id} ({row['full_name']}, {row['phone']}). Reason: {reason}",
        )

    return {"message": f"Mechanic account for {row['full_name']} has been deleted."}


# ── GET /admin/towing-providers ───────────────────────────────────────────────

@router.get(
    "/admin/towing-providers",
    status_code=status.HTTP_200_OK,
    summary="List all towing providers (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def list_towing_providers(
    request: Request,
    search: Optional[str] = _Query(None),
    verified: Optional[bool] = _Query(None),
    page: int = _Query(1, ge=1),
    pageSize: int = _Query(10, ge=1, le=200),
):
    pool = await _get_conn(request)
    conditions, params = [], []
    if search:
        params.append(f"%{search.lower()}%")
        conditions.append(f"(lower(full_name) LIKE ${len(params)} OR phone LIKE ${len(params)})")
    if verified is not None:
        params.append(verified)
        conditions.append(f"is_verified = ${len(params)}")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    offset = (page - 1) * pageSize
    async with pool.acquire() as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM towing_providers {where}", *params)
        rows = await conn.fetch(
            f"""SELECT id, full_name AS name, phone, location,
                       is_verified, is_available, COALESCE(spn, '') AS spn,
                       COALESCE(is_banned, FALSE) AS is_banned, ban_reason,
                       rating, jobs_completed, created_at
                FROM towing_providers {where}
                ORDER BY created_at DESC
                LIMIT ${len(params)+1} OFFSET ${len(params)+2}""",
            *params, pageSize, offset,
        )
    return {
        "data": [dict(r) for r in rows],
        "page": page, "pageSize": pageSize,
        "total": total,
        "totalPages": max(1, (total + pageSize - 1) // pageSize) if total else 1,
    }


# ── PATCH /admin/towing-providers/{provider_id} ───────────────────────────────

@router.patch(
    "/admin/towing-providers/{provider_id}",
    status_code=status.HTTP_200_OK,
    summary="Update towing provider record (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def update_towing_provider(provider_id: int, request: Request):
    body = await request.json()
    pool = await _get_conn(request)
    sets, params = [], []
    field_map = {"name": "full_name", "phone": "phone", "location": "location", "is_verified": "is_verified"}
    for key, col in field_map.items():
        if key in body:
            params.append(body[key])
            sets.append(f"{col} = ${len(params)}")
    if not sets:
        raise HTTPException(status_code=400, detail="No updatable fields provided.")
    params.append(provider_id)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE towing_providers SET {', '.join(sets)} WHERE id = ${len(params)} "
            f"RETURNING id, full_name AS name, phone, location, is_verified, rating, jobs_completed, created_at",
            *params,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Towing provider not found.")
    return dict(row)


# ── DELETE /admin/towing-providers/{provider_id} ─────────────────────────────

@router.delete(
    "/admin/towing-providers/{provider_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete towing provider account (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def delete_towing_provider(
    provider_id: int,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    body = await request.json()
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise HTTPException(status_code=422, detail="Deletion reason is required")

    pool = await _get_conn(request)
    admin_id = int(admin.get("sub", 0))

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "DELETE FROM towing_providers WHERE id = $1 RETURNING id, full_name, phone", provider_id
        )
        if not row:
            raise HTTPException(status_code=404, detail="Towing provider not found.")

        await conn.execute(
            """
            UPDATE provider_applications
            SET verification_status = 'revoked',
                rejection_reason    = $1,
                reviewed_at         = NOW(),
                reviewed_by         = $2
            WHERE phone = $3 AND verification_status = 'approved'
            """,
            f"Account permanently deleted. Reason: {reason}",
            admin_id,
            row["phone"],
        )

        await log_event(
            conn,
            event_type="provider_deleted",
            user_id=admin_id,
            description=f"Admin {admin_id} deleted towing provider #{provider_id} ({row['full_name']}, {row['phone']}). Reason: {reason}",
        )

    return {"message": f"Towing provider account for {row['full_name']} has been deleted."}


# ── POST /admin/ban-provider/{provider_id} ────────────────────────────────────
@router.post(
    "/admin/ban-provider/{provider_id}",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Permanently ban a provider (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def ban_provider(
    provider_id: int,
    body: BanProviderRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if body.provider_type not in ("mechanic", "towing_provider"):
        raise HTTPException(status_code=400, detail="Invalid provider_type")

    pool = await _get_conn(request)
    table = "mechanics" if body.provider_type == "mechanic" else "towing_providers"

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE {table} SET is_banned = TRUE, ban_reason = $1, banned_at = NOW(), is_verified = FALSE "
            f"WHERE id = $2 RETURNING id, full_name, phone",
            body.reason, provider_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Provider not found")

        sms_body = (
            f"MOTOFIX: Your service provider account has been permanently suspended.\n\n"
            f"Reason: {body.reason}\n\n"
            f"If you believe this is a mistake or need clarification, please contact us:\n"
            f"Email: support@motofix.ug\n"
            f"Phone: +256 700 000000\n\n"
            f"MOTOFIX Support Team"
        )
        send_sms(row["phone"], sms_body)

        await log_event(
            conn,
            event_type="provider_banned",
            description=f"Admin {admin.get('sub')} banned {body.provider_type} {provider_id}. Reason: {body.reason}",
        )

    return SuccessResponse(message=f"Provider {provider_id} has been banned and notified via SMS.")


@router.post(
    "/admin/unban-provider/{provider_id}",
    response_model=SuccessResponse,
    status_code=status.HTTP_200_OK,
    summary="Lift a ban on a provider (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def unban_provider(
    provider_id: int,
    body: BanProviderRequest,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    if body.provider_type not in ("mechanic", "towing_provider"):
        raise HTTPException(status_code=400, detail="Invalid provider_type")

    pool = await _get_conn(request)
    table = "mechanics" if body.provider_type == "mechanic" else "towing_providers"

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE {table} SET is_banned = FALSE, ban_reason = NULL, banned_at = NULL "
            f"WHERE id = $1 RETURNING id, full_name, phone",
            provider_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Provider not found")

        sms_body = (
            f"MOTOFIX: Good news! Your service provider account has been reinstated.\n\n"
            f"You can now log in to the MOTOFIX Provider app and resume receiving jobs.\n\n"
            f"MOTOFIX Support Team"
        )
        send_sms(row["phone"], sms_body)

        await log_event(
            conn,
            event_type="provider_unbanned",
            description=f"Admin {admin.get('sub')} unbanned {body.provider_type} {provider_id}.",
        )

    return SuccessResponse(message=f"Provider {provider_id} ban has been lifted.")


# ── GET /auth/admin/activity-log ──────────────────────────────────────────────

@router.get(
    "/admin/activity-log",
    status_code=status.HTTP_200_OK,
    summary="System activity log (admin only)",
    dependencies=[Depends(require_role("admin"))],
)
async def get_activity_log(
    request: Request,
    event_type: Optional[str] = _Query(None),
    search: Optional[str] = _Query(None),
    page: int = _Query(1, ge=1),
    pageSize: int = _Query(50, ge=1, le=200),
):
    pool = await _get_conn(request)
    conditions, params = [], []

    if event_type:
        params.append(event_type)
        conditions.append(f"l.event_type = ${len(params)}")
    if search:
        params.append(f"%{search.lower()}%")
        conditions.append(f"lower(l.description) LIKE ${len(params)}")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    offset = (page - 1) * pageSize

    async with pool.acquire() as conn:
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM system_logs l {where}", *params
        )
        rows = await conn.fetch(
            f"""
            SELECT l.id, l.event_type, l.description, l.created_at,
                   a.full_name AS admin_name
            FROM system_logs l
            LEFT JOIN admins a ON l.user_id = a.id
            {where}
            ORDER BY l.created_at DESC
            LIMIT ${len(params)+1} OFFSET ${len(params)+2}
            """,
            *params, pageSize, offset,
        )

    return {
        "data": [
            {
                "id": r["id"],
                "event_type": r["event_type"],
                "description": r["description"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "admin_name": r["admin_name"] or "MOTOFIX Admin",
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "pageSize": pageSize,
        "totalPages": max(1, (total + pageSize - 1) // pageSize) if total else 1,
    }
