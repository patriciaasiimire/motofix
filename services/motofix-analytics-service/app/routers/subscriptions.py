# app/routers/subscriptions.py
# Mechanic-facing subscription endpoints.
# Mechanics call these with their normal JWT (issued by motofix-auth-service).

import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import jwt as pyjwt

from ..db import get_db

router = APIRouter(prefix="/subscriptions", tags=["Subscriptions"])
LEGACY_SUBSCRIPTIONS_ENABLED = os.getenv("ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS", "").lower() == "true"


def _legacy_subscription_guard() -> None:
    if not LEGACY_SUBSCRIPTIONS_ENABLED:
        raise HTTPException(
            status_code=410,
            detail="Legacy subscription routes are disabled by default. Set ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS=true to enable them.",
        )

# ── Token validation ──────────────────────────────────────────────────────────
# Uses the same secret as the auth service so mechanic JWTs are accepted.

_bearer = HTTPBearer()
SECRET_KEY = os.getenv("SECRET_KEY") or os.getenv("ADMIN_JWT_SECRET")
ALGORITHM  = os.getenv("ALGORITHM", "HS256")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY is required for analytics-service subscription verification")

TRIAL_DAYS = 7
GRACE_DAYS = 3


def _get_provider(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    token = credentials.credentials
    try:
        payload = pyjwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except pyjwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    role = payload.get("role", "")
    if role not in ("mechanic", "provider", "towing_provider", "driver"):
        pass  # allow any authenticated user to query their subscription
    return payload


def _provider_id(payload: dict) -> int:
    return int(payload.get("provider_id") or payload.get("sub") or 0)

def _provider_phone(payload: dict) -> str:
    return str(payload.get("phone") or "")


# ── Response model ────────────────────────────────────────────────────────────

class SubscriptionOut(BaseModel):
    mechanic_id: int
    status: str                         # trial | active | grace | expired
    plan: str
    amount_ugx: int
    days_left: int                      # computed — positive means time remaining
    trial_ends_at: Optional[str] = None
    current_period_end: Optional[str] = None
    grace_ends_at: Optional[str] = None
    payment_ref: Optional[str] = None


def _compute_days_left(row: dict) -> int:
    now = datetime.now(timezone.utc)
    status = row["status"]
    if status == "trial":
        end = row.get("trial_ends_at")
    elif status == "active":
        end = row.get("current_period_end")
    elif status == "grace":
        end = row.get("grace_ends_at")
    else:
        return 0
    if not end:
        return 0
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return max(0, (end - now).days)


def _row_to_out(row: dict) -> SubscriptionOut:
    def _fmt(v):
        return v.isoformat() if v and hasattr(v, "isoformat") else None

    return SubscriptionOut(
        mechanic_id=row["mechanic_id"],
        status=row["status"],
        plan=row.get("plan", "monthly"),
        amount_ugx=row.get("amount_ugx", 20000),
        days_left=_compute_days_left(row),
        trial_ends_at=_fmt(row.get("trial_ends_at")),
        current_period_end=_fmt(row.get("current_period_end")),
        grace_ends_at=_fmt(row.get("grace_ends_at")),
        payment_ref=row.get("payment_ref"),
    )


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/me", response_model=SubscriptionOut)
async def get_my_subscription(
    db=Depends(get_db),
    provider: dict = Depends(_get_provider),
):
    """
    Return the current subscription state for the authenticated mechanic.
    If no subscription record exists, creates a default 7-day trial starting now.
    """
    _legacy_subscription_guard()
    mechanic_id = _provider_id(provider)
    if not mechanic_id:
        raise HTTPException(status_code=400, detail="Cannot determine mechanic ID from token")

    row = await db.fetchrow(
        "SELECT * FROM subscriptions WHERE mechanic_id = $1", mechanic_id
    )

    if not row:
        # Auto-create a trial record on first call
        phone = _provider_phone(provider)
        now   = datetime.now(timezone.utc)
        trial_end = now + timedelta(days=TRIAL_DAYS)
        await db.execute("""
            INSERT INTO subscriptions
                (mechanic_id, mechanic_phone, status, plan, amount_ugx, trial_ends_at, updated_at)
            VALUES ($1, $2, 'trial', 'monthly', 20000, $3, NOW())
            ON CONFLICT (mechanic_id) DO NOTHING
        """, mechanic_id, phone, trial_end)
        row = await db.fetchrow(
            "SELECT * FROM subscriptions WHERE mechanic_id = $1", mechanic_id
        )

    # Auto-transition expired states
    row_dict = dict(row)
    now = datetime.now(timezone.utc)
    status = row_dict["status"]
    updated = False

    if status == "trial":
        end = row_dict.get("trial_ends_at")
        if end and (end.replace(tzinfo=timezone.utc) if end.tzinfo is None else end) <= now:
            grace_end = now + timedelta(days=GRACE_DAYS)
            await db.execute("""
                UPDATE subscriptions SET status='grace', grace_ends_at=$1, updated_at=NOW()
                WHERE mechanic_id=$2
            """, grace_end, mechanic_id)
            row_dict["status"] = "grace"
            row_dict["grace_ends_at"] = grace_end
            updated = True

    elif status == "active":
        end = row_dict.get("current_period_end")
        if end and (end.replace(tzinfo=timezone.utc) if end.tzinfo is None else end) <= now:
            grace_end = now + timedelta(days=GRACE_DAYS)
            await db.execute("""
                UPDATE subscriptions SET status='grace', grace_ends_at=$1, updated_at=NOW()
                WHERE mechanic_id=$2
            """, grace_end, mechanic_id)
            row_dict["status"] = "grace"
            row_dict["grace_ends_at"] = grace_end
            updated = True

    elif status == "grace":
        end = row_dict.get("grace_ends_at")
        if end and (end.replace(tzinfo=timezone.utc) if end.tzinfo is None else end) <= now:
            await db.execute("""
                UPDATE subscriptions SET status='expired', updated_at=NOW()
                WHERE mechanic_id=$1
            """, mechanic_id)
            row_dict["status"] = "expired"
            updated = True

    return _row_to_out(row_dict)
