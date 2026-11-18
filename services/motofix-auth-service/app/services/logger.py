# app/services/logger.py
# Writes events to the system_logs table.
# Never raises — logging must not break the main auth flow.

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

VALID_EVENTS = {
    "user_registered", "otp_sent", "otp_verified", "otp_failed", "otp_resent",
    "provider_registered", "provider_login", "provider_login_failed",
    "admin_login", "admin_login_failed",
    "provider_approved", "provider_rejected", "provider_deleted",
    "provider_created_by_admin", "provider_credentials_reset",
    "provider_banned", "provider_unbanned",
    "application_reopened",
    "token_refreshed", "user_logout",
    "admin_registered", "admin_deleted", "admin_profile_updated", "admin_password_changed",
    "platform_fees_updated", "maintenance_scheduled", "maintenance_ended",
}


async def log_event(
    conn,
    event_type: str,
    description: str = "",
    user_id: int = None,
    mechanic_id: int = None,
    request_id: int = None,
) -> None:
    """
    Insert a row into system_logs.
    conn: raw asyncpg connection.
    Silently swallows all exceptions so logging never breaks auth flow.
    """
    if event_type not in VALID_EVENTS:
        logger.warning("log_event: unknown event_type '%s'", event_type)

    try:
        await conn.execute(
            """
            INSERT INTO system_logs
                (event_type, user_id, mechanic_id, request_id, description, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            event_type,
            user_id,
            mechanic_id,
            request_id,
            description,
            datetime.now(timezone.utc),
        )
        logger.debug("system_log written: %s", event_type)
    except Exception as exc:
        logger.error("Failed to write system_log (%s): %s", event_type, exc)
