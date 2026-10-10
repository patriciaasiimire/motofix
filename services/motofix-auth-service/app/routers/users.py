# app/routers/users.py
# Shared endpoints for working with user accounts after login — looking up a user's
# details, updating their profile, saving their FCM token (so they can receive push
# notifications), and similar account housekeeping used across the apps.

import json
import logging
from typing import Optional, List

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.middleware.auth import get_current_user, require_role

router = APIRouter(tags=["Users"])
logger = logging.getLogger(__name__)


# ── DB helper ──────────────────────────────────────────────────────────────────

async def _get_conn(request: Request):
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")
    return pool


def _normalize_preferences(raw) -> dict:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw or {}
    if isinstance(raw, str):
        value = raw.strip()
        if not value:
            return {}
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


# ── Schemas ────────────────────────────────────────────────────────────────────

class UserProfileUpdate(BaseModel):
    full_name:    Optional[str] = None
    number_plate: Optional[str] = None


class FcmTokenUpdate(BaseModel):
    fcm_token: str


class PreferencesUpdate(BaseModel):
    preferences: dict


class DriverStatusUpdate(BaseModel):
    status: str  # 'active' | 'suspended' | 'banned'
    reason: Optional[str] = None


# ── GET /users/me ──────────────────────────────────────────────────────────────

@router.get("/users/me")
async def get_my_profile(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Return the authenticated driver's full profile from the DB."""
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, phone, full_name, number_plate, role, fcm_token, created_at FROM users WHERE id = $1",
            int(user["sub"]),
        )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)


# ── PATCH /users/me ────────────────────────────────────────────────────────────

@router.patch("/users/me")
async def update_my_profile(
    request: Request,
    body: UserProfileUpdate,
    user: dict = Depends(get_current_user),
):
    """Update the authenticated driver's profile fields."""
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clauses = [f"{key} = ${i+1}" for i, key in enumerate(updates)]
    params = list(updates.values())
    params.append(int(user["sub"]))

    query = f"""
        UPDATE users
        SET {', '.join(set_clauses)}
        WHERE id = ${len(params)}
        RETURNING id, phone, full_name, number_plate, role, created_at
    """
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, *params)

    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    logger.info("Profile updated for user_id=%s fields=%s", user["sub"], list(updates.keys()))
    return dict(row)


# ── POST /users/me/fcm-token ───────────────────────────────────────────────────

@router.post("/users/me/fcm-token")
async def register_fcm_token(
    request: Request,
    body: FcmTokenUpdate,
    user: dict = Depends(get_current_user),
):
    """Register or refresh the driver's Firebase Cloud Messaging device token."""
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET fcm_token = $1 WHERE id = $2",
            body.fcm_token, int(user["sub"]),
        )
    logger.info("FCM token registered for user_id=%s", user["sub"])
    return {"detail": "FCM token registered successfully"}


# ── GET /users/me/preferences ─────────────────────────────────────────────────

@router.get("/users/me/preferences")
async def get_my_preferences(
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT preferences FROM users WHERE id = $1",
            int(user["sub"]),
        )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    preferences = _normalize_preferences(row["preferences"])
    return {"preferences": preferences}


# ── PATCH /users/me/preferences ────────────────────────────────────────────────

@router.patch("/users/me/preferences")
async def update_my_preferences(
    request: Request,
    body: PreferencesUpdate,
    user: dict = Depends(get_current_user),
):
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE users
            SET preferences = preferences || $1::jsonb
            WHERE id = $2
            RETURNING preferences
            """,
            json.dumps(body.preferences),
            int(user["sub"]),
        )
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    preferences = _normalize_preferences(row["preferences"])
    return {"preferences": preferences}


# ── GET /users/ (admin list) ───────────────────────────────────────────────────

@router.get("/users/")
async def list_users(
    request: Request,
    _admin: dict = Depends(require_role("admin")),
):
    """List all driver accounts with basic stats for admin."""
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, phone, full_name, number_plate, vehicle_type,
                   role, status, status_reason, status_updated_at, created_at
            FROM users
            ORDER BY created_at DESC
        """)
    return [dict(r) for r in rows]


# ── GET /users/{user_id} (admin) ───────────────────────────────────────────────

@router.get("/users/{user_id}")
async def get_user(
    user_id: int,
    request: Request,
    _admin: dict = Depends(require_role("admin")),
):
    """Return a single driver's full profile for admin."""
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT id, phone, full_name, number_plate, vehicle_type,
                   role, status, status_reason, status_updated_at, created_at
            FROM users WHERE id = $1
        """, user_id)
    if not row:
        raise HTTPException(status_code=404, detail="Driver not found")
    return dict(row)


# ── PATCH /users/{user_id}/status (admin) ─────────────────────────────────────

@router.patch("/users/{user_id}/status")
async def update_user_status(
    user_id: int,
    body: DriverStatusUpdate,
    request: Request,
    admin: dict = Depends(require_role("admin")),
):
    """Suspend, ban, or reinstate a driver account."""
    if body.status not in ("active", "suspended", "banned"):
        raise HTTPException(status_code=400, detail="status must be active, suspended, or banned")
    pool = await _get_conn(request)
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            UPDATE users
            SET status = $1, status_reason = $2, status_updated_at = NOW()
            WHERE id = $3
            RETURNING id, phone, full_name, status, status_reason, status_updated_at
        """, body.status, body.reason, user_id)
    if not row:
        raise HTTPException(status_code=404, detail="Driver not found")
    logger.info("Admin %s set user %s status to %s", admin.get("sub"), user_id, body.status)
    return dict(row)
