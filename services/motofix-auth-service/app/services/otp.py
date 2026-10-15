# app/services/otp.py
# Handles the one-time codes used to verify a phone number at sign-up/login.
# (OTP = "One-Time Password" — the 6-digit code texted to the phone to prove the
# person actually owns that number.)
#
# The three steps: generate_otp() makes the code, store_otp() saves it with a
# 5-minute expiry, and verify_otp() checks what the user typed — allowing only a
# few wrong tries before the code is thrown away.
# Uses the raw asyncpg connection (database link) passed in from the router.

import os
import secrets
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

OTP_EXPIRY_MINUTES = 5
MAX_ATTEMPTS       = 5

# A repeated "send me a code" request within this many seconds re-uses the code that is
# already stored instead of replacing it. The app retries when a sleeping server is slow
# to answer, and without this every retry would invalidate the SMS the user just got.
OTP_REUSE_SECONDS = 60

# Printing OTPs in the logs is for local development ONLY. Anyone who can read the
# production logs could otherwise log in as any user, so it is off unless explicitly
# enabled with DEBUG_LOG_OTP=true.
_LOG_OTP = os.getenv("DEBUG_LOG_OTP", "").strip().lower() == "true"


def generate_otp() -> str:
    """Return a cryptographically secure 6-digit OTP string."""
    return f"{secrets.randbelow(1_000_000):06d}"


async def store_otp(
    conn,
    phone: str,
    otp: str,
    pending_full_name: str | None = None,
    pending_number_plate: str | None = None,
) -> None:
    """
    Delete any existing OTP for this phone then insert a fresh record.
    conn: raw asyncpg connection.

    pending_full_name / pending_number_plate carry the registration details for a
    NEW driver whose users row has not been created yet — they are read back in
    verify-otp to create the account only after the phone number is confirmed.
    """
    await conn.execute("DELETE FROM otp_store WHERE phone = $1", phone)

    now        = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=OTP_EXPIRY_MINUTES)

    await conn.execute(
        """
        INSERT INTO otp_store
            (phone, otp_code, attempts, created_at, expires_at,
             pending_full_name, pending_number_plate)
        VALUES ($1, $2, 0, $3, $4, $5, $6)
        """,
        phone, otp, now, expires_at, pending_full_name, pending_number_plate,
    )
    logger.debug("OTP stored for phone ending %s (expires %s)", phone[-4:], expires_at)
    if _LOG_OTP:
        logger.info("🔑 DEV OTP for %s: %s", phone, otp)


async def get_recent_otp(conn, phone: str) -> str | None:
    """
    Return the OTP already stored for `phone` if it was created within the last
    OTP_REUSE_SECONDS and has not expired; otherwise None.

    Used so a retried request (same phone, a few seconds later) sends the SAME code
    again rather than invalidating the one the user may already have received.
    """
    row = await conn.fetchrow(
        "SELECT otp_code, created_at, expires_at FROM otp_store WHERE phone = $1",
        phone,
    )
    if not row:
        return None

    now = datetime.now(timezone.utc)
    created_at = row["created_at"]
    expires_at = row["expires_at"]
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if now > expires_at:
        return None
    if (now - created_at).total_seconds() > OTP_REUSE_SECONDS:
        return None
    return row["otp_code"]


async def verify_otp(conn, phone: str, submitted_otp: str) -> bool:
    """
    Validate the submitted OTP.
    Raises RuntimeError with a structured error code on failure.
    Deletes the OTP record on success.
    """
    row = await conn.fetchrow(
        "SELECT id, otp_code, attempts, expires_at FROM otp_store WHERE phone = $1",
        phone,
    )

    if not row:
        raise RuntimeError("OTP_NOT_FOUND")

    now = datetime.now(timezone.utc)
    expires_at = row["expires_at"]
    # Make expires_at timezone-aware if it isn't
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if now > expires_at:
        await conn.execute("DELETE FROM otp_store WHERE phone = $1", phone)
        raise RuntimeError("OTP_EXPIRED")

    new_attempts = row["attempts"] + 1

    if new_attempts >= MAX_ATTEMPTS and row["otp_code"] != submitted_otp:
        await conn.execute("DELETE FROM otp_store WHERE phone = $1", phone)
        raise RuntimeError("OTP_MAX_ATTEMPTS")

    if row["otp_code"] != submitted_otp:
        await conn.execute(
            "UPDATE otp_store SET attempts = $1 WHERE phone = $2",
            new_attempts, phone,
        )
        raise RuntimeError("INVALID_OTP")

    # Valid — clean up
    await conn.execute("DELETE FROM otp_store WHERE phone = $1", phone)
    logger.info("OTP verified successfully for %s", phone)
    return True
