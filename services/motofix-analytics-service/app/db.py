# app/db.py
# Database connections for the analytics service. Unlike most services, this one
# connects to TWO databases: its own, plus the auth service's database (so the admin
# dashboard can read users/mechanics directly). get_db / get_auth_db are the FastAPI
# dependencies the routers use to borrow a connection from each pool.

import os
import asyncio
import asyncpg
from fastapi import FastAPI, HTTPException, Request
from typing import AsyncGenerator
import logging

logger = logging.getLogger(__name__)

# ── DB URLs ───────────────────────────────────────────────────────────────────
# Requests DB — owns service_requests, payments, reviews, media_files
DATABASE_URL = os.getenv("DATABASE_URL")
# Auth DB — owns mechanics, towing_providers, admins, users, system_logs
AUTH_DATABASE_URL = os.getenv("AUTH_DATABASE_URL")

db_error: str | None = None
auth_db_error: str | None = None


# ── Table bootstrap ───────────────────────────────────────────────────────────

async def _bootstrap_tables(pool: asyncpg.Pool) -> None:
    """Create analytics-owned tables on the requests DB."""
    async with pool.acquire() as conn:
        if os.getenv("ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS", "").lower() == "true":
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id                   SERIAL PRIMARY KEY,
                    mechanic_id          INTEGER NOT NULL,
                    mechanic_phone       TEXT NOT NULL,
                    plan                 TEXT NOT NULL DEFAULT 'monthly',
                    status               TEXT NOT NULL DEFAULT 'trial',
                    amount_ugx           INTEGER NOT NULL DEFAULT 20000,
                    trial_ends_at        TIMESTAMPTZ,
                    current_period_start TIMESTAMPTZ,
                    current_period_end   TIMESTAMPTZ,
                    grace_ends_at        TIMESTAMPTZ,
                    payment_ref          TEXT,
                    payment_method       TEXT,
                    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (mechanic_id)
                )
            """)
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions (status)"
            )
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS subscription_payments (
                    id             SERIAL PRIMARY KEY,
                    mechanic_id    INTEGER NOT NULL,
                    mechanic_phone TEXT NOT NULL,
                    amount_ugx     INTEGER NOT NULL,
                    payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
                    payment_ref    TEXT,
                    period_start   TIMESTAMPTZ,
                    period_end     TIMESTAMPTZ,
                    recorded_by    TEXT,
                    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            logger.info("✅ Analytics tables bootstrapped (subscriptions, subscription_payments)")
        else:
            logger.info("ℹ️ Legacy subscription tables disabled by default; set ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS=true to enable them.")


# ── Pool initialisation ───────────────────────────────────────────────────────

async def _create_pool(url: str, label: str, retries: int = 3, delay: int = 2) -> asyncpg.Pool | None:
    for attempt in range(retries):
        try:
            pool = await asyncpg.create_pool(url, min_size=1, max_size=10, command_timeout=10)
            logger.info("✅ %s pool ready", label)
            return pool
        except Exception as e:
            msg = f"Attempt {attempt + 1}/{retries}"
            if attempt < retries - 1:
                logger.warning("⚠️  %s pool failed (%s): %s — retrying in %ds", label, msg, e, delay)
                await asyncio.sleep(delay)
            else:
                logger.error("❌ %s pool failed (%s): %s — starting in degraded mode", label, msg, e)
    return None


async def init_db_pool(app: FastAPI):
    global db_error, auth_db_error

    if DATABASE_URL:
        pool = await _create_pool(DATABASE_URL, "requests-DB")
        if pool:
            app.state._db_pool = pool
            await _bootstrap_tables(pool)
        else:
            db_error = "Could not connect to requests DB"
    else:
        db_error = "DATABASE_URL not set"
        logger.error("❌ DATABASE_URL not set")

    if AUTH_DATABASE_URL:
        auth_pool = await _create_pool(AUTH_DATABASE_URL, "auth-DB")
        if auth_pool:
            app.state._auth_db_pool = auth_pool
        else:
            auth_db_error = "Could not connect to auth DB"
    else:
        auth_db_error = "AUTH_DATABASE_URL not set"
        logger.warning("⚠️  AUTH_DATABASE_URL not set — mechanics/admins queries will be unavailable")


async def close_db_pool(app: FastAPI):
    for attr in ("_db_pool", "_auth_db_pool"):
        pool = getattr(app.state, attr, None)
        if pool:
            await pool.close()
    logger.info("✅ All DB pools closed")


# ── Dependency helpers ────────────────────────────────────────────────────────

async def _acquire(request: Request, state_attr: str, fallback_url_env: str, label: str):
    pool = getattr(request.app.state, state_attr, None)

    if pool is None:
        url = os.getenv(fallback_url_env)
        if not url:
            raise HTTPException(status_code=503, detail=f"{label} database not configured")
        try:
            conn = await asyncpg.connect(url)
        except Exception as e:
            logger.error("🔴 %s fallback connection failed: %s", label, e)
            raise HTTPException(status_code=503, detail=f"{label} database unavailable")
        try:
            yield conn
        finally:
            await conn.close()
    else:
        try:
            async with pool.acquire() as conn:
                yield conn
        except Exception as e:
            logger.error("🔴 %s pool acquire failed: %s", label, e)
            raise HTTPException(status_code=503, detail=f"{label} database temporarily unavailable")


async def get_db(request: Request) -> AsyncGenerator[asyncpg.Connection, None]:
    """Requests DB — service_requests, payments, reviews, subscriptions."""
    async for conn in _acquire(request, "_db_pool", "DATABASE_URL", "Requests"):
        yield conn


async def get_auth_db(request: Request) -> AsyncGenerator[asyncpg.Connection, None]:
    """Auth DB — mechanics, towing_providers, admins, users."""
    async for conn in _acquire(request, "_auth_db_pool", "AUTH_DATABASE_URL", "Auth"):
        yield conn
