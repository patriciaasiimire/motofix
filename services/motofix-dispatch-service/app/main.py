# app/main.py — Request & Dispatch Service (the busiest service in MOTOFIX)
#
# This is the engine room. When a driver asks for help, this service handles the
# whole journey of that request and almost everything attached to it. It's large,
# so use the section dividers (lines like "──── SECTION ────") to jump around.
#
# WHAT IT DOES, by section (top → bottom):
#   • Startup            — run_migrations / lifespan: create DB tables, start the
#                          background "watchdog", connect to Postgres with retries.
#   • Geocoding          — turn GPS coordinates into a human address (Google proxy).
#   • Health checks      — simple "is this service alive?" endpoints.
#   • Auth & feature flags— read the logged-in user from their token; on/off switches.
#   • Models             — the shapes of request data in/out (RequestCreate, RequestOut).
#   • Real-time (WebSocket)— push live updates to driver/mechanic apps (ConnectionManager).
#   • Request endpoints  — create a request, attach photos/voice, list, accept, reject,
#                          re-dispatch to the next mechanic, update status through the job.
#   • Strikes & fees     — penalise mechanics who cancel; track the platform fee MOTOFIX
#                          earns per job (this replaced the old monthly subscription).
#   • Stats & revenue    — numbers for the admin dashboard.
#   • Payments           — Mobile Money via MTN MoMo and Airtel Money, plus cash jobs.
#
# Data is stored in Postgres via raw SQL (asyncpg) — there's no ORM here, so you'll
# see SQL strings directly in the endpoints. `get_db` hands each request a connection.

import os
import json
import asyncio
import tempfile
import uuid
import base64
import time
from datetime import datetime
from fastapi import FastAPI, HTTPException, Depends, Request, Form, UploadFile, File, WebSocket, WebSocketDisconnect, BackgroundTasks
from typing import List, Optional, Dict
from pydantic import BaseModel
import asyncpg
from contextlib import asynccontextmanager
import httpx
import logging
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from jose import jwt, JWTError
from app.storage import get_storage, StorageError
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _require_secret() -> str:
    secret = os.getenv("SECRET_KEY")
    if not secret:
        logger.critical("Missing required SECRET_KEY environment variable for motofix-dispatch-service")
        raise RuntimeError(
            "Missing required SECRET_KEY environment variable for motofix-dispatch-service. "
            "This service must fail loudly instead of accepting unsigned tokens."
        )
    return secret


SECRET_KEY = os.getenv("SECRET_KEY")

# Database pool
pool: Optional[asyncpg.Pool] = None
db_error: Optional[str] = None
_watchdog_task: Optional[asyncio.Task] = None


async def run_migrations(db_pool: asyncpg.Pool):
    """Run idempotent startup migrations - creates tables if they don't exist."""
    logger.info("🔧 Running startup migrations...")
    async with db_pool.acquire() as conn:
        try:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS service_requests (
                    id SERIAL PRIMARY KEY,
                    customer_name TEXT NOT NULL DEFAULT '',
                    service_type TEXT NOT NULL DEFAULT 'Other',
                    location TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    phone TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT NOW()
                );
            """)
            logger.info("✅ service_requests table ensured")

            await conn.execute("""
                CREATE TABLE IF NOT EXISTS media_files (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
                    file_url TEXT NOT NULL,
                    file_type TEXT NOT NULL,
                    file_name TEXT NOT NULL DEFAULT '',
                    size_kb FLOAT NOT NULL DEFAULT 0,
                    uploaded_at TIMESTAMP DEFAULT NOW()
                );
            """)
            logger.info("✅ media_files table ensured")

            # In-job chat: persisted so messages survive refresh and reach the
            # other party even if they were offline when it was sent.
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER NOT NULL,
                    sender_role TEXT NOT NULL,            -- 'driver' | 'mechanic'
                    sender_id TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL DEFAULT '',
                    media_type TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'voice' | 'image'
                    media_url TEXT NULL,
                    seen_by_driver BOOLEAN NOT NULL DEFAULT FALSE,
                    seen_by_mechanic BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            """)
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chat_messages_request ON chat_messages(request_id)"
            )
            logger.info("✅ chat_messages table ensured")

            # Cancellation metadata — who cancelled and why.
            await conn.execute("ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS cancelled_by TEXT")
            await conn.execute("ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT")

            # Mechanic cancellation "strikes" — consecutive cancellations of jobs they
            # had already picked up. Reset to 0 whenever they complete a job. Three in
            # a row suspends them (a penalty to protect MOTOFIX's reputation).
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS mechanic_strikes (
                    mechanic_id INTEGER PRIMARY KEY,
                    strikes INTEGER NOT NULL DEFAULT 0,
                    suspended BOOLEAN NOT NULL DEFAULT FALSE,
                    suspended_at TIMESTAMP NULL,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            # How many times this mechanic has been suspended — preserved across
            # reinstatements so repeat offenders can be escalated.
            await conn.execute("ALTER TABLE mechanic_strikes ADD COLUMN IF NOT EXISTS suspension_count INTEGER NOT NULL DEFAULT 0")
            logger.info("✅ cancellation columns + mechanic_strikes table ensured")

            # Platform fee ledger — MOTOFIX's revenue. Each COMPLETED job a mechanic
            # earns through the platform accrues a flat UGX 10,000 fee they owe the
            # platform (this replaces the old monthly subscription). One row per job
            # (request_id UNIQUE → idempotent). The mechanic settles the balance; at a
            # cap of unpaid jobs they're gated from accepting new work, and after a
            # grace window an unsettled balance hard-locks the account.
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS platform_fees (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER UNIQUE NOT NULL,
                    mechanic_id INTEGER NOT NULL,
                    amount INTEGER NOT NULL DEFAULT 10000,
                    status VARCHAR(10) NOT NULL DEFAULT 'owed',
                    created_at TIMESTAMP DEFAULT NOW(),
                    paid_at TIMESTAMP NULL,
                    payment_ref VARCHAR NULL
                );
            """)
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_platform_fees_mech ON platform_fees (mechanic_id, status)")
            logger.info("✅ platform_fees ledger ensured")

            # One-time cleanup so no mechanic owes more than the 3-job cap. Older test
            # runs let the unpaid balance climb past 3 (e.g. a mechanic showing 7 owed);
            # here we keep each mechanic's 3 OLDEST unpaid fees and mark the rest 'waived'
            # (kept for audit, not deleted). Harmless to re-run: once everyone is within
            # the cap this updates nothing. Going forward, _accrue_platform_fee never lets
            # the count exceed 3 in the first place.
            capped = await conn.execute("""
                WITH ranked AS (
                    SELECT id,
                           ROW_NUMBER() OVER (PARTITION BY mechanic_id
                                              ORDER BY created_at ASC, id ASC) AS rn
                    FROM platform_fees
                    WHERE status = 'owed'
                )
                UPDATE platform_fees SET status = 'waived'
                WHERE id IN (SELECT id FROM ranked WHERE rn > 3)
            """)
            logger.info("✅ platform_fees capped to 3 unpaid per mechanic (%s)", capped)

            await conn.execute("""
                CREATE TABLE IF NOT EXISTS job_acceptances (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER UNIQUE NOT NULL,
                    mechanic_id INTEGER NOT NULL,
                    mechanic_name TEXT NOT NULL,
                    accepted_at TIMESTAMP DEFAULT NOW(),
                    eta_minutes INTEGER NULL
                );
            """)
            logger.info("✅ job_acceptances table ensured")

            await conn.execute("""
                CREATE TABLE IF NOT EXISTS payments (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER REFERENCES service_requests(id),
                    mechanic_id INTEGER,
                    driver_phone VARCHAR,
                    mechanic_phone VARCHAR,
                    quoted_amount INTEGER,
                    commission INTEGER DEFAULT 10000,
                    mechanic_payout INTEGER,
                    quote_approved BOOLEAN DEFAULT FALSE,
                    collection_reference VARCHAR,
                    disbursement_reference VARCHAR,
                    collection_status VARCHAR DEFAULT 'pending',
                    disbursement_status VARCHAR DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT NOW()
                );
            """)
            logger.info("✅ payments table ensured")

            await conn.execute("""
                ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'mtn';
            """)
            logger.info("✅ payments.provider column ensured")

            await conn.execute("""
                CREATE TABLE IF NOT EXISTS feature_flags (
                    key TEXT PRIMARY KEY,
                    enabled BOOLEAN NOT NULL DEFAULT FALSE,
                    description TEXT,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            logger.info("✅ feature_flags table ensured")

            # Seed variant-specific defaults so both `main` and `fyp` can share one DB.
            # Render should set `SERVICE_VARIANT=main` or `SERVICE_VARIANT=fyp`.
            await conn.execute("""
                INSERT INTO feature_flags (key, enabled, description)
                VALUES ('payments_main', FALSE, 'Payments disabled in main')
                ON CONFLICT (key) DO NOTHING
            """)
            await conn.execute("""
                INSERT INTO feature_flags (key, enabled, description)
                VALUES ('payments_fyp', TRUE, 'Payments enabled in fyp')
                ON CONFLICT (key) DO NOTHING
            """)

            # Add user_id and mechanic_id columns to service_requests if missing
            # Note: no cross-DB FK references (microservices — each service owns its own DB)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS user_id INTEGER
            """)
            logger.info("✅ service_requests.user_id column ensured")

            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS mechanic_id INTEGER
            """)
            logger.info("✅ service_requests.mechanic_id column ensured")

            # Final bill the mechanic enters at completion: the charge + what was fixed
            # (the tickable AI fix list, joined). Shown to the driver as the pay breakdown.
            await conn.execute("ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS actual_fee INTEGER NULL")
            await conn.execute("ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS service_note TEXT NULL")
            logger.info("✅ service_requests.actual_fee + service_note columns ensured")

            # Job lifecycle timestamps (analytics + tracking)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS service_started_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            """)
            # ETA (minutes) the mechanic estimated when starting the journey — used to
            # show a shared arrival-time window on both the driver and mechanic apps.
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS eta_minutes INTEGER NULL
            """)
            # Completion handshake: when awaiting_confirmation started + who initiated it
            # ('mechanic' or 'driver'). The OTHER party confirms; a background task
            # auto-completes if no-one confirms within the grace period.
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS awaiting_confirmation_at TIMESTAMP NULL
            """)
            await conn.execute("""
                ALTER TABLE service_requests
                ADD COLUMN IF NOT EXISTS completion_by VARCHAR(16) NULL
            """)
            logger.info("✅ service_requests lifecycle timestamp columns ensured")

            # ── v1 request model columns (area-based, no GPS required) ──────────────
            # Canonical fields for the simplified v1 request. All idempotent so they are
            # safe to run against older deployments. lat/lng stay nullable — area_id and
            # location_text are the primary location inputs.
            for col_sql in [
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS issue_type TEXT NOT NULL DEFAULT 'general'",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS area_id INTEGER",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS location_text TEXT",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS matched_mechanic_id INTEGER",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS matched_mechanic_name TEXT",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS matched_mechanic_phone TEXT",
                "ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP",
            ]:
                await conn.execute(col_sql)
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_service_requests_driver_active "
                "ON service_requests (user_id, created_at DESC) "
                "WHERE status NOT IN ('completed', 'cancelled')"
            )
            logger.info("✅ v1 request model columns ensured")

            # Reviews and ratings table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS reviews (
                    id           SERIAL PRIMARY KEY,
                    request_id   INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
                    mechanic_id  INTEGER NOT NULL,
                    reviewer_id  INTEGER NOT NULL,
                    rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
                    comment      TEXT DEFAULT '',
                    direction    VARCHAR NOT NULL DEFAULT 'driver_to_mechanic',
                    created_at   TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(request_id, direction)
                )
            """)
            # Migrate existing table: add direction column + swap unique constraint
            await conn.execute("ALTER TABLE reviews ADD COLUMN IF NOT EXISTS direction VARCHAR NOT NULL DEFAULT 'driver_to_mechanic'")
            await conn.execute("ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_request_id_key")
            await conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_req_dir ON reviews(request_id, direction)")
            logger.info("✅ reviews table ensured")

            # Spare parts dealer directory
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS spare_parts_dealers (
                    id          SERIAL PRIMARY KEY,
                    name        TEXT NOT NULL,
                    phone       TEXT NOT NULL,
                    address     TEXT NOT NULL DEFAULT '',
                    location    TEXT NOT NULL DEFAULT '',
                    latitude    DOUBLE PRECISION,
                    longitude   DOUBLE PRECISION,
                    specialty   TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    verified    BOOLEAN NOT NULL DEFAULT FALSE,
                    active      BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at  TIMESTAMPTZ DEFAULT NOW(),
                    updated_at  TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            logger.info("✅ spare_parts_dealers table ensured")

            # Seed a simulated dealer directory the first time so the driver and
            # mechanic apps always have real businesses to show. Idempotent — only
            # runs while the table is empty; admins can then add/edit their own.
            dealer_count = await conn.fetchval("SELECT COUNT(*) FROM spare_parts_dealers")
            if not dealer_count:
                seed_dealers = [
                    ("Kisekka Market Auto Spares", "+256 700 100 201", "Kisekka Market, Central, Kampala", "Kisekka Market", 0.3136, 32.5736, "Engine, electrical & filters", "Genuine & OEM parts for most makes. Same-day delivery within Kampala."),
                    ("Ndeeba Spare Parts Centre",  "+256 700 100 202", "Ndeeba, off Masaka Rd, Kampala", "Ndeeba",        0.2906, 32.5606, "Body panels & suspension",    "Body, suspension and steering specialists."),
                    ("Nakawa Motor Spares",        "+256 700 100 203", "Nakawa Motor Village, Kampala", "Nakawa",         0.3289, 32.6186, "Tyres, batteries & belts",    "Open 24 hours. Tyres, batteries, belts and fast-moving parts."),
                    ("Bwaise Auto Parts & Tools",  "+256 700 100 204", "Bwaise, Bombo Rd, Kampala",     "Bwaise",         0.3556, 32.5644, "Tools & general spares",      "Workshop tools and general spares at fair prices."),
                    ("Kireka Car Accessories",     "+256 700 100 205", "Kireka, Jinja Rd, Kampala",     "Kireka",         0.3494, 32.6519, "Accessories & lighting",      "Car accessories, lighting and in-car electronics."),
                    ("Lubowa Genuine Parts",       "+256 700 100 206", "Lubowa, Entebbe Rd, Wakiso",    "Lubowa",         0.2353, 32.5419, "Genuine OEM parts",           "Dealer-grade genuine parts with warranty."),
                    ("Ntinda Auto Spares",         "+256 700 100 207", "Ntinda Stretcher Rd, Kampala",  "Ntinda",         0.3553, 32.6119, "Filters, fluids & service parts", "Service parts, filters and fluids for routine maintenance."),
                    ("Industrial Area Parts Hub",  "+256 700 100 208", "7th Street, Industrial Area, Kampala", "Industrial Area", 0.3119, 32.6019, "Engine & transmission", "Engines, gearboxes and reconditioned units (half-cuts)."),
                ]
                await conn.executemany(
                    """INSERT INTO spare_parts_dealers
                         (name, phone, address, location, latitude, longitude, specialty, description, verified)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)""",
                    seed_dealers,
                )
                logger.info("✅ Seeded %d simulated spare-parts dealers", len(seed_dealers))

            # NOTE: Avoid destructive schema changes by default.
            # Dropping legacy tables can break another deployment that still needs the data.
            if os.getenv("ALLOW_DESTRUCTIVE_MIGRATIONS", "false").lower() in ("1", "true", "yes"):
                await conn.execute("DROP TABLE IF EXISTS requests CASCADE")
                logger.info("✅ Legacy requests table dropped (destructive mode)")

            logger.info("✅ All startup migrations completed")
        except Exception as e:
            logger.error(f"❌ Migration failed: {e}", exc_info=True)


async def _completion_watchdog():
    """Server-side safety net so no job ever hangs because a phone is closed:
       • awaiting_confirmation for >30 min → auto-complete
       • service_started untouched for >6 h → start the completion handshake
    """
    # Runs forever in the background. Every 60 seconds it wakes up, checks the
    # database for "stuck" jobs, nudges them along, and goes back to sleep.
    while True:
        try:
            await asyncio.sleep(60)
            if not pool:
                continue
            async with pool.acquire() as conn:
                done = await conn.fetch("""
                    UPDATE service_requests
                    SET status='completed', completed_at=COALESCE(completed_at, NOW())
                    WHERE status='awaiting_confirmation'
                      AND awaiting_confirmation_at IS NOT NULL
                      AND awaiting_confirmation_at < NOW() - INTERVAL '30 minutes'
                    RETURNING id
                """)
                for r in done:
                    await manager.broadcast({
                        "type": "status_update", "job_id": r["id"],
                        "status": "completed", "auto": True,
                        "updated_at": datetime.utcnow().isoformat() + "Z",
                    })
                    logger.info("⏲ Auto-completed job %s — no confirmation within 30 min", r["id"])

                stale = await conn.fetch("""
                    UPDATE service_requests
                    SET status='awaiting_confirmation',
                        awaiting_confirmation_at=NOW(),
                        completion_by='system'
                    WHERE status='service_started'
                      AND service_started_at IS NOT NULL
                      AND service_started_at < NOW() - INTERVAL '6 hours'
                    RETURNING id
                """)
                for r in stale:
                    await manager.broadcast({
                        "type": "status_update", "job_id": r["id"],
                        "status": "awaiting_confirmation", "auto": True,
                        "updated_at": datetime.utcnow().isoformat() + "Z",
                    })
                    logger.info("⏲ Job %s in service >6h — moved to awaiting_confirmation", r["id"])
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("completion watchdog error: %s", exc)


async def _connect_with_retry():
    """Create the DB pool, retrying forever with capped backoff.

    Runs in the background so startup never blocks and — crucially — a Postgres
    that is slow or still in recovery ("the database system is starting up")
    can't strand the service in degraded mode permanently. We keep retrying until
    the DB is ready, so the service self-heals without a manual restart.
    """
    global pool, db_error, _watchdog_task
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        db_error = "DATABASE_URL environment variable is not set"
        logger.error(f"❌ {db_error}")
        logger.warning("⚠️  Starting in degraded mode - DB operations will fail gracefully")
        return

    logger.info(f"🔗 Attempting to connect to database: {dsn[:50]}...")
    delay = 2
    attempt = 0
    while pool is None:
        attempt += 1
        new_pool = None
        try:
            new_pool = await asyncpg.create_pool(dsn=dsn, min_size=2, max_size=10, command_timeout=10)
            # Run startup migrations BEFORE publishing the pool, so once `pool` is
            # set the schema is guaranteed ready for request handlers.
            await run_migrations(new_pool)
            pool = new_pool
            db_error = None
            logger.info(f"✅ Database pool created successfully (attempt {attempt})")
            # Start the completion safety-net watchdog now that the DB is up.
            _watchdog_task = asyncio.create_task(_completion_watchdog())
            return
        except Exception as e:
            db_error = str(e)
            if new_pool is not None:
                await new_pool.close()  # don't leak a half-initialised pool
            logger.warning(f"⚠️  DB connection failed (attempt {attempt}): {e}. Retrying in {delay}s...")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool, _watchdog_task
    _require_secret()
    # Connect in the background so a slow / recovering Postgres can't permanently
    # leave us in degraded mode (see _connect_with_retry). Requests that arrive
    # before the DB is ready still fail gracefully with 503 via get_db().
    connect_task = asyncio.create_task(_connect_with_retry())

    yield

    connect_task.cancel()
    if _watchdog_task:
        _watchdog_task.cancel()
    if pool:
        await pool.close()
        logger.info("✅ Database pool closed")

app = FastAPI(
    title="MOTOFIX - Request and Dispatch Management Service",
    version="1.0.0",
    description="Core API for creating and managing breakdown service requests with media support",
    lifespan=lifespan
)

# Serve locally-stored media (the LocalStorage fallback writes here). Mounted early
# so it isn't shadowed by the catch-all "/" frontend mount registered at the end.
_MEDIA_DIR = os.getenv("MEDIA_DIR", "/app/media")
try:
    os.makedirs(_MEDIA_DIR, exist_ok=True)
    app.mount("/media", StaticFiles(directory=_MEDIA_DIR), name="media")
except Exception as _e:  # pragma: no cover
    logging.getLogger(__name__).warning("Could not mount /media: %s", _e)

# ════════════════════════════════ CORS ════════════════════════════════
from fastapi.middleware.cors import CORSMiddleware

ALLOWED_ORIGINS = [
    "https://motofixug.netlify.app",
    "https://motofix-driver-assist.onrender.com",
    "https://motofixug.onrender.com",
    "https://admin.motofix.org",
    "https://motofix.org",
    "https://motofix-mechanic-connect.onrender.com",
    "https://motofix-admin-dashboard.onrender.com",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:8083",
    "http://localhost:8084",
    "http://localhost:8087",
    "http://localhost:8090",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8090",
    "http://192.168.1.3:8090",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
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

# ────────────────────────────── REVERSE GEOCODING (GOOGLE MAPS PROXY) ──────────────────────────────

# In-memory geocode cache: key → (result_dict, expires_at)
# A street address for a coordinate doesn't change, so we cache SUCCESSES for hours —
# this is what stops the apps' constant polling from re-hammering Google and saturating
# the single worker's event loop (which was delaying job-accept/cancel responses past the
# client's 30s timeout). Failures are cached only briefly so we retry Google soon after a
# transient network blip.
_geocode_cache: dict = {}
_GEOCODE_TTL = 6 * 3600   # 6 hours for a successful address lookup
_GEOCODE_FAIL_TTL = 60    # 60 s for a coordinate fallback (so we retry Google soon)
_GEOCODE_KEY_PRECISION = 4  # ~11 m


def _geocode_cache_key(lat: float, lon: float) -> str:
    return f"{round(lat, _GEOCODE_KEY_PRECISION)},{round(lon, _GEOCODE_KEY_PRECISION)}"


@app.get("/geocode/reverse")
async def reverse_geocode(lat: float, lon: float):
    cache_key = _geocode_cache_key(lat, lon)
    cached = _geocode_cache.get(cache_key)
    if cached and time.time() < cached[1]:
        return cached[0]

    # The apps poll for addresses constantly, so this endpoint must NEVER hang or 500.
    # Previously it used a 10s timeout and no error handling: when the network to Google
    # was flaky, calls piled up (each hanging ~10s, throwing UNHANDLED errors), saturated
    # the backend, and delayed unrelated requests like job-accept. Now we fail fast, fall
    # back to showing the coordinates, and cache the fallback too (negative cache) so we
    # don't re-hammer Google on every poll.
    fallback = {"display_name": f"{round(lat, 5)}, {round(lon, 5)}", "lat": lat, "lon": lon}

    api_key = os.getenv("GOOGLE_GEOCODING_API_KEY")
    if not api_key:
        _geocode_cache[cache_key] = (fallback, time.time() + _GEOCODE_FAIL_TTL)
        return fallback

    try:
        # Tight timeouts (2s connect / 4s total) — fail fast instead of holding a slot.
        timeout = httpx.Timeout(4.0, connect=2.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"latlng": f"{lat},{lon}", "key": api_key},
            )
        data = response.json()
        results = data.get("results", []) if data.get("status") == "OK" else []
        if results:
            result = {
                "display_name": results[0].get("formatted_address", "") or fallback["display_name"],
                "lat": lat,
                "lon": lon,
            }
            _geocode_cache[cache_key] = (result, time.time() + _GEOCODE_TTL)
            return result
    except Exception as exc:
        logger.warning("Reverse geocode failed for %s,%s — using coordinates: %s", lat, lon, exc)

    # Google unreachable, returned no result, or errored — briefly cache + return fallback.
    _geocode_cache[cache_key] = (fallback, time.time() + _GEOCODE_FAIL_TTL)
    return fallback

# ────────────────────────────── HEALTH CHECK ENDPOINTS ──────────────────────────────

@app.get("/health")
async def health_check():
    """Health check endpoint - responds even if DB is down"""
    return {
        "status": "ok",
        "service": "motofix-dispatch-service",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "database": "connected" if pool else "disconnected",
        "jwt_secret_configured": bool(os.getenv("SECRET_KEY")),
    }


@app.get("/health-db")
async def health_check_db():
    """Database health check - returns 503 if DB is unavailable"""
    try:
        if not pool:
            raise HTTPException(status_code=503, detail="Database pool not initialized")
        
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        
        return {
            "status": "ok",
            "service": "motofix-dispatch-service",
            "database": "connected",
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DB health check failed: {e}")
        raise HTTPException(status_code=503, detail="Database health check failed")

# ────────────────────────────── DEPENDENCIES ──────────────────────────────
async def get_db():
    """Get database connection, raises HTTPException if DB is unavailable"""
    if pool is None:
        logger.error(f"🔴 DB pool is None. Reason: {db_error or 'Unknown'}")
        raise HTTPException(
            status_code=503,
            detail=f"Database service unavailable: {db_error or 'Connection pool not initialized'}"
        )

    # Acquire connection — only this step is wrapped; query errors must propagate naturally
    try:
        conn = await pool.acquire()
    except Exception as e:
        logger.error(f"🔴 pool.acquire() failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail="Database service temporarily unavailable. Please try again."
        )

    try:
        yield conn
    except Exception:
        raise
    finally:
        await pool.release(conn)

async def is_feature_enabled(db: asyncpg.Connection, feature_key: str, default: bool = False) -> bool:
    """
    Checks DB-backed feature flags.

    For safe shared-DB deployments, we support variant-specific keys:
      - if `SERVICE_VARIANT=fyp`, `payments` reads `payments_fyp` first
      - if that key doesn't exist, it falls back to `payments`
    """
    variant = os.getenv("SERVICE_VARIANT", "").strip()
    keys_to_try: list[str] = []

    if variant:
        keys_to_try.append(f"{feature_key}_{variant}")
    keys_to_try.append(feature_key)

    for key in keys_to_try:
        row = await db.fetchrow(
            "SELECT enabled FROM feature_flags WHERE key = $1",
            key,
        )
        if row is not None:
            return bool(row["enabled"])

    return default

# ═══════════════════════════════ FEATURE FLAGS ═══════════════════════════════
@app.get("/feature-flags")
async def feature_flags(db=Depends(get_db)):
    payments_enabled = await is_feature_enabled(db, "payments", default=False)
    return {
        "service_variant": os.getenv("SERVICE_VARIANT", None),
        "payments": payments_enabled,
    }

async def get_current_user(request: Request, db=Depends(get_db)) -> Dict:
    """
    Verify JWT token and return authenticated user.
    Reuses same JWT secret/algorithm as auth service.
    """
    token = None
    auth_header = request.headers.get("authorization")
    
    if auth_header and auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        logger.debug(f"✅ Bearer token found in Authorization header")
    else:
        token = request.cookies.get("access_token")
        if token:
            logger.debug(f"ℹ️ Using token from httpOnly cookie")
    
    if not token:
        logger.error("❌ No token found in request")
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    secret_key = _require_secret()

    algorithm = os.getenv("ALGORITHM", "HS256")

    # Try mechanic secret first, then driver secret (motofix-auth-service may use a different key)
    driver_secret = os.getenv("DRIVER_SECRET_KEY", secret_key)
    secrets_to_try = list(dict.fromkeys([secret_key, driver_secret]))  # dedup, preserve order

    payload = None
    for secret in secrets_to_try:
        try:
            payload = jwt.decode(token, secret, algorithms=[algorithm])
            break
        except JWTError:
            continue

    try:
        if payload is None:
            raise JWTError("All secrets exhausted")
        user_id: str = payload.get("sub")
        user_role: str = payload.get("role", "driver")

        if not user_id:
            logger.error("❌ Token missing 'sub' claim")
            raise HTTPException(status_code=401, detail="Invalid token")

        logger.debug(f"✅ Token decoded successfully for user_id: {user_id}, role: {user_role}")

        # Route to the correct table based on role claim in the JWT.
        # Querying users first then mechanics is wrong: IDs overlap across tables.
        # Phone may be baked into the JWT claim (preferred) or looked up from the DB
        jwt_phone: str | None = payload.get("phone")

        # Service providers — mechanics, tow providers, and "both" — all handle a job the
        # SAME way here, so dispatch treats them as one job-handling party (role normalised
        # to "mechanic" internally). This is the single change that unblocks tow providers:
        # every job endpoint below checks role == "mechanic", so without this a tow provider
        # gets "Only mechanics can accept jobs".
        # IMPORTANT: this does NOT let a tow provider grab a repair job. WHICH provider is
        # offered WHICH job (a tow provider never receives a pure repair) is decided by the
        # matching service from each provider's capabilities — not from this role claim.
        if user_role in ("mechanic", "towing_provider", "both"):
            # Only real mechanics live in the mechanics table — enrich the phone from it when
            # we can. Tow providers are in a separate table, so for them (and as a fallback)
            # we trust the JWT phone, and never look up by id across tables (ids overlap and
            # would resolve to the wrong person).
            if user_role == "mechanic":
                try:
                    mech_row = await db.fetchrow(
                        "SELECT id, phone FROM mechanics WHERE id = $1", int(user_id)
                    )
                    if mech_row:
                        return {"id": mech_row["id"], "role": "mechanic", "phone": mech_row["phone"]}
                except Exception as e:
                    logger.warning(f"⚠️ Could not fetch from mechanics table: {e}")
            return {"id": int(user_id), "role": "mechanic", "phone": jwt_phone}
        else:
            # Use JWT phone if present — avoids dependency on a users table in this DB
            if jwt_phone:
                return {"id": int(user_id), "role": user_role, "phone": jwt_phone}
            try:
                user_row = await db.fetchrow(
                    "SELECT id, phone, full_name, role FROM users WHERE id = $1", int(user_id)
                )
                if user_row:
                    return dict(user_row)
            except Exception as e:
                logger.warning(f"⚠️ Could not fetch from users table: {e}")
            return {"id": int(user_id), "role": user_role, "phone": None}
        
    except JWTError as e:
        logger.error(f"❌ JWT decode failed: {str(e)}")
        raise HTTPException(status_code=401, detail="Invalid token")

# ────────────────────────────── MODELS ──────────────────────────────
class MediaFile(BaseModel):
    url: str
    file_type: str  # "voice", "photo", "document"
    size_kb: float
    uploaded_at: str


def _media_rows_to_list(rows) -> list:
    """Normalise DB media rows for the API: coerce the datetime uploaded_at to an
    ISO string so it validates against MediaFile.uploaded_at (str)."""
    out = []
    for m in rows or []:
        d = dict(m)
        ua = d.get("uploaded_at")
        if ua is not None and not isinstance(ua, str):
            d["uploaded_at"] = ua.isoformat()
        out.append(d)
    return out

class RequestCreate(BaseModel):
    customer_name: str = ""
    service_type: str
    # v1 canonical fields (area-based, no GPS required)
    issue_type: Optional[str] = None          # defaults to "general" when missing
    description: Optional[str] = None
    area_id: Optional[int] = None             # integer launch-area id (e.g. 15 = Ntinda)
    location_text: Optional[str] = None       # human-readable place name / landmark
    latitude: Optional[float] = None          # optional — not required for create
    longitude: Optional[float] = None         # optional — not required for create
    # legacy fields (kept for backward compatibility)
    location: str = ""                        # legacy "lat,lng" string
    phone: str = ""
    preferred_mechanic_id: Optional[int] = None

class RequestOut(BaseModel):
    id: str
    customer_name: str
    service_type: str
    location: str
    description: Optional[str] = None
    # phone field EXCLUDED - never returned in normal responses
    status: str = "searching"
    media_files: Optional[List[MediaFile]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    user_id: Optional[int] = None
    driver_id: Optional[int] = None
    mechanic_id: Optional[int] = None
    dispatched_at: Optional[str] = None
    accepted_at: Optional[str] = None
    en_route_at: Optional[str] = None
    arrived_at: Optional[str] = None
    service_started_at: Optional[str] = None
    completed_at: Optional[str] = None
    # The mechanic's final charge + what-was-fixed note, set when they mark the job
    # done. Surfaced so the driver can review the agreed figure before confirming,
    # and so it shows in the request details across all three apps.
    eta_minutes: Optional[int] = None
    completion_by: Optional[str] = None
    actual_fee: Optional[int] = None
    service_note: Optional[str] = None
    # v1 canonical fields
    issue_type: Optional[str] = None
    area_id: Optional[int] = None
    location_text: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    matched_mechanic_id: Optional[int] = None
    matched_mechanic_name: Optional[str] = None
    matched_mechanic_phone: Optional[str] = None
    cancelled_at: Optional[str] = None
    workflow_status: Optional[str] = None

class CallPartnerResponse(BaseModel):
    phone: str  # Only returned from secure /call-partner endpoint


def _canonical_driver_status(status: Optional[str]) -> str:
    """Expose the v1 four-state request lifecycle to drivers while preserving provider workflow."""
    value = (status or "searching").lower()
    if value in ("pending", "searching"):
        return "searching"
    if value in ("completed", "cancelled"):
        return value
    return "assigned"


def _request_response_data(row, *, driver_view: bool = False, media_files=None) -> dict:
    data = dict(row)
    workflow_status = data.get("status") or "searching"
    data["id"] = str(data["id"])
    data["driver_id"] = data.get("user_id")
    data.pop("phone", None)
    data["description"] = (data.get("description") or "").strip() or None
    if driver_view:
        data["workflow_status"] = workflow_status
        data["status"] = _canonical_driver_status(workflow_status)
        data["mechanic_name"] = data.get("matched_mechanic_name")
    for key in (
        "created_at", "updated_at", "dispatched_at", "accepted_at",
        "en_route_at", "arrived_at", "service_started_at", "completed_at",
        "cancelled_at",
    ):
        value = data.get(key)
        if value is not None and not isinstance(value, str):
            data[key] = value.isoformat()
    if media_files is not None:
        data["media_files"] = media_files
    return data

# ────────────────────────────── ENDPOINTS ──────────────────────────────

# ────────────────────────────── WebSocket / Real-time support ──────────────────────────────
from datetime import timedelta
from typing import Dict, Any

class ConnectionManager:
    """Simple WebSocket connection manager for broadcasting events to all connected clients.

    A WebSocket is an open, two-way phone line between the server and an app (unlike a
    normal request that hangs up after one reply). We keep a list of every connected
    app here; when something happens (a job is taken, the mechanic moves on the map,
    a chat message is sent), broadcast() pushes it to all of them instantly so screens
    update live without the apps having to keep asking "anything new?".
    """
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"🔌 WebSocket client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        try:
            self.active_connections.remove(websocket)
        except ValueError:
            pass
        logger.info(f"❎ WebSocket client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: Dict[str, Any]):
        # Push a JSON event to every connected client. Sends run CONCURRENTLY, each
        # with a short timeout, so a single dead/zombie socket (e.g. a client whose
        # laptop slept or whose tab closed without a clean disconnect) can't block the
        # others — or the HTTP request that triggered this broadcast.
        #
        # Previously these awaits ran one-by-one with no timeout: a half-open socket
        # would stall on send for up to ~60s (the OS TCP timeout) before erroring, which
        # hung accept/cancel/status calls and left the driver and mechanic apps out of
        # sync. Dead sockets are still cleaned up.
        conns = list(self.active_connections)
        if not conns:
            return

        async def _send(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_json(message), timeout=3)
                return None
            except Exception:
                return ws  # mark for cleanup

        dead = await asyncio.gather(*(_send(ws) for ws in conns))
        for ws in dead:
            if ws is not None:
                self.disconnect(ws)

manager = ConnectionManager()

# Holds references to fire-and-forget background tasks (notifications etc.) so the event
# loop doesn't garbage-collect them mid-flight. Tasks remove themselves when done.
_bg_tasks: set = set()


def _spawn_bg(coro) -> None:
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)


# ── Matching-service helpers ──────────────────────────────────────────────────

def _parse_latlong(location: str):
    """Return (lat, lng) floats if location is 'lat,lng', else None."""
    parts = location.split(",", 1)
    if len(parts) == 2:
        try:
            lat, lng = float(parts[0].strip()), float(parts[1].strip())
            if -90 <= lat <= 90 and -180 <= lng <= 180 and (lat != 0 or lng != 0):
                return lat, lng
        except ValueError:
            pass
    return None


def _service_token() -> str:
    """Create a short-lived JWT for service-to-service calls (same SECRET_KEY)."""
    from datetime import timezone, timedelta
    secret = os.getenv("SECRET_KEY", "")
    algo   = os.getenv("ALGORITHM", "HS256")
    exp    = datetime.now(timezone.utc) + timedelta(hours=1)
    return jwt.encode({"sub": "dispatch-service", "role": "service", "exp": exp}, secret, algorithm=algo)


async def _dispatch_to_matched_mechanics(
    request_id: int,
    location: str,
    service_type: str,
    notifications_url: str,
    job_data: dict,
    preferred_mechanic_id: Optional[int] = None,
    area_id: Optional[int] = None,
) -> None:
    """
    Background task: call the matching service, get top-ranked mechanics,
    and send targeted FCM push to each one that has a registered FCM token.
    Falls back gracefully on any error — never blocks the main response.

    v1: supports area-based matching — when there are no GPS coordinates we pass
    `area_id` + `service_type` so matching works without the driver's location.
    """
    coords = _parse_latlong(location)
    if not coords and area_id is None:
        logger.info("Matching unavailable for request %s — no coordinates or area_id", request_id)
        await manager.broadcast({
            "type": "matching_empty",
            "request_id": str(request_id),
        })
        return

    matching_url = os.getenv("MATCHING_SERVICE_URL", "http://127.0.0.1:8003").rstrip("/")

    try:
        token = _service_token()
        match_body: dict = {
            "request_id": request_id,
            "service_type": service_type,
            "preferred_mechanic_id": preferred_mechanic_id,
            "top_n": 10,
        }
        if coords:
            lat, lng = coords
            match_body["latitude"] = lat
            match_body["longitude"] = lng
        if area_id is not None:
            match_body["area_id"] = area_id

        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.post(
                f"{matching_url}/match",
                headers={"Authorization": f"Bearer {token}"},
                json=match_body,
            )
            resp.raise_for_status()
            payload = resp.json()
            candidates = payload.get("candidates", []) if isinstance(payload, dict) else []
            if not isinstance(candidates, list):
                logger.warning(
                    "Matching service returned an invalid candidates list for request %s",
                    request_id,
                )
                return
            if not candidates:
                logger.info("Matching service found no eligible mechanics for request %s", request_id)
                await manager.broadcast({
                    "type": "matching_empty",
                    "request_id": str(request_id),
                })
                return
            if not all(isinstance(candidate, dict) for candidate in candidates):
                logger.warning(
                    "Matching service returned malformed candidates for request %s",
                    request_id,
                )
                return
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:300]
        if exc.response.status_code == 404:
            logger.info("Matching found no eligible mechanics for request %s: %s", request_id, detail)
            await manager.broadcast({
                "type": "matching_empty",
                "request_id": str(request_id),
            })
            return
        logger.warning(
            "Matching service returned HTTP %s for request %s: %s",
            exc.response.status_code,
            request_id,
            detail,
        )
        return
    except Exception as exc:
        logger.warning("Matching service unreachable for request %s: %s", request_id, exc)
        return

    mechanic_tokens = [c["fcm_token"] for c in candidates if c.get("fcm_token")]
    if not mechanic_tokens:
        logger.debug("No FCM tokens in matching response for request %s", request_id)
        return

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{notifications_url}/notify/push/bulk",
                json={
                    "device_tokens": mechanic_tokens,
                    "title": "New Job Available",
                    "body": f"{service_type} — {location[:60]}" if location else f"{service_type} — new request",
                    "data": {
                        "request_id": str(request_id),
                        "type": "new_job",
                        "service_type": service_type,
                    },
                },
            )
        logger.info(
            "FCM push sent to %d matched mechanics for request %s",
            len(mechanic_tokens), request_id,
        )
    except Exception as exc:
        logger.warning("FCM bulk push failed for request %s: %s", request_id, exc)


@app.websocket("/ws/jobs")
async def jobs_ws(websocket: WebSocket):
    """WebSocket endpoint for real-time job events and in-job chat.
    Broadcasts: 'new_job', 'job_taken', 'status_update', 'chat_message', 'location_update', 'price_quote', 'quote_approved'.
    Clients send JSON; relayed message types are forwarded to all connected clients.
    """
    _RELAY_TYPES = {"chat_message", "chat_typing", "chat_seen", "location_update", "price_quote", "quote_approved", "payment_completed", "payment_ack"}
    await manager.connect(websocket)
    try:
        while True:
            try:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                    if msg.get("type") in _RELAY_TYPES:
                        await manager.broadcast(msg)
                except (json.JSONDecodeError, AttributeError):
                    pass  # plain-text pings — ignore
            except WebSocketDisconnect:
                break
            except Exception:
                await asyncio.sleep(0.1)
    finally:
        manager.disconnect(websocket)


# Helper: ensure job_acceptances table exists (safe to call idempotently)
async def ensure_acceptances_table(db: asyncpg.Connection):
    try:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS job_acceptances (
                id SERIAL PRIMARY KEY,
                request_id INTEGER UNIQUE NOT NULL,
                mechanic_id INTEGER NOT NULL,
                mechanic_name TEXT NOT NULL,
                accepted_at TIMESTAMP DEFAULT NOW(),
                eta_minutes INTEGER NULL
            );
            """
        )
        logger.info("✅ job_acceptances table ensured")
    except Exception as e:
        logger.error(f"Failed to ensure job_acceptances table: {e}")

# ────────────────────────────── ENDPOINTS ──────────────────────────────

@app.post("/requests/", response_model=RequestOut)
async def create_request(
    payload: RequestCreate,
    background_tasks: BackgroundTasks,
    user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Create a request (v1) — area-based, no GPS required.

    Required: service_type + (area_id OR location_text).
    Optional: issue_type (defaults to "general"), description, latitude/longitude.
    """
    logger.info("🟢 POST /requests/ hit")
    try:
        customer_name = (payload.customer_name or "").strip() or "Driver"

        # Normalise service_type to the canonical v1 values: 'mechanic' | 'tow'.
        raw_service = (payload.service_type or "").strip().lower()
        if raw_service in ("tow", "towing", "towing_provider", "tow / recovery", "recovery", "garage transfer"):
            service_type = "tow"
        elif raw_service in ("mechanic", "repair", "roadside", "roadside assist", "both"):
            service_type = "mechanic"
        else:
            raise HTTPException(status_code=400, detail="service_type must be 'mechanic' or 'tow'")

        issue_type = (payload.issue_type or "").strip().lower() or "general"
        description = (payload.description or "").strip() or None
        area_id = payload.area_id
        location_text = (payload.location_text or "").strip()
        latitude = payload.latitude
        longitude = payload.longitude
        legacy_location = (payload.location or "").strip()

        # Always bind request to authenticated driver
        role = (user.get("role") or "").lower()
        if role not in ("driver", "admin"):
            raise HTTPException(status_code=403, detail="Only drivers can create requests")
        phone = (user.get("phone") or "").strip()
        driver_id = int(user["id"]) if user.get("id") is not None else None
        if role == "driver" and driver_id is None:
            raise HTTPException(status_code=401, detail="Authenticated driver id is missing")

        # v1 create rule: reject only if BOTH area_id and location_text are missing.
        if area_id is None and not location_text:
            raise HTTPException(status_code=400, detail="area_id or location_text is required")

        # Keep the legacy display column populated without making it a location requirement.
        location = location_text or legacy_location or (
            f"{latitude},{longitude}" if latitude is not None and longitude is not None
            else f"Area {area_id}" if area_id is not None
            else ""
        )

        logger.info(f"   Payload received: service_type={service_type}, issue_type={issue_type}, area_id={area_id}, location_text={location_text}")

        query = """
            INSERT INTO service_requests
            (customer_name, service_type, location, description, phone, status, user_id,
             issue_type, area_id, location_text, latitude, longitude, dispatched_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, NOW(), NOW())
            RETURNING id, customer_name, service_type, location, description, phone, status, created_at, updated_at, user_id, mechanic_id,
                      dispatched_at, accepted_at, en_route_at, arrived_at, service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note,
                      issue_type, area_id, location_text, latitude, longitude, matched_mechanic_id, matched_mechanic_name, matched_mechanic_phone, cancelled_at
        """
        try:
            async with db.transaction():
                if role == "driver":
                    lock_identity = f"phone:{phone}" if phone else f"id:{driver_id}"
                    lock_key = f"driver-request:{lock_identity}"
                    await db.execute("SELECT pg_advisory_xact_lock(hashtext($1))", lock_key)
                    existing = await db.fetchrow(
                        """
                        SELECT id, customer_name, service_type, location, description, phone, status,
                               created_at, updated_at, user_id, mechanic_id, dispatched_at, accepted_at,
                               en_route_at, arrived_at, service_started_at, completed_at, eta_minutes,
                               completion_by, actual_fee, service_note, issue_type, area_id, location_text,
                               latitude, longitude, matched_mechanic_id, matched_mechanic_name,
                               matched_mechanic_phone, cancelled_at
                        FROM service_requests
                        WHERE (($1::integer IS NOT NULL AND user_id = $1)
                            OR ($2::text <> '' AND phone = $2))
                          AND status NOT IN ('completed', 'cancelled')
                        ORDER BY created_at DESC
                        LIMIT 1
                        FOR UPDATE
                        """,
                        driver_id,
                        phone,
                    )
                    if existing:
                        return _request_response_data(existing, driver_view=True, media_files=[])

                result = await db.fetchrow(
                    query,
                    customer_name,
                    service_type,
                    location,
                    description or "",
                    phone,
                    driver_id,
                    issue_type,
                    area_id,
                    location_text or None,
                    latitude,
                    longitude,
                )
        except Exception as e:
            if isinstance(e, HTTPException):
                raise
            logger.error(f"❌ Database INSERT failed: {type(e).__name__}: {str(e)}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

        if not result:
            logger.error("❌ Database returned no result after INSERT")
            raise HTTPException(status_code=500, detail="Failed to create request")

        provider_request_data = _request_response_data(result, media_files=[])
        request_data = _request_response_data(result, driver_view=True, media_files=[])

        logger.info(f"✅ Request created successfully: id={request_data['id']}")
        # Broadcast new job event to WebSocket clients (expires in 5 minutes)
        try:
            expires_at = datetime.utcnow() + timedelta(minutes=5)
            await manager.broadcast({
                'type': 'new_job',
                'job': provider_request_data,
                'expires_at': expires_at.isoformat() + 'Z',
            })
        except Exception as e:
            logger.warning(f"Failed to broadcast new_job event: {e}")

        # FCM push to matched mechanics via matching service (best-effort, non-blocking)
        notifications_url = os.getenv("NOTIFICATIONS_URL", "http://localhost:8004")
        background_tasks.add_task(
            _dispatch_to_matched_mechanics,
            int(request_data['id']),
            location,
            service_type,
            notifications_url,
            provider_request_data,
            payload.preferred_mechanic_id,
            area_id,
        )

        return request_data

    except HTTPException:
        # Re-raise HTTP exceptions (400, 500, etc.)
        raise
    except Exception as e:
        logger.error(f"❌ Exception in POST /requests/: {type(e).__name__}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Request creation failed: {str(e)}")


def _get_file_type(file: UploadFile) -> str:
    mime_type = (file.content_type or "").lower()
    fn = (file.filename or "").lower()
    if mime_type.startswith("audio/") or fn.endswith(".webm"):
        return "voice"
    if mime_type.startswith("image/"):
        return "photo"
    return "document"


async def _upload_media_background(
    request_id: int,
    files_info: list[tuple[str, str, str]],
) -> None:
    """Background task: upload files to storage and insert media records. Runs after response is sent."""
    if not pool or not files_info:
        return
    try:
        storage = get_storage()
    except Exception as e:
        logger.error(f"❌ Background upload: storage init failed: {e}")
        return
    async with pool.acquire() as db:
        for temp_path, filename, file_type in files_info:
            try:
                media_info = await storage.upload_file(temp_path, file_type, str(request_id))
                await db.execute(
                    """
                    INSERT INTO media_files
                    (request_id, file_url, file_type, file_name, size_kb, uploaded_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    request_id,
                    media_info["url"],
                    media_info["file_type"],
                    filename,
                    media_info["size_kb"],
                    media_info["uploaded_at"],
                )
                logger.info(f"✅ Background upload: {filename} ({media_info['size_kb']} KB)")
            except Exception as e:
                logger.error(f"❌ Background upload failed for {filename}: {e}")
            finally:
                Path(temp_path).unlink(missing_ok=True)


async def _upload_media_sync(request_id: int, files_info: list[tuple[str, str, str]]) -> list[dict]:
    """Upload files + insert media records NOW (not in the background) and return them,
    so the new_job broadcast carries the driver's photo — the mechanic then sees it in
    the incoming-job popup before deciding whether to set off. Best-effort: upload
    failures don't fail request creation, they just yield no media."""
    records: list[dict] = []
    if not pool or not files_info:
        for tp, _, _ in files_info:
            Path(tp).unlink(missing_ok=True)
        return records
    try:
        storage = get_storage()
    except Exception as e:
        logger.error(f"❌ Sync upload: storage init failed: {e}")
        for tp, _, _ in files_info:
            Path(tp).unlink(missing_ok=True)
        return records
    async with pool.acquire() as db:
        for temp_path, filename, file_type in files_info:
            try:
                media_info = await storage.upload_file(temp_path, file_type, str(request_id))
                await db.execute(
                    """
                    INSERT INTO media_files
                    (request_id, file_url, file_type, file_name, size_kb, uploaded_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    request_id,
                    media_info["url"],
                    media_info["file_type"],
                    filename,
                    media_info["size_kb"],
                    media_info["uploaded_at"],
                )
                records.append({
                    "url": media_info["url"],
                    "file_type": media_info["file_type"],
                    "size_kb": media_info["size_kb"],
                    "uploaded_at": media_info["uploaded_at"],
                })
                logger.info(f"✅ Sync upload: {filename} ({media_info['size_kb']} KB)")
            except Exception as e:
                logger.error(f"❌ Sync upload failed for {filename}: {e}")
            finally:
                Path(temp_path).unlink(missing_ok=True)
    return records


@app.post("/requests-with-media/", response_model=RequestOut)
async def create_request_with_media(
    background_tasks: BackgroundTasks,
    current_user: Dict = Depends(get_current_user),
    customer_name: str = Form(...),
    service_type: str = Form(...),
    location: str = Form(...),
    description: str = Form(...),
    preferred_mechanic_id: Optional[int] = Form(None),
    media_files: Optional[List[UploadFile]] = File(default=None),
    db=Depends(get_db),
):
    """
    Create request with media files using FormData.
    Responds immediately after DB insert; file uploads run in background.
    """
    file_list = media_files or []
    print("📥 /requests-with-media hit, files:", len(file_list))
    logger.info(f"📤 Creating request with media for customer: {customer_name}, files: {len(file_list)}")
    
    customer_name = (customer_name or "").strip() or "Driver"
    service_type = (service_type or "").strip() or "Roadside assist"
    location = (location or "").strip()
    description = (description or "").strip()
    if current_user.get("role") not in ("driver", "admin"):
        raise HTTPException(status_code=403, detail="Only drivers can create requests")
    phone = (current_user.get("phone") or "").strip()
    if not location:
        raise HTTPException(status_code=400, detail="location is required")
    if not phone:
        raise HTTPException(status_code=400, detail="phone is required")
    
    query = """
        INSERT INTO service_requests 
        (customer_name, service_type, location, description, phone, status, user_id, dispatched_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW())
        RETURNING id, customer_name, service_type, location, description, phone, status, created_at, user_id, mechanic_id,
                  dispatched_at, accepted_at, en_route_at, arrived_at, service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note
    """
    result = await db.fetchrow(
        query,
        customer_name,
        service_type,
        location,
        description,
        phone,
        int(current_user.get("id")) if current_user.get("id") is not None else None,
    )
    
    if not result:
        logger.error("Failed to insert request")
        raise HTTPException(status_code=500, detail="Failed to create request")
    
    request_id = result["id"]
    request_data = dict(result)
    request_data["id"] = str(request_id)
    request_data.pop("phone", None)
    if request_data.get('created_at'):
        request_data['created_at'] = request_data['created_at'].isoformat()
    for k in ("dispatched_at", "accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at", "cancelled_at"):
        if request_data.get(k):
            request_data[k] = request_data[k].isoformat()
    request_data["media_files"] = []
    
    # Save uploaded files to temp, then upload SYNCHRONOUSLY so the photo is attached to
    # the request BEFORE we broadcast it — the mechanic sees it in the incoming-job popup.
    # (The driver is watching the dispatch animation meanwhile, so this is not perceptible.)
    if file_list:
        files_info: list[tuple[str, str, str]] = []
        for file in file_list:
            if not file.filename:
                continue
            try:
                contents = await file.read()
                with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as tmp:
                    tmp.write(contents)
                    tmp.flush()
                    files_info.append((tmp.name, file.filename, _get_file_type(file)))
            except Exception as e:
                logger.warning(f"Failed to read file {file.filename}: {e}")
        if files_info:
            request_data["media_files"] = await _upload_media_sync(request_id, files_info)

    logger.info(f"✅ Request created: id={request_id}, media files: {len(request_data.get('media_files') or [])}")

    # Broadcast new job event to WebSocket clients
    try:
        expires_at = datetime.utcnow() + timedelta(minutes=5)
        await manager.broadcast({
            'type': 'new_job',
            'job': request_data,
            'expires_at': expires_at.isoformat() + 'Z',
        })
    except Exception as e:
        logger.warning(f"Failed to broadcast new_job event: {e}")

    # FCM push to matched mechanics via matching service (best-effort, non-blocking)
    notifications_url_m = os.getenv("NOTIFICATIONS_URL", "http://localhost:8004")
    background_tasks.add_task(
        _dispatch_to_matched_mechanics,
        request_id,
        location,
        service_type,
        notifications_url_m,
        request_data,
        preferred_mechanic_id,
    )

    return request_data

@app.get("/requests/", response_model=List[RequestOut])
async def get_requests(
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
    status: Optional[str] = None,
    search: Optional[str] = None,
):
    """Get request history.
    - driver: only own requests
    - admin: all requests, with optional status and search filters
    """
    try:
        role = (current_user.get("role") or "driver").lower()
        user_id = current_user.get("id")
        user_phone = current_user.get("phone")

        if role not in ("driver", "admin", "mechanic"):
            raise HTTPException(status_code=403, detail="Unauthorized")

        # Normalise status: frontend sends 'in_progress' but DB uses multi-value statuses
        status_filter: Optional[list] = None
        if status and status != "all":
            if status == "searching":
                status_filter = ["pending"]
            elif status == "assigned":
                status_filter = ["accepted", "en_route", "arrived", "service_started", "awaiting_confirmation"]
            elif status == "in_progress":
                status_filter = ["en_route", "arrived", "service_started"]
            else:
                status_filter = [status]

        query = """
            SELECT id, customer_name, service_type, location, description, phone, status, created_at, updated_at,
                   user_id, mechanic_id, dispatched_at, accepted_at, en_route_at, arrived_at, service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note,
                   issue_type, area_id, location_text, latitude, longitude, matched_mechanic_id, matched_mechanic_name, matched_mechanic_phone, cancelled_at
            FROM service_requests
            WHERE
                (
                    ($1::text = 'admin')
                    OR (
                        $1::text = 'driver'
                        AND (
                            (user_id IS NOT NULL AND user_id = $2)
                            OR ($3::text IS NOT NULL AND phone = $3)
                        )
                    )
                )
                AND ($4::text[] IS NULL OR status = ANY($4::text[]))
                AND ($5::text IS NULL OR
                     customer_name ILIKE '%' || $5 || '%' OR
                     service_type ILIKE '%' || $5 || '%' OR
                     location ILIKE '%' || $5 || '%')
            ORDER BY created_at DESC
        """
        rows = await db.fetch(
            query,
            role,
            int(user_id) if user_id is not None else None,
            user_phone,
            status_filter,
            search if search else None,
        )
        
        requests_list = []
        for row in rows:
            media_files = []
            try:
                media_query = """
                    SELECT file_url as url, file_type, size_kb, uploaded_at
                    FROM media_files
                    WHERE request_id = $1
                    ORDER BY uploaded_at DESC
                """
                media_rows = await db.fetch(media_query, row["id"])
                media_files = _media_rows_to_list(media_rows)
            except Exception as me:
                logger.warning(f"Could not fetch media for request {row.get('id')}: {me}")

            # For the admin history, also surface media EXCHANGED in the in-job chat
            # (photos / voice notes the driver and mechanic sent each other) alongside the
            # files uploaded with the request. Admin-only so drivers' own history is unchanged.
            if role == "admin":
                try:
                    chat_rows = await db.fetch(
                        """SELECT media_url, media_type, created_at
                           FROM chat_messages
                           WHERE request_id = $1 AND media_url IS NOT NULL AND COALESCE(media_type,'none') <> 'none'
                           ORDER BY created_at DESC""",
                        row["id"],
                    )
                    for c in chat_rows:
                        mt = (c["media_type"] or "").lower()
                        file_type = "photo" if mt in ("image", "photo") else ("voice" if mt in ("voice", "audio") else "document")
                        media_files.append({
                            "url": c["media_url"],
                            "file_type": file_type,
                            "size_kb": 0.0,
                            "uploaded_at": c["created_at"].isoformat() if c["created_at"] else "",
                        })
                except Exception as ce:
                    logger.warning(f"Could not fetch chat media for request {row.get('id')}: {ce}")

            requests_list.append(_request_response_data(
                row,
                driver_view=role == "driver",
                media_files=media_files,
            ))
        
        logger.info(f"📊 Fetched {len(requests_list)} requests")
        return requests_list
    except Exception as e:
        logger.error(f"❌ Failed to fetch requests: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch requests: {str(e)}")


@app.get("/requests/pending", response_model=List[RequestOut])
async def get_pending_requests(current_user: Dict = Depends(get_current_user), db=Depends(get_db)):
    """Return all pending, unassigned requests so mechanics can browse available jobs."""
    role = (current_user.get("role") or "").lower()
    if role not in ("mechanic", "admin"):
        raise HTTPException(status_code=403, detail="Only mechanics can view pending requests")
    try:
        rows = await db.fetch("""
            SELECT id, customer_name, service_type, location, description, status, created_at,
                   user_id, mechanic_id, dispatched_at, accepted_at, en_route_at, arrived_at,
                   service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note
            FROM service_requests
            WHERE status = 'pending' AND mechanic_id IS NULL
            ORDER BY created_at DESC
            LIMIT 50
        """)
        results = []
        for row in rows:
            data = dict(row)
            data["id"] = str(data["id"])
            data.pop("phone", None)
            if data.get("created_at"):
                data["created_at"] = data["created_at"].isoformat()
            for k in ("dispatched_at", "accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at", "cancelled_at"):
                if data.get(k):
                    data[k] = data[k].isoformat()
            media_rows = await db.fetch(
                "SELECT file_url as url, file_type, size_kb, uploaded_at FROM media_files WHERE request_id = $1 ORDER BY uploaded_at DESC",
                row["id"],
            )
            data["media_files"] = _media_rows_to_list(media_rows)
            results.append(data)
        return results
    except Exception as e:
        logger.error(f"❌ Failed to fetch pending requests: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch pending requests: {str(e)}")


@app.get("/requests/{request_id}", response_model=RequestOut)
async def get_request(request_id: int, current_user: Dict = Depends(get_current_user), db=Depends(get_db)):
    """Get single request with media files"""
    query = """
        SELECT id, customer_name, service_type, location, description, phone, status, created_at, updated_at,
               user_id, mechanic_id, dispatched_at, accepted_at, en_route_at, arrived_at, service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note,
               issue_type, area_id, location_text, latitude, longitude, matched_mechanic_id, matched_mechanic_name, matched_mechanic_phone, cancelled_at
        FROM service_requests
        WHERE id = $1
    """
    result = await db.fetchrow(query, request_id)
    if not result:
        raise HTTPException(status_code=404, detail="Request not found")

    role = (current_user.get("role") or "driver").lower()
    if role not in ("driver", "admin", "mechanic"):
        raise HTTPException(status_code=403, detail="Unauthorized")

    # driver can only view own request (by user_id if present, else phone)
    if role == "driver":
        uid = current_user.get("id")
        phone = current_user.get("phone")
        if (result.get("user_id") is not None and uid is not None and int(result["user_id"]) != int(uid)) and (
            not phone or result.get("phone") != phone
        ):
            raise HTTPException(status_code=403, detail="Not allowed")
    
    # Fetch media files
    media_query = """
        SELECT file_url as url, file_type, size_kb, uploaded_at
        FROM media_files
        WHERE request_id = $1
        ORDER BY uploaded_at DESC
    """
    media_rows = await db.fetch(media_query, request_id)
    request_data = _request_response_data(
        result,
        driver_view=role == "driver",
        media_files=_media_rows_to_list(media_rows),
    )

    return request_data


@app.get("/requests/{request_id}/matches")
async def get_request_matches(
    request_id: int,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Return area-matched mechanics to the owning driver for call-based V1 fulfillment."""
    role = (current_user.get("role") or "driver").lower()
    if role not in ("driver", "admin"):
        raise HTTPException(status_code=403, detail="Only drivers can view request matches")

    request_row = await db.fetchrow(
        """
        SELECT id, user_id, phone, service_type, area_id, location_text, location, latitude, longitude
        FROM service_requests
        WHERE id = $1
        """,
        request_id,
    )
    if not request_row:
        raise HTTPException(status_code=404, detail="Request not found")

    if role == "driver":
        user_id = current_user.get("id")
        user_phone = current_user.get("phone")
        owns_by_id = (
            request_row.get("user_id") is not None
            and user_id is not None
            and int(request_row["user_id"]) == int(user_id)
        )
        owns_by_phone = bool(user_phone and request_row.get("phone") == user_phone)
        if not owns_by_id and not owns_by_phone:
            raise HTTPException(status_code=403, detail="Not allowed")

    request_location = request_row.get("location_text") or request_row.get("location") or ""
    match_body: Dict[str, Any] = {
        "request_id": request_id,
        "service_type": request_row["service_type"],
        "top_n": 10,
    }
    if request_row.get("area_id") is not None:
        match_body["area_id"] = request_row["area_id"]
    if request_row.get("latitude") is not None and request_row.get("longitude") is not None:
        match_body["latitude"] = request_row["latitude"]
        match_body["longitude"] = request_row["longitude"]

    if "area_id" not in match_body and "latitude" not in match_body:
        return {
            "request_id": str(request_id),
            "area_name": None,
            "candidates": [],
            "message": "Select a service area to find eligible mechanics.",
        }

    matching_url = os.getenv("MATCHING_SERVICE_URL", "http://127.0.0.1:8003").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.post(
                f"{matching_url}/match",
                headers={"Authorization": f"Bearer {_service_token()}"},
                json=match_body,
            )
            if response.status_code == 404:
                return {
                    "request_id": str(request_id),
                    "area_name": None,
                    "candidates": [],
                    "message": "No eligible mechanics were found in this area.",
                }
            response.raise_for_status()
            try:
                payload = response.json()
            except ValueError as exc:
                logger.error("Matching service returned invalid JSON for request %s: %s", request_id, exc)
                raise HTTPException(status_code=502, detail="Matching service returned an invalid response")
    except httpx.HTTPStatusError as exc:
        logger.error("Matching service failed for request %s: HTTP %s", request_id, exc.response.status_code)
        raise HTTPException(status_code=502, detail="Matching service could not find mechanics right now")
    except httpx.RequestError as exc:
        logger.error("Matching service unavailable for request %s: %s", request_id, exc)
        raise HTTPException(status_code=502, detail="Matching service is temporarily unavailable")

    raw_candidates = payload.get("candidates") if isinstance(payload, dict) else None
    if not isinstance(raw_candidates, list):
        logger.error("Matching service returned an invalid candidates list for request %s", request_id)
        raise HTTPException(status_code=502, detail="Matching service returned an invalid response")
    if not all(isinstance(candidate, dict) for candidate in raw_candidates):
        logger.error("Matching service returned malformed candidates for request %s", request_id)
        raise HTTPException(status_code=502, detail="Matching service returned an invalid response")

    area_name = payload.get("resolved_area_name")
    candidates = [
        {
            "mechanic_id": candidate.get("mechanic_id"),
            "mechanic_name": candidate.get("mechanic_name") or "Mechanic",
            "phone": candidate.get("phone"),
            "area": candidate.get("location") or area_name or request_location or None,
        }
        for candidate in raw_candidates
    ]
    return {
        "request_id": str(request_id),
        "area_name": area_name or request_location or None,
        "candidates": candidates,
        "message": None if candidates else "No eligible mechanics were found in this area.",
    }


@app.get("/requests/{request_id}/call-partner", response_model=CallPartnerResponse)
async def get_call_partner_phone(
    request_id: int,
    request: Request,
    db=Depends(get_db),
    current_user: Dict = Depends(get_current_user),
):
    """
    Secure endpoint to get the other party's phone number for calling.
    
    Rules:
    - Only works when job status is 'accepted' or 'en_route'
    - Only accessible to the driver (owner of the request) or assigned mechanic
    - Never exposes phone numbers in normal API responses - only this dedicated endpoint
    - Returns phone number which frontend uses to trigger tel: link (never displayed in UI)
    """
    logger.info(f"📞 Call partner request for request_id={request_id} by user_id={current_user.get('id')}")
    
    # 1. Load the service request
    query = """
        SELECT id, phone, status, customer_name
        FROM service_requests
        WHERE id = $1
    """
    request_row = await db.fetchrow(query, request_id)
    
    if not request_row:
        logger.warning(f"❌ Request {request_id} not found")
        raise HTTPException(status_code=404, detail="Request not found")
    
    request_status = request_row['status']
    driver_phone = request_row['phone']
    
    # 2. Check status - only allow calling during active job
    # Accept both "en_route" (backend) and "on_the_way" (frontend) as valid statuses
    if request_status not in ("accepted", "en_route", "on_the_way"):
        logger.warning(f"❌ Request {request_id} status is '{request_status}', not active")
        raise HTTPException(
            status_code=403,
            detail="Calling is only allowed for active jobs (accepted or en_route)"
        )
    
    # 3. Check if user is the driver (match phone from token with request phone)
    user_phone = current_user.get('phone')
    is_driver = user_phone and user_phone == driver_phone
    
    # 4. Check if user is the assigned mechanic (via job_acceptances table)
    is_mechanic = False
    mechanic_id = None
    if current_user.get('role') == 'mechanic':
        try:
            await ensure_acceptances_table(db)
            acceptance_query = """
                SELECT mechanic_id
                FROM job_acceptances
                WHERE request_id = $1
            """
            acceptance_row = await db.fetchrow(acceptance_query, request_id)
            if acceptance_row:
                mechanic_id = acceptance_row['mechanic_id']
                # Verify the mechanic_id matches current user's id
                if current_user.get('id') == mechanic_id:
                    is_mechanic = True
        except Exception as e:
            logger.warning(f"⚠️ Could not check mechanic assignment: {e}")
    
    # 5. Authorization check
    if not (is_driver or is_mechanic):
        logger.warning(f"❌ User {current_user.get('id')} not authorized to call for request {request_id}")
        raise HTTPException(
            status_code=403,
            detail="Not authorized to call for this request"
        )
    
    # 6. Determine which phone to return
    if is_driver:
        # Driver is calling mechanic - get mechanic phone from mechanics table
        if not mechanic_id:
            # Get mechanic_id from job_acceptances
            try:
                await ensure_acceptances_table(db)
                acceptance_query = """
                    SELECT mechanic_id
                    FROM job_acceptances
                    WHERE request_id = $1
                """
                acceptance_row = await db.fetchrow(acceptance_query, request_id)
                if not acceptance_row:
                    raise HTTPException(
                        status_code=400,
                        detail="No mechanic assigned to this request yet"
                    )
                mechanic_id = acceptance_row['mechanic_id']
            except Exception as e:
                logger.error(f"❌ Failed to get mechanic_id: {e}")
                raise HTTPException(
                    status_code=400,
                    detail="No mechanic assigned to this request yet"
                )
        
        # Fetch mechanic phone from mechanics table
        try:
            mechanic_query = """
                SELECT phone
                FROM mechanics
                WHERE id = $1
            """
            mechanic_row = await db.fetchrow(mechanic_query, mechanic_id)
            if not mechanic_row or not mechanic_row.get('phone'):
                raise HTTPException(
                    status_code=400,
                    detail="Mechanic phone not available"
                )
            partner_phone = mechanic_row['phone']
            logger.info(f"✅ Returning mechanic phone for request {request_id}")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"❌ Failed to fetch mechanic phone: {e}")
            raise HTTPException(
                status_code=500,
                detail="Failed to retrieve mechanic phone"
            )
    else:
        # Mechanic is calling driver - return driver phone from service_requests
        partner_phone = driver_phone
        logger.info(f"✅ Returning driver phone for request {request_id}")
    
    if not partner_phone:
        raise HTTPException(
            status_code=400,
            detail="Phone number not available"
        )
    
    # 7. Return ONLY the phone field (never logged or displayed in UI)
    return CallPartnerResponse(phone=partner_phone)


class AcceptPayload(BaseModel):
    eta_minutes: Optional[int] = 15


@app.patch("/requests/{request_id}/accept")
async def accept_request(
    request_id: int,
    payload: AcceptPayload,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Mechanic attempts to accept a job. First acceptor wins (atomic update).
    Returns 409 if the job is already taken.
    """
    # Ensure acceptance tracking table exists (idempotent)
    await ensure_acceptances_table(db)

    try:
        # Any verified service provider (mechanic, tow provider, or "both") may accept —
        # get_current_user normalises every provider role to "mechanic". Only drivers/admins
        # fall through to this guard.
        if (current_user.get("role") or "").lower() != "mechanic":
            raise HTTPException(status_code=403, detail="Only service providers can accept jobs")

        mechanic_id = int(current_user.get("id"))
        mechanic_name = current_user.get("name") or current_user.get("full_name") or "Mechanic"

        # Suspended mechanics (3 consecutive pick-up cancellations) can't take new jobs.
        strike_state = await _get_strike_row(db, mechanic_id)
        if strike_state.get("suspended"):
            raise HTTPException(
                status_code=403,
                detail="Your account is suspended for repeatedly cancelling jobs. Contact MOTOFIX support.",
            )

        # Platform-fee gate: too many unpaid completed-job fees would block new acceptances
        # until the mechanic settles their balance (this replaces the subscription gate).
        # Dormant for the presentation — `gated` is only true when FEE_ENFORCE_GATE is on.
        fee_state = await _fee_state(db, mechanic_id)
        if fee_state["gated"]:
            raise HTTPException(
                status_code=402,  # Payment Required
                detail=(
                    f"You have {fee_state['owed_count']} unpaid platform fees "
                    f"(UGX {fee_state['owed_amount']:,}). Settle them to accept new jobs."
                ),
            )

        async with db.transaction():
            # Try to change the status atomically only if it's still pending
            result = await db.fetchrow(
                """
                UPDATE service_requests
                SET status = 'accepted',
                    mechanic_id = $2,
                    accepted_at = COALESCE(accepted_at, NOW()),
                    matched_mechanic_id = $2,
                    matched_mechanic_name = $3,
                    matched_mechanic_phone = $4,
                    updated_at = NOW()
                WHERE id = $1 AND status = 'pending' AND mechanic_id IS NULL
                RETURNING id, customer_name, service_type, location, description, phone, status, created_at,
                          user_id, mechanic_id, dispatched_at, accepted_at, en_route_at, arrived_at, service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note
                """,
                request_id,
                mechanic_id,
                mechanic_name,
                current_user.get("phone"),
            )

            if not result:
                existing = await db.fetchrow("SELECT status FROM service_requests WHERE id = $1", request_id)
                if existing:
                    status = existing.get('status')
                    raise HTTPException(status_code=409, detail=f"Job already {status}")
                raise HTTPException(status_code=404, detail="Request not found")

            # Record acceptance details
            await db.execute(
                "INSERT INTO job_acceptances (request_id, mechanic_id, mechanic_name, eta_minutes) VALUES ($1,$2,$3,$4)",
                request_id, mechanic_id, mechanic_name, payload.eta_minutes,
            )

            # Increment mechanic's jobs_completed as a lightweight leaderboard stub (if mechanic exists)
            # Wrapped in nested transaction (SAVEPOINT) so a failure here does NOT abort the outer transaction.
            # Without this, a failed UPDATE (e.g. mechanics table missing) leaves PostgreSQL in an error state
            # and the subsequent COMMIT fails, causing a 500.
            try:
                async with db.transaction():
                    await db.execute("UPDATE mechanics SET jobs_completed = COALESCE(jobs_completed,0) + 1 WHERE id = $1", mechanic_id)
            except Exception:
                logger.debug("Failed to increment mechanic's jobs_completed (non-critical)")

            # Build response and broadcast the event
            request_data = dict(result)
            request_data['id'] = str(request_data['id'])
            if request_data.get('created_at'):
                request_data['created_at'] = request_data['created_at'].isoformat()
            for k in ("dispatched_at", "accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at", "cancelled_at"):
                if request_data.get(k):
                    request_data[k] = request_data[k].isoformat()
            request_data['media_files'] = []

        # ── Transaction has COMMITTED here ──────────────────────────────────────────
        # Broadcast AFTER commit, never inside the transaction: a slow or dead WebSocket
        # must not be able to roll back a successful accept (that was the bug where the
        # driver saw "accepted" but the mechanic got "Failed to accept job" after a long
        # hang). broadcast() is itself bounded + concurrent, so one zombie socket can no
        # longer stall this either — the mechanic gets a clean, fast response.
        event = {
            'type': 'job_taken',
            'job_id': request_id,
            'mechanic': {
                'id': mechanic_id,
                'name': mechanic_name,
            },
            'eta_minutes': payload.eta_minutes,
            'taken_at': datetime.utcnow().isoformat() + 'Z',
        }

        # Broadcast to all connected WebSocket clients
        await manager.broadcast(event)

        # Also broadcast a status update with the canonical request snapshot
        await manager.broadcast({
            'type': 'status_update',
            'job_id': request_id,
            'status': 'accepted',
            'request': {k: v for k, v in request_data.items() if k != 'phone'},
            'updated_at': datetime.utcnow().isoformat() + 'Z',
        })

        return JSONResponse({'status': 'accepted', 'request_id': str(request_id), 'mechanic': event['mechanic'], 'eta_minutes': payload.eta_minutes})

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Exception in PATCH /requests/{{request_id}}/accept: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to accept job")

@app.post("/requests/{request_id}/reject")
async def reject_request(request_id: int, db=Depends(get_db)):
    """Mechanic rejects a pending job.
    The job stays 'pending' in the DB so another mechanic can still accept it.
    Re-broadcasts new_job so mechanics currently online get another chance.
    Returns 200 even if the job no longer exists or is already taken (mechanic's local state handles it).
    """
    row = await db.fetchrow(
        "SELECT id, customer_name, service_type, location, description, status, created_at "
        "FROM service_requests WHERE id = $1 AND status = 'pending'",
        request_id,
    )

    if not row:
        # Already accepted or doesn't exist — mechanic's UI will dismiss locally anyway
        return JSONResponse({'status': 'ok', 'request_id': request_id})

    request_data = dict(row)
    request_data['id'] = str(request_data['id'])
    if request_data.get('created_at'):
        request_data['created_at'] = request_data['created_at'].isoformat()
    request_data['media_files'] = []

    # Re-broadcast so other mechanics who are online now get another chance
    expires_at = datetime.utcnow() + timedelta(minutes=5)
    try:
        await manager.broadcast({
            'type': 'new_job',
            'job': request_data,
            'expires_at': expires_at.isoformat() + 'Z',
        })
    except Exception as e:
        logger.warning(f"Failed to re-broadcast after rejection of request {request_id}: {e}")

    logger.info(f"🚫 Request {request_id} rejected — re-broadcast to {len(manager.active_connections)} clients")
    return JSONResponse({'status': 'ok', 'request_id': request_id})


@app.post("/requests/{request_id}/redispatch")
async def redispatch_request(
    request_id: int,
    background_tasks: BackgroundTasks,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Driver retries matching for an existing searching request."""
    role = (current_user.get("role") or "driver").lower()
    user_id = current_user.get("id")
    user_phone = current_user.get("phone")

    if role not in ("driver", "admin"):
        raise HTTPException(status_code=403, detail="Only the request owner can retry matching")

    row = await db.fetchrow(
        """SELECT id, status, user_id, phone, customer_name, service_type, location,
                  description, area_id, location_text, latitude, longitude, issue_type
           FROM service_requests WHERE id = $1""",
        request_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Request not found")
    if row["status"] == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot redispatch a cancelled request")
    if row["status"] not in ("pending", "searching"):
        raise HTTPException(status_code=400, detail=f"Cannot redispatch a request with status '{row['status']}'")

    if role == "driver":
        owns = (
            (row.get("user_id") is not None and user_id is not None and int(row["user_id"]) == int(user_id))
            or (user_phone and row.get("phone") == user_phone)
        )
        if not owns:
            raise HTTPException(status_code=403, detail="Not allowed")

    result = await db.fetchrow(
        """
        UPDATE service_requests
        SET dispatched_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING id, customer_name, service_type, location, description, status, created_at, updated_at,
                  user_id, mechanic_id, dispatched_at, accepted_at, en_route_at, arrived_at,
                  service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note,
                  issue_type, area_id, location_text, latitude, longitude, matched_mechanic_id,
                  matched_mechanic_name, matched_mechanic_phone, cancelled_at
        """,
        request_id,
    )

    provider_request_data = _request_response_data(result, media_files=[])
    request_data = _request_response_data(result, driver_view=role == "driver", media_files=[])

    expires_at = datetime.utcnow() + timedelta(minutes=5)
    try:
        await manager.broadcast({
            "type": "new_job",
            "job": provider_request_data,
            "expires_at": expires_at.isoformat() + "Z",
        })
    except Exception as e:
        logger.warning(f"Failed to broadcast new_job on redispatch for request {request_id}: {e}")

    background_tasks.add_task(
        _dispatch_to_matched_mechanics,
        request_id,
        str(row.get("location_text") or row.get("location") or ""),
        str(row["service_type"]),
        os.getenv("NOTIFICATIONS_URL", "http://localhost:8004"),
        provider_request_data,
        None,
        row.get("area_id"),
    )
    logger.info(f"🔁 Request {request_id} re-dispatched — broadcast to {len(manager.active_connections)} clients")
    return JSONResponse({"status": "redispatched", "request": request_data})


@app.get("/mechanics/{mechanic_id}/current-job")
async def get_mechanic_current_job(mechanic_id: int, db=Depends(get_db)):
    """Return the active (non-completed, non-cancelled) job assigned to a mechanic.
    Used internally by the verification service as a proxy endpoint.
    """
    try:
        row = await db.fetchrow(
            """
            SELECT ja.request_id AS id, ja.accepted_at, ja.eta_minutes,
                   sr.customer_name, sr.service_type, sr.location,
                   sr.description, sr.status,
                   sr.mechanic_id, sr.user_id, sr.created_at,
                   sr.en_route_at, sr.arrived_at, sr.service_started_at, sr.completed_at
            FROM job_acceptances ja
            JOIN service_requests sr ON sr.id = ja.request_id
            WHERE ja.mechanic_id = $1
              AND sr.status NOT IN ('completed', 'cancelled')
            ORDER BY ja.accepted_at DESC
            LIMIT 1
            """,
            mechanic_id,
        )
    except Exception as e:
        logger.warning(f"current-job query failed for mechanic {mechanic_id}: {e}")
        return {"job": None}

    if not row:
        return {"job": None}

    job = dict(row)
    job["id"] = str(job["id"])
    for ts in ("accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at", "created_at"):
        if job.get(ts):
            job[ts] = job[ts].isoformat()
    return {"job": job}


# ─────────────────────── MECHANIC CANCELLATION STRIKES ───────────────────────
STRIKE_LIMIT = 3  # consecutive pick-up cancellations before suspension

async def _get_strike_row(db, mechanic_id: int) -> dict:
    row = await db.fetchrow(
        "SELECT mechanic_id, strikes, suspended, suspended_at, suspension_count FROM mechanic_strikes WHERE mechanic_id = $1",
        mechanic_id,
    )
    return dict(row) if row else {
        "mechanic_id": mechanic_id, "strikes": 0, "suspended": False,
        "suspended_at": None, "suspension_count": 0,
    }

async def _add_mechanic_strike(db, mechanic_id: int) -> dict:
    """Record one consecutive cancellation; suspend on the 3rd. Returns the new state."""
    row = await db.fetchrow(
        """
        INSERT INTO mechanic_strikes (mechanic_id, strikes, updated_at)
        VALUES ($1, 1, NOW())
        ON CONFLICT (mechanic_id) DO UPDATE
            SET strikes = mechanic_strikes.strikes + 1, updated_at = NOW()
        RETURNING strikes
        """,
        mechanic_id,
    )
    strikes = int(row["strikes"])
    suspended = strikes >= STRIKE_LIMIT
    if suspended:
        # Suspend AND bump the lifetime suspension count (drives escalation messaging).
        row2 = await db.fetchrow(
            """
            UPDATE mechanic_strikes
               SET suspended = TRUE, suspended_at = NOW(), suspension_count = suspension_count + 1
             WHERE mechanic_id = $1
            RETURNING suspension_count
            """,
            mechanic_id,
        )
        return {"strikes": strikes, "suspended": True,
                "suspension_count": int(row2["suspension_count"]) if row2 else 1}
    return {"strikes": strikes, "suspended": False, "suspension_count": 0}

async def _reset_mechanic_strikes(db, mechanic_id: int) -> None:
    """A completed job is good conduct — clear the consecutive-cancel streak."""
    await db.execute(
        """
        INSERT INTO mechanic_strikes (mechanic_id, strikes, suspended, suspended_at, updated_at)
        VALUES ($1, 0, FALSE, NULL, NOW())
        ON CONFLICT (mechanic_id) DO UPDATE
            SET strikes = 0, suspended = FALSE, suspended_at = NULL, updated_at = NOW()
        """,
        mechanic_id,
    )

# ─── Platform fee ledger — MOTOFIX revenue (replaces the monthly subscription) ──
PLATFORM_FEE      = 10000  # flat UGX owed per completed job earned through the platform
FEE_GATE_JOBS     = 3      # strike-three: 3 unpaid completed jobs (UGX 30,000) is the threshold
FEE_DEFAULT_HOURS = 48     # hours an over-cap balance may sit before the account hard-locks
# Presentation choice: we surface the owed balance and the strike-three threshold, but we do
# NOT block or lock a mechanic for non-payment yet. Enforcing an access block on an informal,
# trust-first market is heavy-handed for a demo, so it's deliberately left for production —
# flip this to True there to re-arm the accept gate + hard-lock computed in `_fee_state`.
FEE_ENFORCE_GATE  = True

async def _accrue_platform_fee(db, mechanic_id: int, request_id: int) -> None:
    """A completed job → the mechanic owes a flat platform fee — UNLESS they are already
    at the cap. We hard-cap the unpaid balance at FEE_GATE_JOBS (3): once a mechanic owes
    3 unpaid fees they are gated from accepting new work, so any further completed job is
    waived rather than stacked on. This guarantees the owed balance never climbs past
    3 jobs (UGX 30,000) — the mechanic settles, then starts accruing again.
    request_id is UNIQUE so re-running the completion path never double-charges the same job."""
    # How many unpaid fees does this mechanic already have? (Skip this job's own row so a
    # harmless re-run of an already-recorded fee isn't mistaken for being over the cap.)
    owed_now = await db.fetchval(
        """SELECT COUNT(*) FROM platform_fees
           WHERE mechanic_id = $1 AND status = 'owed' AND request_id <> $2""",
        mechanic_id, request_id,
    )
    if owed_now is not None and owed_now >= FEE_GATE_JOBS:
        # Already at the 3-job cap — waive this fee instead of exceeding it.
        logger.info("Platform fee waived for job %s — mechanic %s already at the %s-job cap",
                    request_id, mechanic_id, FEE_GATE_JOBS)
        return
    await db.execute(
        """
        INSERT INTO platform_fees (request_id, mechanic_id, amount, status)
        VALUES ($1, $2, $3, 'owed')
        ON CONFLICT (request_id) DO NOTHING
        """,
        request_id, mechanic_id, PLATFORM_FEE,
    )

async def _fee_state(db, mechanic_id: int) -> dict:
    """Outstanding-fee snapshot used by the accept gate, the mechanic balance screen,
    and the hard-lock check. `gated` blocks accepting new jobs; `locked` is a full
    account lock once an over-cap balance has sat past the grace window."""
    # Join each owed fee back to the job that incurred it, so the mechanic sees exactly
    # which completed job each 10k is for (service, customer, what they earned, when it
    # finished) — an itemised statement they can't dispute, not just a bare amount.
    rows = await db.fetch(
        """
        SELECT pf.request_id, pf.amount, pf.created_at,
               sr.service_type, sr.customer_name, sr.location,
               sr.actual_fee, sr.completed_at, sr.service_note
        FROM platform_fees pf
        LEFT JOIN service_requests sr ON sr.id = pf.request_id
        WHERE pf.mechanic_id = $1 AND pf.status = 'owed'
        ORDER BY pf.created_at ASC
        """,
        mechanic_id,
    )
    jobs = [
        {
            "request_id": r["request_id"],
            "amount": int(r["amount"]),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "service_type": r["service_type"],
            "customer_name": r["customer_name"],
            "location": r["location"],
            "job_fee": int(r["actual_fee"]) if r["actual_fee"] is not None else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
            "service_note": r["service_note"],
        }
        for r in rows
    ]
    owed_count = len(jobs)
    over_threshold = owed_count >= FEE_GATE_JOBS
    # Enforcement (blocking new jobs / hard-locking) is off for the presentation — see
    # FEE_ENFORCE_GATE. The balance and progress toward the threshold are still reported so
    # the mechanic sees what they owe; we just don't act on it yet.
    gated = FEE_ENFORCE_GATE and over_threshold
    locked = False
    if gated and rows and rows[0]["created_at"] is not None:
        age_h = (datetime.utcnow() - rows[0]["created_at"].replace(tzinfo=None)).total_seconds() / 3600
        locked = age_h >= FEE_DEFAULT_HOURS
    return {
        "mechanic_id": mechanic_id,
        "owed_count": owed_count,
        "owed_amount": sum(j["amount"] for j in jobs),
        "fee_per_job": PLATFORM_FEE,
        "gate_jobs": FEE_GATE_JOBS,
        "gated": gated,
        "locked": locked,
        "jobs": jobs,
    }

def _parse_momo_amount(text: Optional[str]) -> Optional[int]:
    """AI/NLP payment detection — extract the shilling amount from a free-form Mobile
    Money confirmation message so a received payment can be matched to a mechanic's
    balance. In production this is complemented by the MoMo gateway webhook; here it
    reads the confirmation text the way our AI verification layer would. Returns the
    largest UGX-looking figure found (handles 'UGX 50,000', 'received 50000', etc.)."""
    if not text:
        return None
    import re
    vals = []
    for n in re.findall(r'([\d][\d,]{2,})', text):
        try:
            vals.append(int(n.replace(",", "")))
        except ValueError:
            pass
    return max(vals) if vals else None

async def _settle_fees(db, mechanic_id: int, amount: int, ref: Optional[str]) -> list[int]:
    """Apply a received payment to the oldest owed fees first. Returns the request_ids
    of the jobs cleared (so the admin notification can list which jobs were settled)."""
    rows = await db.fetch(
        "SELECT id, request_id, amount FROM platform_fees WHERE mechanic_id=$1 AND status='owed' ORDER BY created_at ASC",
        mechanic_id,
    )
    cleared_ids, cleared_reqs, remaining = [], [], amount
    for r in rows:
        if remaining >= int(r["amount"]):
            cleared_ids.append(r["id"]); cleared_reqs.append(int(r["request_id"])); remaining -= int(r["amount"])
        else:
            break
    if cleared_ids:
        await db.execute(
            "UPDATE platform_fees SET status='paid', paid_at=NOW(), payment_ref=$2 WHERE id = ANY($1::int[])",
            cleared_ids, ref,
        )
    return cleared_reqs

class FeePaymentPayload(BaseModel):
    sms_text: Optional[str] = None   # simulated/real MoMo confirmation message (AI-parsed)
    amount: Optional[int] = None     # or an explicit amount (fallback for the demo)
    reference: Optional[str] = None

@app.get("/fees/{mechanic_id}", tags=["Platform Fees"])
async def get_platform_fees(mechanic_id: int, db=Depends(get_db)):
    """Current owed platform-fee balance + the jobs it covers + gate/lock state."""
    return await _fee_state(db, mechanic_id)

@app.post("/fees/{mechanic_id}/pay", tags=["Platform Fees"])
async def pay_platform_fees(mechanic_id: int, body: FeePaymentPayload, db=Depends(get_db)):
    """Settle owed platform fees. The amount is taken from `amount`, or AI-detected from
    a Mobile Money confirmation `sms_text`. On success the balance is cleared, the
    account is un-gated, and the admin dashboard is notified in real time."""
    amount = body.amount if body.amount is not None else _parse_momo_amount(body.sms_text)
    if not amount or amount <= 0:
        raise HTTPException(status_code=400, detail="Could not detect a payment amount.")
    cleared = await _settle_fees(db, mechanic_id, int(amount), body.reference)
    state = await _fee_state(db, mechanic_id)
    # Notify admins in real time that a platform-fee payment landed. (The admin portal
    # also surfaces this via the polled notification feed — see analytics admin_notifications,
    # which reads the paid platform_fees rows — so it shows even if the WS is missed.)
    try:
        await manager.broadcast({
            "type": "platform_fee_paid",
            "mechanic_id": mechanic_id,
            "amount": int(amount),
            "cleared_jobs": len(cleared),
            "cleared_job_ids": cleared,
            "owed_remaining": state["owed_amount"],
            "detected_by": "ai_sms" if body.amount is None else "manual",
            "at": datetime.utcnow().isoformat() + "Z",
        })
    except Exception as e:
        logger.warning("fee-paid broadcast failed: %s", e)
    return {
        "detail": "Payment applied",
        "cleared_jobs": len(cleared),
        "cleared_job_ids": cleared,
        "amount": int(amount),
        "state": state,
    }

@app.get("/mechanics/{mechanic_id}/strikes", tags=["Cancellation"])
async def get_mechanic_strikes(mechanic_id: int, db=Depends(get_db)):
    """Current consecutive-cancellation strike count + suspension state for a mechanic."""
    s = await _get_strike_row(db, mechanic_id)
    sa = s.get("suspended_at")
    return {
        "mechanic_id": mechanic_id,
        "strikes": int(s["strikes"]),
        "suspended": bool(s["suspended"]),
        "suspended_at": sa.isoformat() if hasattr(sa, "isoformat") else sa,
        "suspension_count": int(s.get("suspension_count") or 0),
        "limit": STRIKE_LIMIT,
    }

@app.post("/mechanics/{mechanic_id}/reinstate", tags=["Cancellation"])
async def reinstate_mechanic(mechanic_id: int, db=Depends(get_db)):
    """Admin lifts a cancellation suspension after the mechanic has contacted support and
    explained themselves. Strikes reset to 0, but `suspension_count` is preserved so a
    repeat offence is treated as an escalation."""
    await db.execute(
        """
        UPDATE mechanic_strikes
           SET suspended = FALSE, suspended_at = NULL, strikes = 0, updated_at = NOW()
         WHERE mechanic_id = $1
        """,
        mechanic_id,
    )
    s = await _get_strike_row(db, mechanic_id)
    return {"detail": "Mechanic reinstated", "mechanic_id": mechanic_id,
            "suspension_count": int(s.get("suspension_count") or 0)}


@app.patch("/requests/{request_id}/status")
async def update_status(
    request_id: int,
    status: str,
    eta_minutes: Optional[int] = None,
    cancel_reason: Optional[str] = None,
    actual_fee: Optional[int] = None,
    note: Optional[str] = None,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    allowed_statuses = ["pending", "accepted", "en_route", "arrived", "service_started", "awaiting_confirmation", "completed", "cancelled"]
    if status not in allowed_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Allowed: {', '.join(allowed_statuses)}"
        )

    # Load request for auth + current state
    row = await db.fetchrow(
        "SELECT id, status, user_id, phone, mechanic_id, customer_name FROM service_requests WHERE id = $1",
        request_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Request not found")

    role = (current_user.get("role") or "driver").lower()
    user_id = current_user.get("id")
    user_phone = current_user.get("phone")

    # Authorization
    if role == "admin":
        pass
    elif role == "driver":
        # Drivers may cancel, confirm arrival / service start, mark the job done
        # (awaiting_confirmation), or confirm completion.
        if status not in ("cancelled", "completed", "arrived", "service_started", "awaiting_confirmation"):
            raise HTTPException(status_code=403, detail="Drivers can only cancel, confirm arrival, mark or confirm completion")
        owns = False
        if row.get("user_id") is not None and user_id is not None and int(row["user_id"]) == int(user_id):
            owns = True
        if user_phone and row.get("phone") == user_phone:
            owns = True
        if not owns:
            raise HTTPException(status_code=403, detail="Not allowed")
        # Confirming arrival / service start is only valid while the mechanic is on the way
        if status in ("arrived", "service_started") and row.get("status") not in ("en_route", "arrived"):
            raise HTTPException(status_code=400, detail="Mechanic must be on the way before you can confirm arrival")
        # Driver can mark "done" (awaiting_confirmation) only while service is underway
        if status == "awaiting_confirmation" and row.get("status") not in ("service_started",):
            raise HTTPException(status_code=400, detail="Service must be in progress before marking the job done")
        if status == "completed" and row.get("status") != "awaiting_confirmation":
            raise HTTPException(status_code=400, detail="Can only confirm completion when the job has been marked done")
    elif role == "mechanic":
        # Mechanics drive the journey, can cancel a job they picked up (before work
        # begins), and mark/confirm completion.
        if status not in ("en_route", "arrived", "service_started", "awaiting_confirmation", "completed", "cancelled"):
            raise HTTPException(status_code=403, detail="Mechanics cannot set this status")
        if row.get("mechanic_id") is None or user_id is None or int(row["mechanic_id"]) != int(user_id):
            raise HTTPException(status_code=403, detail="Not assigned to this job")
        # A mechanic may only back out before the work has started.
        if status == "cancelled" and row.get("status") not in ("accepted", "en_route", "arrived"):
            raise HTTPException(status_code=400, detail="You can only cancel before starting the service")
        # Mechanic can confirm completion only when the job is awaiting confirmation
        if status == "completed" and row.get("status") != "awaiting_confirmation":
            raise HTTPException(status_code=400, detail="Can only confirm completion when the job has been marked done")
    else:
        raise HTTPException(status_code=403, detail="Unauthorized")

    # Timestamp mapping
    ts_column = None
    if status == "en_route":
        ts_column = "en_route_at"
    elif status == "arrived":
        ts_column = "arrived_at"
    elif status == "service_started":
        ts_column = "service_started_at"
    elif status == "completed":
        ts_column = "completed_at"
    elif status == "accepted":
        ts_column = "accepted_at"
    elif status == "cancelled":
        ts_column = "cancelled_at"

    # Store the journey ETA when the mechanic starts driving — both apps derive the
    # shared arrival-time window from en_route_at + eta_minutes.
    if eta_minutes is not None and status == "en_route":
        await db.execute(
            "UPDATE service_requests SET eta_minutes = $1 WHERE id = $2",
            int(eta_minutes), request_id,
        )

    # Record who started the completion handshake + when (drives the confirm prompt
    # on the OTHER party's app and the 30-min auto-complete watchdog).
    if status == "awaiting_confirmation":
        await db.execute(
            "UPDATE service_requests SET awaiting_confirmation_at = NOW(), completion_by = $1 WHERE id = $2",
            role, request_id,
        )
        # Persist the mechanic's final charge + what-was-fixed note so the driver can
        # see the amount + breakdown and pay.
        if actual_fee is not None:
            await db.execute("UPDATE service_requests SET actual_fee = $1 WHERE id = $2", int(actual_fee), request_id)
        if note is not None:
            await db.execute("UPDATE service_requests SET service_note = $1 WHERE id = $2", note, request_id)

    if ts_column:
        await db.execute(
            f"UPDATE service_requests SET status = $1, {ts_column} = COALESCE({ts_column}, NOW()), updated_at = NOW() WHERE id = $2",
            status,
            request_id,
        )
    else:
        await db.execute(
            "UPDATE service_requests SET status = $1, updated_at = NOW() WHERE id = $2",
            status,
            request_id,
        )

    # Cancellation bookkeeping + mechanic strikes / reset on good conduct.
    cancel_outcome = None  # {"strikes", "suspended", "limit"} when a mechanic cancels
    if status == "cancelled":
        await db.execute(
            "UPDATE service_requests SET cancelled_by = $1, cancel_reason = $2 WHERE id = $3",
            role, cancel_reason, request_id,
        )
        if role == "mechanic" and row.get("mechanic_id") is not None:
            res = await _add_mechanic_strike(db, int(row["mechanic_id"]))
            cancel_outcome = {**res, "limit": STRIKE_LIMIT}
    elif status == "completed" and row.get("mechanic_id") is not None:
        # Completing a job is good conduct → clear the consecutive-cancel streak…
        await _reset_mechanic_strikes(db, int(row["mechanic_id"]))
        # …and it's a job earned through the platform → accrue the flat platform fee
        # the mechanic owes MOTOFIX (idempotent on request_id).
        await _accrue_platform_fee(db, int(row["mechanic_id"]), request_id)

    new_status = status
    phone = row["phone"]
    customer_name = row["customer_name"]

    # ──────── TRIGGER NOTIFICATIONS (best-effort, non-blocking) ────────
    _STATUS_LABELS = {
        "accepted": "A mechanic has accepted your request!",
        "en_route": "Your mechanic is on the way.",
        "arrived": "Your mechanic has arrived at your location.",
        "service_started": "Your mechanic has started working on your vehicle.",
        "awaiting_confirmation": "Your mechanic has marked the job as done. Open the MOTOFIX app to confirm.",
        "completed": "All done! Your job is complete. Thank you for using MOTOFIX.",
        "cancelled": "Your request has been cancelled.",
    }
    push_body = _STATUS_LABELS.get(new_status, f"Request status: {new_status.upper()}")
    # The driver-facing cancel message depends on who pulled out.
    if new_status == "cancelled" and role == "mechanic":
        push_body = "Your mechanic had to cancel this request. Sorry for the inconvenience — you can request another mechanic."
    sms_message = f"Hello {customer_name}, {push_body} [MOTOFIX]"

    notifications_url = os.getenv("NOTIFICATIONS_URL", "http://localhost:8004")

    # FCM token lookup needs the DB connection, so do it now (while we hold it). It may
    # fail (no users table here) — that's fine, FCM is then skipped.
    driver_fcm_token = None
    try:
        if row.get("user_id"):
            tok_row = await db.fetchrow("SELECT fcm_token FROM users WHERE id = $1", row.get("user_id"))
            driver_fcm_token = tok_row["fcm_token"] if tok_row else None
    except Exception:
        driver_fcm_token = None

    # SMS / WhatsApp / FCM are best-effort and currently flaky (the notifications service
    # can 500; there's no users table here for FCM). Awaiting them inline made every status
    # change — and especially job completion, which fires several in a row — hang for many
    # seconds. Fire them in the BACKGROUND so the mechanic/driver get an instant response;
    # the live UI update still happens via the WebSocket broadcast below. Short timeouts so
    # a hung notifications service can't pile tasks up.
    async def _send_status_notifications():
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
            try:
                await client.post(f"{notifications_url}/notify/sms", json={"to": phone, "message": sms_message})
                logger.info("SMS notification sent for request %s (status: %s)", request_id, new_status)
            except Exception as e:
                logger.warning("SMS notification failed for request %s: %s", request_id, e)
            try:
                await client.post(f"{notifications_url}/notify/whatsapp", json={"to": phone, "message": sms_message})
                logger.info("WhatsApp notification sent for request %s (status: %s)", request_id, new_status)
            except Exception as e:
                logger.warning("WhatsApp notification failed for request %s: %s", request_id, e)
            if driver_fcm_token:
                try:
                    await client.post(
                        f"{notifications_url}/notify/push",
                        json={
                            "device_token": driver_fcm_token,
                            "title": "MOTOFIX Update",
                            "body": push_body,
                            "data": {"request_id": str(request_id), "status": new_status, "type": "status_update"},
                        },
                    )
                    logger.info("FCM push sent to driver for request %s (status: %s)", request_id, new_status)
                except Exception as e:
                    logger.warning("FCM push notification failed for request %s: %s", request_id, e)

    _spawn_bg(_send_status_notifications())

    # Broadcast canonical status update for real-time clients
    snap = await db.fetchrow(
        """
        SELECT id, customer_name, service_type, location, description, status, created_at,
               user_id, mechanic_id, dispatched_at, accepted_at, en_route_at, arrived_at, service_started_at, completed_at, eta_minutes, completion_by, actual_fee, service_note
        FROM service_requests WHERE id = $1
        """,
        request_id,
    )
    if snap:
        payload = dict(snap)
        payload["id"] = str(payload["id"])
        if payload.get("created_at"):
            payload["created_at"] = payload["created_at"].isoformat()
        for k in ("dispatched_at", "accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at", "cancelled_at"):
            if payload.get(k):
                payload[k] = payload[k].isoformat()
        await manager.broadcast({
            "type": "status_update",
            "job_id": request_id,
            "status": new_status,
            "cancelled_by": role if new_status == "cancelled" else None,
            "cancel_reason": cancel_reason if new_status == "cancelled" else None,
            "request": payload,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        })

    return {"detail": "Status updated successfully", "new_status": new_status, "cancellation": cancel_outcome}

@app.delete("/requests/{request_id}")
async def delete_request(request_id: int, db=Depends(get_db)):
    query = "DELETE FROM service_requests WHERE id = $1 RETURNING id"
    result = await db.fetchrow(query, request_id)
    if not result:
        raise HTTPException(status_code=404, detail="Request not found")
    return {"detail": "Request deleted successfully"}

# ────────────────────────────── ADMIN DRIVER ENDPOINTS ──────────────────────────────

@app.get("/admin/drivers/{user_id}/requests")
async def get_driver_requests(user_id: int, db=Depends(get_db)):
    """Return all service requests for a specific driver (by user_id)."""
    rows = await db.fetch("""
        SELECT id, service_type, status, location, customer_name,
               mechanic_id, created_at, updated_at
        FROM service_requests
        WHERE user_id = $1
        ORDER BY created_at DESC
    """, user_id)
    return [dict(r) for r in rows]


@app.get("/admin/drivers/{user_id}/payments")
async def get_driver_payments(user_id: int, db=Depends(get_db)):
    """Return payment summary for a specific driver (joined through service_requests)."""
    row = await db.fetchrow("""
        SELECT
            COUNT(p.id)                                                                      AS total_transactions,
            COALESCE(SUM(p.quoted_amount) FILTER (WHERE p.collection_status = 'successful'), 0) AS total_paid,
            COALESCE(SUM(p.quoted_amount) FILTER (WHERE p.collection_status = 'pending'),    0) AS pending_amount,
            MAX(p.created_at)                                                                AS last_transaction_at
        FROM payments p
        JOIN service_requests sr ON p.request_id = sr.id
        WHERE sr.user_id = $1
    """, user_id)
    return dict(row) if row else {"total_transactions": 0, "total_paid": 0, "pending_amount": 0, "last_transaction_at": None}


# ────────────────────────────── STATS ENDPOINTS ──────────────────────────────

@app.get("/stats/")
async def get_stats(db=Depends(get_db)):
    """Public stats endpoint - no auth required"""
    try:
        stats = {
            "total_requests": await db.fetchval("SELECT COUNT(*) FROM service_requests"),
            "completed_jobs": await db.fetchval(
                "SELECT COUNT(*) FROM service_requests WHERE status = 'completed'"
            ),
            "pending_jobs": await db.fetchval(
                "SELECT COUNT(*) FROM service_requests WHERE status IN ('pending', 'accepted')"
            ),
            "total_mechanics": await db.fetchval("SELECT COUNT(*) FROM mechanics"),
            "verified_mechanics": await db.fetchval(
                "SELECT COUNT(*) FROM mechanics WHERE is_verified = true"
            ),
            # platform_fees is Motofix's actual revenue ledger; payments stores job-level quotes/collections.
            "revenue_collected_ugx": await db.fetchval(
                "SELECT COALESCE(SUM(amount), 0) FROM platform_fees WHERE status = 'paid'"
            ),
            "pending_collections_ugx": await db.fetchval(
                "SELECT COALESCE(SUM(amount), 0) FROM platform_fees WHERE status = 'owed'"
            ),
            "total_transactions": await db.fetchval("SELECT COUNT(*) FROM payments"),
            "as_of": datetime.utcnow().isoformat() + "Z",
        }
        logger.info("Stats endpoint called: %s total requests", stats["total_requests"])
        return stats
    except Exception as e:
        logger.exception("Stats endpoint failed")
        raise HTTPException(status_code=503, detail="Dashboard statistics are temporarily unavailable") from e

# ────────────────────────────── REVENUE ENDPOINTS ──────────────────────────────

@app.get("/revenue/")
async def get_revenue(days: int = 30, db=Depends(get_db)):
    """
    Returns daily Motofix platform-fee revenue (UGX) settled in the last N days.
    The payments table contains job-level quotes/collections, not platform revenue.
    """
    try:
        query = """
            SELECT to_char(COALESCE(paid_at, created_at)::date, 'YYYY-MM-DD') AS date,
                   COALESCE(SUM(amount), 0)::bigint AS amount
            FROM platform_fees
            WHERE status = 'paid'
              AND COALESCE(paid_at, created_at) >= NOW() - ($1 || ' days')::interval
            GROUP BY date
            ORDER BY date ASC
        """
        rows = await db.fetch(query, str(days))
        return [{"date": r["date"], "amount": int(r["amount"])} for r in rows]

    except Exception as e:
        logger.exception("Revenue endpoint failed")
        raise HTTPException(status_code=503, detail="Revenue data is temporarily unavailable") from e

# ════════════════════════════════ PAYMENTS & MTN MOMO ════════════════════════════════

# ── MoMo configuration ────────────────────────────────────────────────────────

MOMO_ENV = os.getenv("MOMO_ENVIRONMENT", "sandbox")
MOMO_BASE_URL = (
    "https://sandbox.momodeveloper.mtn.com"
    if MOMO_ENV == "sandbox"
    else "https://momodeveloper.mtn.com"
)
# Sandbox only accepts EUR; production uses UGX
MOMO_CURRENCY = os.getenv("MOMO_CURRENCY", "EUR" if MOMO_ENV == "sandbox" else "UGX")
MOMO_CALLBACK_URL = os.getenv(
    "MOMO_CALLBACK_URL",
    "https://motofix-dispatch.onrender.com/payments/callback",
)

MOMO_COL_USER_ID = os.getenv("MOMO_COLLECTIONS_USER_ID", "")
MOMO_COL_API_KEY = os.getenv("MOMO_COLLECTIONS_API_KEY", "")
MOMO_COL_PRIMARY_KEY = os.getenv("MOMO_COLLECTIONS_PRIMARY_KEY", "")

MOMO_DIS_USER_ID = os.getenv("MOMO_DISBURSEMENTS_USER_ID", "")
MOMO_DIS_API_KEY = os.getenv("MOMO_DISBURSEMENTS_API_KEY", "")
MOMO_DIS_PRIMARY_KEY = os.getenv("MOMO_DISBURSEMENTS_PRIMARY_KEY", "")

PLATFORM_COMMISSION = 10000  # UGX 10,000 flat commission per job


def _momo_network(phone: str | None) -> str:
    """Best-effort Ugandan MoMo network from a phone number prefix → 'mtn' | 'airtel' | 'momo'."""
    d = "".join(c for c in (phone or "") if c.isdigit())
    if d.startswith("256"):
        d = "0" + d[3:]
    elif len(d) == 9:
        d = "0" + d
    pre = d[:3]
    if pre in ("077", "078", "076", "039", "031"):
        return "mtn"
    if pre in ("070", "075", "074", "020"):
        return "airtel"
    return "momo"


# ── MoMo Pydantic models ─────────────────────────────────────────────────────

class QuoteRequest(BaseModel):
    request_id: int
    quoted_amount: int
    mechanic_phone: Optional[str] = None  # supplied by client as fallback


class CollectRequest(BaseModel):
    phone: str  # driver's MTN MoMo number


# ── MoMo helper functions ────────────────────────────────────────────────────

async def _get_momo_token(service: str) -> str:
    """Obtain a Bearer token for the given MoMo service ('collection'|'disbursement')."""
    if service == "collection":
        user_id, api_key, primary_key = MOMO_COL_USER_ID, MOMO_COL_API_KEY, MOMO_COL_PRIMARY_KEY
    else:
        user_id, api_key, primary_key = MOMO_DIS_USER_ID, MOMO_DIS_API_KEY, MOMO_DIS_PRIMARY_KEY

    logger.info(f"🔐 _get_momo_token: requesting {service} token from {MOMO_BASE_URL}/{service}/token/")
    credentials = base64.b64encode(f"{user_id}:{api_key}".encode()).decode()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MOMO_BASE_URL}/{service}/token/",
            headers={
                "Authorization": f"Basic {credentials}",
                "Ocp-Apim-Subscription-Key": primary_key,
            },
            timeout=30,
        )
        logger.info(f"🔐 _get_momo_token: token endpoint responded {resp.status_code}")
        if resp.status_code != 200:
            logger.error(f"🔐 _get_momo_token: error body: {resp.text}")
        resp.raise_for_status()
        token = resp.json()["access_token"]
        logger.info(f"🔑 MoMo token obtained: {token[:20]}...")
        return token


async def _mtn_collection_status(reference_id: str) -> str:
    """Query MTN for the current status of a requesttopay. Returns MTN status string
    (e.g. 'SUCCESSFUL', 'FAILED', 'PENDING') or 'RESOURCE_NOT_FOUND' if unknown."""
    try:
        token = await _get_momo_token("collection")
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{MOMO_BASE_URL}/collection/v1_0/requesttopay/{reference_id}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Target-Environment": MOMO_ENV,
                    "Ocp-Apim-Subscription-Key": MOMO_COL_PRIMARY_KEY,
                },
                timeout=15,
            )
        logger.info(f"🔍 _mtn_collection_status: ref={reference_id} status={resp.status_code} body={resp.text}")
        if resp.status_code == 404:
            return "RESOURCE_NOT_FOUND"
        resp.raise_for_status()
        return resp.json().get("status", "UNKNOWN").upper()
    except Exception as e:
        logger.warning(f"⚠️  _mtn_collection_status: could not query MTN for {reference_id}: {e}")
        return "UNKNOWN"


async def _initiate_collection(payment_id: int, amount: int, driver_phone: str, request_id: int, db) -> str:
    """Request payment from driver via MoMo Collections. Returns the X-Reference-Id."""
    reference_id = str(uuid.uuid4())
    logger.info(f"📲 _initiate_collection: payment_id={payment_id} amount={amount} driver_phone={driver_phone} reference_id={reference_id}")

    token = await _get_momo_token("collection")
    msisdn = driver_phone.lstrip("+")
    logger.info(f"📲 _initiate_collection: msisdn={msisdn} env={MOMO_ENV} currency={MOMO_CURRENCY}")

    payload = {
        "amount": str(amount),
        "currency": MOMO_CURRENCY,
        "externalId": f"motofix-{request_id}",
        "payer": {"partyIdType": "MSISDN", "partyId": msisdn},
        "payerMessage": f"MotoFix payment Job {request_id}",
        "payeeNote": f"MotoFix Job {request_id}",
    }
    logger.info(f"📲 _initiate_collection: request-to-pay payload: {payload}")

    # Build headers — omit X-Callback-Url in sandbox (MTN WAF rejects unregistered callback URLs).
    # Status is polled actively via payment_status endpoint so callbacks are not required.
    req_headers: dict = {
        "Authorization": f"Bearer {token}",
        "X-Reference-Id": reference_id,
        "X-Target-Environment": MOMO_ENV,
        "Ocp-Apim-Subscription-Key": MOMO_COL_PRIMARY_KEY,
        "Content-Type": "application/json",
    }
    if MOMO_ENV != "sandbox" and MOMO_CALLBACK_URL:
        req_headers["X-Callback-Url"] = MOMO_CALLBACK_URL

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MOMO_BASE_URL}/collection/v1_0/requesttopay",
            headers=req_headers,
            json=payload,
            timeout=30,
        )
        logger.info(f"📱 MTN response status: {resp.status_code}")
        logger.info(f"📱 MTN response body: {resp.text}")

        # Detect WAF/gateway HTML rejection (sometimes returned as HTTP 200)
        is_html = resp.text.lstrip().startswith("<")
        if is_html or resp.status_code not in (200, 202):
            logger.error(f"MoMo collection error {resp.status_code}: {resp.text}")
            raise HTTPException(status_code=502, detail=f"MoMo payment initiation failed: {resp.text}")

    await db.execute(
        "UPDATE payments SET collection_reference=$1, collection_status='initiated', provider='mtn' WHERE id=$2",
        reference_id, payment_id,
    )
    logger.info(f"📲 _initiate_collection: DB updated — collection_status='initiated' for payment {payment_id}")
    return reference_id


async def _initiate_disbursement(payment_id: int, amount: int, mechanic_phone: str, request_id: int, db) -> str:
    """Transfer payout to mechanic via MoMo Disbursements. Returns the X-Reference-Id."""
    reference_id = str(uuid.uuid4())
    token = await _get_momo_token("disbursement")
    msisdn = mechanic_phone.lstrip("+")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MOMO_BASE_URL}/disbursement/v1_0/transfer",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Reference-Id": reference_id,
                "X-Target-Environment": MOMO_ENV,
                "X-Callback-Url": MOMO_CALLBACK_URL,
                "Ocp-Apim-Subscription-Key": MOMO_DIS_PRIMARY_KEY,
                "Content-Type": "application/json",
            },
            json={
                "amount": str(amount),
                "currency": MOMO_CURRENCY,
                "externalId": f"motofix-payout-{request_id}",
                "payee": {"partyIdType": "MSISDN", "partyId": msisdn},
                "payerMessage": f"MotoFix payout for Job #{request_id}",
                "payeeNote": f"Your MotoFix earnings – Job #{request_id}",
            },
            timeout=30,
        )
        if resp.status_code not in (200, 202):
            logger.error(f"MoMo disbursement error {resp.status_code}: {resp.text}")
            raise HTTPException(status_code=502, detail=f"MoMo disbursement failed: {resp.text}")

    await db.execute(
        "UPDATE payments SET disbursement_reference=$1, disbursement_status='initiated' WHERE id=$2",
        reference_id, payment_id,
    )
    return reference_id


# ── Airtel Money configuration ────────────────────────────────────────────────

AIRTEL_ENV = os.getenv("AIRTEL_ENV", "sandbox")
AIRTEL_BASE_URL = (
    "https://openapiuat.airtel.africa"
    if AIRTEL_ENV == "sandbox"
    else "https://openapi.airtel.africa"
)
AIRTEL_CLIENT_ID     = os.getenv("AIRTEL_CLIENT_ID", "")
AIRTEL_CLIENT_SECRET = os.getenv("AIRTEL_CLIENT_SECRET", "")
AIRTEL_MERCHANT_PIN  = os.getenv("AIRTEL_MERCHANT_PIN", "")
AIRTEL_CURRENCY = "UGX"
AIRTEL_COUNTRY  = "UG"


def _detect_provider(phone: str) -> str:
    """Detect mobile money provider from Uganda phone number. Returns 'mtn' or 'airtel'."""
    n = phone.lstrip("+").strip()
    # MTN Uganda: 077x, 078x, 031x, 039x (in +256 format: 25677, 25678, 25631, 25639)
    if any(n.startswith(p) for p in ("25677", "25678", "25631", "25639")):
        return "mtn"
    # Airtel Uganda: 070x, 074x, 075x, 020x, 030x (in +256 format)
    if any(n.startswith(p) for p in ("25670", "25674", "25675", "25620", "25630")):
        return "airtel"
    return "mtn"  # default


async def _get_airtel_token() -> str:
    """Obtain an OAuth2 bearer token for the Airtel Money API."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{AIRTEL_BASE_URL}/auth/oauth2/token",
            headers={"Content-Type": "application/json", "Accept": "*/*"},
            json={
                "client_id": AIRTEL_CLIENT_ID,
                "client_secret": AIRTEL_CLIENT_SECRET,
                "grant_type": "client_credentials",
            },
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _airtel_collection_status(transaction_id: str) -> str:
    """Query Airtel for the current status of a collection.
    Returns normalised status: 'SUCCESSFUL', 'FAILED', 'PENDING', or 'RESOURCE_NOT_FOUND'."""
    try:
        token = await _get_airtel_token()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{AIRTEL_BASE_URL}/standard/v1/payments/{transaction_id}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Country": AIRTEL_COUNTRY,
                    "X-Currency": AIRTEL_CURRENCY,
                    "Accept": "*/*",
                },
                timeout=15,
            )
        if resp.status_code == 404:
            return "RESOURCE_NOT_FOUND"
        resp.raise_for_status()
        raw = resp.json().get("data", {}).get("transaction", {}).get("status", "TP")
        # TS=Successful, TF=Failed, TP=Pending, TIP=In-Progress
        if raw == "TS":
            return "SUCCESSFUL"
        if raw == "TF":
            return "FAILED"
        return "PENDING"
    except Exception as e:
        logger.warning(f"⚠️  _airtel_collection_status error for {transaction_id}: {e}")
        return "UNKNOWN"


async def _initiate_airtel_collection(payment_id: int, amount: int, driver_phone: str, request_id: int, db) -> str:
    """Request payment from driver via Airtel Money. Returns the transaction reference UUID."""
    reference_id = str(uuid.uuid4())
    token = await _get_airtel_token()
    msisdn = driver_phone.lstrip("+").strip()
    logger.info(f"📲 _initiate_airtel_collection: payment={payment_id} amount={amount} msisdn={msisdn}")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{AIRTEL_BASE_URL}/merchant/v1/payments/",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Country": AIRTEL_COUNTRY,
                "X-Currency": AIRTEL_CURRENCY,
                "Content-Type": "application/json",
                "Accept": "*/*",
            },
            json={
                "reference": f"MotoFix Job {request_id}",
                "subscriber": {
                    "country": AIRTEL_COUNTRY,
                    "currency": AIRTEL_CURRENCY,
                    "msisdn": msisdn,
                },
                "transaction": {
                    "amount": amount,
                    "country": AIRTEL_COUNTRY,
                    "currency": AIRTEL_CURRENCY,
                    "id": reference_id,
                },
            },
            timeout=30,
        )

    logger.info(f"📱 Airtel collection response: {resp.status_code} {resp.text}")
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Airtel payment initiation failed: {resp.text}")
    data = resp.json()
    if not data.get("status", {}).get("success", False):
        raise HTTPException(status_code=502, detail=f"Airtel payment rejected: {data}")

    await db.execute(
        "UPDATE payments SET collection_reference=$1, collection_status='initiated', provider='airtel' WHERE id=$2",
        reference_id, payment_id,
    )
    return reference_id


async def _initiate_airtel_disbursement(payment_id: int, amount: int, mechanic_phone: str, request_id: int, db) -> str:
    """Transfer payout to mechanic via Airtel Money B2C. Returns the transaction reference UUID."""
    reference_id = str(uuid.uuid4())
    token = await _get_airtel_token()
    msisdn = mechanic_phone.lstrip("+").strip()

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{AIRTEL_BASE_URL}/standard/v1/disbursements/",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Country": AIRTEL_COUNTRY,
                "X-Currency": AIRTEL_CURRENCY,
                "Content-Type": "application/json",
                "Accept": "*/*",
            },
            json={
                "payee": {"msisdn": msisdn},
                "reference": f"MotoFix payout Job {request_id}",
                "pin": AIRTEL_MERCHANT_PIN,
                "transaction": {
                    "amount": amount,
                    "id": reference_id,
                    "type": "B2C",
                },
            },
            timeout=30,
        )

    logger.info(f"📱 Airtel disbursement response: {resp.status_code} {resp.text}")
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"Airtel disbursement failed: {resp.text}")

    await db.execute(
        "UPDATE payments SET disbursement_reference=$1, disbursement_status='initiated' WHERE id=$2",
        reference_id, payment_id,
    )
    return reference_id


# ── Payment endpoints ─────────────────────────────────────────────────────────

@app.post("/payments/quote")
async def submit_quote(body: QuoteRequest, user=Depends(get_current_user), db=Depends(get_db)):
    """Mechanic submits a price quote. Called before or after accepting the job."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    if user.get("role") != "mechanic":
        raise HTTPException(status_code=403, detail="Only mechanics can submit quotes")

    mechanic_id = user["id"]

    request_row = await db.fetchrow("SELECT phone FROM service_requests WHERE id=$1", body.request_id)
    if not request_row:
        raise HTTPException(status_code=404, detail="Service request not found")

    # Prefer DB phone; fall back to value sent by client
    mechanic_row = await db.fetchrow("SELECT phone FROM mechanics WHERE id=$1", mechanic_id)
    mechanic_phone = (mechanic_row["phone"] if mechanic_row else None) or body.mechanic_phone or ""
    driver_phone = request_row["phone"]

    mechanic_payout = body.quoted_amount - PLATFORM_COMMISSION

    existing = await db.fetchrow("SELECT id FROM payments WHERE request_id=$1", body.request_id)
    if existing:
        row = await db.fetchrow(
            """UPDATE payments
               SET quoted_amount=$1, commission=$2, mechanic_payout=$3,
                   mechanic_id=$4, mechanic_phone=$5, driver_phone=$6
               WHERE request_id=$7 RETURNING *""",
            body.quoted_amount, PLATFORM_COMMISSION, mechanic_payout,
            mechanic_id, mechanic_phone, driver_phone, body.request_id,
        )
    else:
        row = await db.fetchrow(
            """INSERT INTO payments
               (request_id, mechanic_id, mechanic_phone, driver_phone, quoted_amount, commission, mechanic_payout)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
            body.request_id, mechanic_id, mechanic_phone, driver_phone,
            body.quoted_amount, PLATFORM_COMMISSION, mechanic_payout,
        )

    result = dict(row)
    result.pop("driver_phone", None)
    result.pop("mechanic_phone", None)
    return result


@app.get("/payments/quote/{request_id}")
async def get_quote(request_id: int, db=Depends(get_db)):
    """Driver or mechanic fetches the current price quote for a job. No auth required — quote amount is not sensitive."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    row = await db.fetchrow("SELECT * FROM payments WHERE request_id=$1", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="No quote found for this request")
    result = dict(row)
    result.pop("driver_phone", None)
    result.pop("mechanic_phone", None)
    return result


@app.post("/payments/approve/{request_id}")
async def approve_quote(request_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    """Driver approves the mechanic's price quote."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    request_row = await db.fetchrow("SELECT phone FROM service_requests WHERE id=$1", request_id)
    if not request_row:
        raise HTTPException(status_code=404, detail="Request not found")

    if user.get("phone") != request_row["phone"]:
        raise HTTPException(status_code=403, detail="Not authorized to approve this quote")

    payment = await db.fetchrow("SELECT * FROM payments WHERE request_id=$1", request_id)
    if not payment:
        raise HTTPException(status_code=404, detail="No quote found for this request")

    if payment["quote_approved"]:
        return {"detail": "Quote already approved", "request_id": request_id}

    await db.execute("UPDATE payments SET quote_approved=TRUE WHERE request_id=$1", request_id)
    return {"detail": "Quote approved", "request_id": request_id}


@app.post("/payments/collect/{request_id}")
async def collect_payment(request_id: int, body: CollectRequest, user=Depends(get_current_user), db=Depends(get_db)):
    """Initiate MTN MoMo collection from driver after job completion."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    logger.info(f"🔄 collect called for request_id={request_id} by user={user.get('phone')}")

    request_row = await db.fetchrow("SELECT phone, status FROM service_requests WHERE id=$1", request_id)
    if not request_row:
        logger.warning(f"❌ collect: request {request_id} not found")
        raise HTTPException(status_code=404, detail="Request not found")

    def _normalise_phone(p: str) -> str:
        return (p or "").lstrip("+").strip()

    user_phone = user.get("phone")
    if user_phone:
        # Token carries phone — compare directly (handles +256 vs 256 format differences)
        if _normalise_phone(user_phone) != _normalise_phone(request_row["phone"]):
            logger.warning(f"❌ collect: auth mismatch — token phone={user_phone} request phone={request_row['phone']}")
            raise HTTPException(status_code=403, detail="Not authorized")
    else:
        # Old token without phone claim — still authenticated, log and continue
        logger.warning(f"⚠️  collect: token for user id={user.get('id')} has no phone claim; skipping phone check")

    payment = await db.fetchrow("SELECT * FROM payments WHERE request_id=$1", request_id)
    if not payment:
        logger.warning(f"❌ collect: no payment record for request {request_id}")
        raise HTTPException(status_code=404, detail="No quote found – mechanic must submit a quote first")

    logger.info(f"📋 collect: payment id={payment['id']} quote_approved={payment['quote_approved']} collection_status={payment['collection_status']}")

    if request_row["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Payment is only available after the job is completed (current: {request_row['status']})")

    # Auto-approve quote at payment time — driver confirming payment is implicit approval
    if not payment["quote_approved"]:
        await db.execute("UPDATE payments SET quote_approved=TRUE WHERE id=$1", payment["id"])
        payment = dict(payment)
        payment["quote_approved"] = True
        logger.info(f"✅ collect: auto-approved quote for payment {payment['id']}")

    if payment["collection_status"] == "successful":
        logger.info(f"⏭️  collect: already succeeded for payment {payment['id']}, returning early")
        return {
            "detail": "Payment already success",
            "reference_id": payment["collection_reference"],
            "amount": payment["quoted_amount"],
        }

    if payment["collection_status"] == "initiated":
        ref = payment["collection_reference"]
        _prov = payment.get("provider") or "mtn"
        if _prov == "airtel":
            _current_status = await _airtel_collection_status(ref) if ref else "RESOURCE_NOT_FOUND"
        else:
            _current_status = await _mtn_collection_status(ref) if ref else "RESOURCE_NOT_FOUND"
        logger.info(f"🔍 collect: DB says initiated, {_prov} says {_current_status} for ref={ref}")
        if _current_status not in ("RESOURCE_NOT_FOUND", "FAILED", "TIMEOUT", "EXPIRED", "UNKNOWN"):
            # MTN knows about it and it's still pending or succeeded — don't double-charge
            return {
                "detail": "Payment already initiated",
                "reference_id": ref,
                "amount": payment["quoted_amount"],
            }
        # Ghost/failed reference — reset so we can try again
        logger.info(f"🔄 collect: resetting ghost/failed reference {ref} for payment {payment['id']}")
        await db.execute(
            "UPDATE payments SET collection_status='pending', collection_reference=NULL WHERE id=$1",
            payment["id"],
        )
        payment = await db.fetchrow("SELECT * FROM payments WHERE id=$1", payment["id"])

    driver_phone = body.phone or payment["driver_phone"] or request_row["phone"]
    provider = _detect_provider(driver_phone)
    logger.info(f"📞 collect: driver_phone={driver_phone} provider={provider}")

    try:
        if provider == "airtel":
            reference_id = await _initiate_airtel_collection(
                payment["id"], payment["quoted_amount"], driver_phone, request_id, db
            )
        else:
            reference_id = await _initiate_collection(
                payment["id"], payment["quoted_amount"], driver_phone, request_id, db
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"💥 collect: unexpected error for payment {payment['id']}: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail="Payment initiation failed. Please try again.")

    logger.info(f"✅ collect: initiated reference_id={reference_id} for payment {payment['id']}")
    return {"detail": "Payment initiated", "reference_id": reference_id, "amount": payment["quoted_amount"]}


@app.post("/payments/cash/{request_id}", tags=["Payments"])
async def pay_cash(request_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    """Record a cash payment for a completed job. Sets collection_status='cash'."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")

    request_row = await db.fetchrow("SELECT phone, status FROM service_requests WHERE id=$1", request_id)
    if not request_row:
        raise HTTPException(status_code=404, detail="Request not found")

    if request_row["status"] != "completed":
        raise HTTPException(
            status_code=400,
            detail=f"Cash payment only available after job completion (current: {request_row['status']})",
        )

    payment = await db.fetchrow("SELECT * FROM payments WHERE request_id=$1", request_id)
    if not payment:
        raise HTTPException(status_code=404, detail="No quote found – mechanic must submit a quote first")

    if payment["collection_status"] in ("successful", "cash"):
        return {"detail": "Payment already recorded", "amount": payment["quoted_amount"]}

    await db.execute(
        "UPDATE payments SET collection_status='cash', quote_approved=TRUE WHERE id=$1",
        payment["id"],
    )
    logger.info(f"💵 cash payment: request {request_id} marked as cash-paid (payment {payment['id']})")
    return {"detail": "Cash payment recorded", "amount": payment["quoted_amount"]}


@app.post("/payments/record/{request_id}", tags=["Payments"])
async def record_payment(request_id: int, method: str = "momo", user=Depends(get_current_user), db=Depends(get_db)):
    """Persist a completed (simulated) job payment so it shows in admin revenue/payments.

    Unlike /payments/collect and /payments/cash this is NOT gated by the payments
    feature flag — it's the persistence hook for the in-app simulated pay flow. It
    derives the amount from the request's final bill (actual_fee) and marks the
    payment collected ('success') so analytics revenue reflects it."""
    req = await db.fetchrow(
        "SELECT phone, actual_fee, mechanic_id FROM service_requests WHERE id=$1",
        request_id,
    )
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    amount = int(req["actual_fee"] or 0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="No final bill on this request yet")
    mechanic_id = req["mechanic_id"]
    driver_phone = req["phone"]
    mech = await db.fetchrow("SELECT phone FROM mechanics WHERE id=$1", mechanic_id) if mechanic_id else None
    mechanic_phone = (mech["phone"] if mech else None) or ""
    payout = amount - PLATFORM_COMMISSION
    # Record HOW it was paid: cash, or the MoMo network inferred from the mechanic's
    # number (so admin sees "MTN" / "Airtel" rather than a generic "momo").
    provider = "cash" if method == "cash" else _momo_network(mechanic_phone)

    existing = await db.fetchrow("SELECT id, collection_status FROM payments WHERE request_id=$1", request_id)
    if existing and existing["collection_status"] in ("success", "successful", "cash"):
        return {"detail": "Payment already recorded", "amount": amount}
    if existing:
        await db.execute(
            """UPDATE payments SET quoted_amount=$1, commission=$2, mechanic_payout=$3,
                   mechanic_id=$4, mechanic_phone=$5, driver_phone=$6,
                   collection_status='success', disbursement_status='pending',
                   quote_approved=TRUE, provider=$7
               WHERE id=$8""",
            amount, PLATFORM_COMMISSION, payout, mechanic_id, mechanic_phone, driver_phone, provider, existing["id"],
        )
    else:
        await db.execute(
            """INSERT INTO payments
               (request_id, mechanic_id, mechanic_phone, driver_phone, quoted_amount,
                commission, mechanic_payout, collection_status, disbursement_status,
                quote_approved, provider)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'success','pending',TRUE,$8)""",
            request_id, mechanic_id, mechanic_phone, driver_phone, amount,
            PLATFORM_COMMISSION, payout, provider,
        )
    logger.info(f"🧾 Recorded simulated payment for request {request_id}: {amount} UGX ({provider})")
    return {"detail": "Payment recorded", "amount": amount, "method": provider}


@app.get("/payments/status/{request_id}")
async def payment_status(request_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    """Check payment status for a job. Actively syncs with MTN when status is 'initiated'."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    row = await db.fetchrow("SELECT * FROM payments WHERE request_id=$1", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="No payment record found")

    if row["collection_status"] == "initiated" and row["collection_reference"]:
        _row_provider = row.get("provider") or "mtn"
        if _row_provider == "airtel":
            _status = await _airtel_collection_status(row["collection_reference"])
        else:
            _status = await _mtn_collection_status(row["collection_reference"])
        logger.info(f"📊 payment_status: request={request_id} {_row_provider} status={_status}")

        if _status == "SUCCESSFUL":
            await db.execute("UPDATE payments SET collection_status='successful' WHERE id=$1", row["id"])
            try:
                if _row_provider == "airtel":
                    await _initiate_airtel_disbursement(row["id"], row["mechanic_payout"], row["mechanic_phone"], request_id, db)
                else:
                    await _initiate_disbursement(row["id"], row["mechanic_payout"], row["mechanic_phone"], request_id, db)
            except Exception as e:
                logger.error(f"Auto-disbursement failed for payment {row['id']}: {e}")
            row = await db.fetchrow("SELECT * FROM payments WHERE id=$1", row["id"])
        elif _status in ("FAILED", "TIMEOUT", "EXPIRED"):
            await db.execute("UPDATE payments SET collection_status='failed' WHERE id=$1", row["id"])
            row = await db.fetchrow("SELECT * FROM payments WHERE id=$1", row["id"])
        elif _status == "RESOURCE_NOT_FOUND":
            age_seconds = (datetime.utcnow() - row["created_at"].replace(tzinfo=None)).total_seconds()
            if age_seconds > 180:
                logger.warning(f"📊 payment_status: ref={row['collection_reference']} not found in {_row_provider} after {age_seconds:.0f}s — marking failed")
                await db.execute(
                    "UPDATE payments SET collection_status='failed', collection_reference=NULL WHERE id=$1",
                    row["id"],
                )
                row = await db.fetchrow("SELECT * FROM payments WHERE id=$1", row["id"])
            else:
                logger.info(f"📊 payment_status: ref={row['collection_reference']} not found in {_row_provider} yet (age {age_seconds:.0f}s) — waiting")

    result = dict(row)
    result.pop("driver_phone", None)
    result.pop("mechanic_phone", None)
    return result


@app.post("/payments/callback")
async def momo_callback(request: Request, db=Depends(get_db)):
    """Payment webhook callback — handles both MTN MoMo and Airtel Money events."""
    if not await is_feature_enabled(db, "payments", default=False):
        logger.info("Payment callback received but payments are disabled; ignoring.")
        return {"detail": "ok"}
    try:
        body = await request.json()
    except Exception:
        body = {}

    logger.info(f"Payment callback: {body}")

    # MTN MoMo reference fields
    reference_id = (
        body.get("referenceId")
        or body.get("financialTransactionId")
        or body.get("externalId")
        or body.get("X-Reference-Id")
    )
    raw_status = (body.get("status") or "").upper()

    # Airtel Money reference fields (nested under data.transaction)
    airtel_txn = body.get("data", {}).get("transaction", {})
    if not reference_id and airtel_txn:
        reference_id = airtel_txn.get("id")
        airtel_raw = airtel_txn.get("status", "")
        raw_status = "SUCCESSFUL" if airtel_raw == "TS" else ("FAILED" if airtel_raw == "TF" else airtel_raw.upper())

    if not reference_id:
        return {"detail": "ok"}

    is_success = raw_status in ("SUCCESSFUL", "SUCCESS")
    is_failed = raw_status in ("FAILED", "TIMEOUT", "EXPIRED")

    # Check collections first
    payment = await db.fetchrow("SELECT * FROM payments WHERE collection_reference=$1", reference_id)
    if payment:
        if is_success:
            await db.execute("UPDATE payments SET collection_status='successful' WHERE id=$1", payment["id"])
            try:
                _cb_provider = payment.get("provider") or "mtn"
                if _cb_provider == "airtel":
                    await _initiate_airtel_disbursement(
                        payment["id"], payment["mechanic_payout"],
                        payment["mechanic_phone"], payment["request_id"], db,
                    )
                else:
                    await _initiate_disbursement(
                        payment["id"], payment["mechanic_payout"],
                        payment["mechanic_phone"], payment["request_id"], db,
                    )
                logger.info(f"Auto-disbursement triggered for payment {payment['id']}")
            except Exception as e:
                logger.error(f"Auto-disbursement failed for payment {payment['id']}: {e}")
        elif is_failed:
            await db.execute("UPDATE payments SET collection_status='failed' WHERE id=$1", payment["id"])
        return {"detail": "collection processed"}

    # Check disbursements
    payment = await db.fetchrow("SELECT * FROM payments WHERE disbursement_reference=$1", reference_id)
    if payment:
        if is_success:
            await db.execute("UPDATE payments SET disbursement_status='successful' WHERE id=$1", payment["id"])
        elif is_failed:
            await db.execute("UPDATE payments SET disbursement_status='failed' WHERE id=$1", payment["id"])
        return {"detail": "disbursement processed"}

    return {"detail": "ok"}


@app.post("/payments/disburse/{request_id}")
async def trigger_disbursement(request_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    """Manually trigger mechanic payout (admin fallback if auto-disburse failed)."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    payment = await db.fetchrow("SELECT * FROM payments WHERE request_id=$1", request_id)
    if not payment:
        raise HTTPException(status_code=404, detail="No payment found")

    if payment["collection_status"] != "successful":
        raise HTTPException(status_code=400, detail="Collection must succeed before disbursement")

    if payment["disbursement_status"] in ("initiated", "successful"):
        return {"detail": "Disbursement already " + payment["disbursement_status"]}

    try:
        _dis_provider = payment.get("provider") or _detect_provider(payment["mechanic_phone"] or "")
        if _dis_provider == "airtel":
            reference_id = await _initiate_airtel_disbursement(
                payment["id"], payment["mechanic_payout"],
                payment["mechanic_phone"], request_id, db,
            )
        else:
            reference_id = await _initiate_disbursement(
                payment["id"], payment["mechanic_payout"],
                payment["mechanic_phone"], request_id, db,
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Disbursement error: {e}")
        raise HTTPException(status_code=502, detail="Disbursement failed")

    return {"detail": "Disbursement initiated", "reference_id": reference_id}


@app.get("/payments/earnings/{mechanic_id}")
async def mechanic_earnings(mechanic_id: int, user=Depends(get_current_user), db=Depends(get_db)):
    """Mechanic's earnings history with totals."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    rows = await db.fetch(
        """SELECT p.id, p.request_id, p.quoted_amount, p.commission, p.mechanic_payout,
                  p.collection_status, p.disbursement_status, p.created_at,
                  sr.customer_name, sr.service_type
           FROM payments p
           JOIN service_requests sr ON p.request_id = sr.id
           WHERE p.mechanic_id = $1
           ORDER BY p.created_at DESC""",
        mechanic_id,
    )

    earnings = [dict(r) for r in rows]
    now = datetime.utcnow()

    total_earned = sum(
        (e["mechanic_payout"] or 0) for e in earnings if e["disbursement_status"] == "successful"
    )
    this_month = sum(
        (e["mechanic_payout"] or 0)
        for e in earnings
        if e["disbursement_status"] == "successful"
        and e["created_at"].month == now.month
        and e["created_at"].year == now.year
    )

    return {"total_earned": total_earned, "this_month": this_month, "earnings": earnings}


@app.get("/payments/transactions")
async def all_transactions(page: int = 1, page_size: int = 50, db=Depends(get_db)):
    """All payment transactions – used by admin dashboard."""
    if not await is_feature_enabled(db, "payments", default=False):
        raise HTTPException(status_code=404, detail="Payments feature is disabled")
    offset = (page - 1) * page_size
    rows = await db.fetch(
        """SELECT p.id, p.request_id, p.quoted_amount, p.commission, p.mechanic_payout,
                  p.collection_status, p.disbursement_status, p.collection_reference,
                  p.disbursement_reference, p.created_at,
                  sr.customer_name, sr.phone as driver_phone,
                  m.full_name as mechanic_name, p.mechanic_id
           FROM payments p
           JOIN service_requests sr ON p.request_id = sr.id
           LEFT JOIN mechanics m ON p.mechanic_id = m.id
           ORDER BY p.created_at DESC
           LIMIT $1 OFFSET $2""",
        page_size, offset,
    )
    total = await db.fetchval("SELECT COUNT(*) FROM payments") or 0
    return {"data": [dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


# ────────────────────────────── CORS DEBUG ENDPOINTS ──────────────────────────────
# ════════════════════════════════ REVIEWS & RATINGS ════════════════════════════════

class ReviewCreate(BaseModel):
    rating: int      # 1–5
    comment: str = ""


class ReviewOut(BaseModel):
    id: int
    request_id: int
    mechanic_id: int
    reviewer_id: int
    rating: int
    comment: str
    direction: Optional[str] = "driver_to_mechanic"
    created_at: Optional[str] = None


@app.post("/requests/{request_id}/review", response_model=ReviewOut, tags=["Reviews"])
async def submit_review(
    request_id: int,
    body: ReviewCreate,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Submit a star rating + optional comment after a job is completed.
    - Drivers submit direction='driver_to_mechanic' (rating the mechanic).
    - Mechanics submit direction='mechanic_to_driver' (rating the driver).
    - One review per direction per request (UNIQUE on request_id, direction).
    - Driver reviews update the mechanic's rolling avg_rating.
    """
    role = (current_user.get("role") or "driver").lower()
    if role not in ("driver", "mechanic", "admin"):
        raise HTTPException(status_code=403, detail="Not authorized to leave a review")

    if not (1 <= body.rating <= 5):
        raise HTTPException(status_code=422, detail="Rating must be between 1 and 5")

    # Load the request
    req_row = await db.fetchrow(
        "SELECT id, status, user_id, phone, mechanic_id FROM service_requests WHERE id = $1",
        request_id,
    )
    if not req_row:
        raise HTTPException(status_code=404, detail="Request not found")

    if req_row["status"] not in ("completed", "awaiting_confirmation"):
        raise HTTPException(
            status_code=400,
            detail=f"Reviews are only allowed for completed jobs (current status: {req_row['status']})"
        )

    mechanic_id = req_row.get("mechanic_id")
    if not mechanic_id:
        raise HTTPException(status_code=400, detail="No mechanic assigned to this request")

    # Verify ownership and set direction
    if role == "mechanic":
        direction = "mechanic_to_driver"
        caller_id = current_user.get("id")
        if caller_id is not None and int(caller_id) != int(mechanic_id):
            raise HTTPException(status_code=403, detail="Not authorized to review this request")
    else:
        direction = "driver_to_mechanic"
        uid = current_user.get("id")
        phone = current_user.get("phone")
        owns = (
            (req_row.get("user_id") is not None and uid is not None and int(req_row["user_id"]) == int(uid))
            or (phone and req_row.get("phone") == phone)
        )
        if role == "driver" and not owns:
            raise HTTPException(status_code=403, detail="Not authorized to review this request")

    reviewer_id = int(current_user.get("id"))

    try:
        row = await db.fetchrow(
            """
            INSERT INTO reviews (request_id, mechanic_id, reviewer_id, rating, comment, direction)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, request_id, mechanic_id, reviewer_id, rating, comment, direction, created_at
            """,
            request_id, mechanic_id, reviewer_id, body.rating, body.comment, direction,
        )
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="You have already reviewed this job")
        raise HTTPException(status_code=500, detail=f"Failed to save review: {e}")

    # Update mechanic's rolling avg_rating — only for driver-to-mechanic reviews
    if direction == "driver_to_mechanic":
        try:
            await db.execute(
                """
                UPDATE mechanics
                SET total_ratings  = COALESCE(total_ratings, 0) + 1,
                    rating         = (
                        (COALESCE(rating, 0) * COALESCE(total_ratings, 0) + $1)
                        / (COALESCE(total_ratings, 0) + 1)
                    )
                WHERE id = $2
                """,
                float(body.rating), mechanic_id,
            )
            logger.info("✅ Mechanic %s rating updated after review on request %s", mechanic_id, request_id)
        except Exception as e:
            logger.warning("⚠️  Could not update mechanic rating (non-fatal): %s", e)

    result = dict(row)
    if result.get("created_at"):
        result["created_at"] = result["created_at"].isoformat()

    return result


@app.get("/requests/{request_id}/review", response_model=ReviewOut, tags=["Reviews"])
async def get_review(
    request_id: int,
    direction: str = "driver_to_mechanic",
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Fetch the review for a specific completed job. Use direction=mechanic_to_driver for mechanic's review of driver."""
    row = await db.fetchrow(
        "SELECT id, request_id, mechanic_id, reviewer_id, rating, comment, direction, created_at FROM reviews WHERE request_id = $1 AND direction = $2",
        request_id, direction,
    )
    if not row:
        raise HTTPException(status_code=404, detail="No review found for this request")
    result = dict(row)
    if result.get("created_at"):
        result["created_at"] = result["created_at"].isoformat()
    return result


@app.get("/mechanics/{mechanic_id}/reviews", tags=["Reviews"])
async def get_mechanic_reviews(
    mechanic_id: int,
    limit: int = 20,
    offset: int = 0,
    db=Depends(get_db),
):
    """
    List all reviews for a mechanic, newest first.
    Public endpoint — no auth required (ratings are public information).
    """
    rows = await db.fetch(
        """
        SELECT r.id, r.request_id, r.rating, r.comment, r.created_at,
               sr.customer_name, sr.service_type
        FROM reviews r
        JOIN service_requests sr ON sr.id = r.request_id
        WHERE r.mechanic_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3
        """,
        mechanic_id, limit, offset,
    )
    total = await db.fetchval("SELECT COUNT(*) FROM reviews WHERE mechanic_id = $1", mechanic_id)
    avg = await db.fetchval("SELECT AVG(rating)::NUMERIC(3,2) FROM reviews WHERE mechanic_id = $1", mechanic_id)

    reviews = []
    for r in rows:
        rv = dict(r)
        if rv.get("created_at"):
            rv["created_at"] = rv["created_at"].isoformat()
        reviews.append(rv)

    return {
        "mechanic_id": mechanic_id,
        "total_reviews": total or 0,
        "average_rating": float(avg) if avg else None,
        "reviews": reviews,
    }


@app.get("/mechanics/{mechanic_id}/completed-jobs", tags=["Jobs"])
async def get_mechanic_completed_jobs(mechanic_id: int, limit: int = 200, db=Depends(get_db)):
    """A mechanic's completed jobs, newest first — powers Job History and the
    Today / This-Week dashboard stats. The data lives in the DB so admins can audit it."""
    rows = await db.fetch(
        """
        SELECT sr.id, sr.service_type, sr.customer_name, sr.location,
               sr.description, sr.status, sr.created_at, sr.completed_at,
               sr.en_route_at, sr.arrived_at, sr.service_started_at
        FROM service_requests sr
        WHERE sr.mechanic_id = $1 AND sr.status = 'completed'
        ORDER BY sr.completed_at DESC NULLS LAST
        LIMIT $2
        """,
        mechanic_id, limit,
    )
    jobs = []
    for r in rows:
        j = dict(r)
        for k in ("created_at", "completed_at", "en_route_at", "arrived_at", "service_started_at"):
            if j.get(k):
                j[k] = j[k].isoformat()
        jobs.append(j)
    return {"mechanic_id": mechanic_id, "total": len(jobs), "jobs": jobs}


# Jobs that count as "handled" once picked up. A request counts the moment the
# mechanic accepts it (accepted_at) and stays counted unless it is cancelled —
# so the dashboard's Today / This-Week totals tally from accepted_at, and a
# cancelled job drops out (taking the count back down). Stored in the DB so
# admins can audit it.
_HANDLED_STATUSES = (
    'accepted', 'en_route', 'arrived', 'service_started',
    'in_progress', 'awaiting_confirmation', 'completed',
)

@app.get("/mechanics/{mechanic_id}/handled-jobs", tags=["Jobs"])
async def get_mechanic_handled_jobs(mechanic_id: int, limit: int = 200, db=Depends(get_db)):
    """A mechanic's handled jobs — every request they have picked up (accepted
    onward) that has NOT been cancelled, newest pickup first. Powers the
    Today / This-Week counts, which tally from accepted_at."""
    rows = await db.fetch(
        """
        SELECT sr.id, sr.service_type, sr.customer_name, sr.location,
               sr.description, sr.status, sr.created_at, sr.accepted_at,
               sr.en_route_at, sr.arrived_at, sr.service_started_at, sr.completed_at
        FROM service_requests sr
        WHERE sr.mechanic_id = $1 AND sr.status = ANY($2::text[])
        ORDER BY sr.accepted_at DESC NULLS LAST
        LIMIT $3
        """,
        mechanic_id, list(_HANDLED_STATUSES), limit,
    )
    jobs = []
    for r in rows:
        j = dict(r)
        for k in ("created_at", "accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at"):
            if j.get(k):
                j[k] = j[k].isoformat()
        jobs.append(j)
    return {"mechanic_id": mechanic_id, "total": len(jobs), "jobs": jobs}


@app.get("/mechanics/{mechanic_id}/job-history", tags=["Jobs"])
async def get_mechanic_job_history(mechanic_id: int, limit: int = 200, db=Depends(get_db)):
    """A mechanic's finished jobs — both COMPLETED and CANCELLED — newest first.
    Powers the Job History list (with cancel reasons for review)."""
    rows = await db.fetch(
        """
        SELECT sr.id, sr.service_type, sr.customer_name, sr.location,
               sr.description, sr.status, sr.created_at, sr.accepted_at,
               sr.en_route_at, sr.arrived_at, sr.service_started_at, sr.completed_at,
               sr.cancelled_by, sr.cancel_reason
        FROM service_requests sr
        WHERE sr.mechanic_id = $1 AND sr.status IN ('completed', 'cancelled')
        ORDER BY COALESCE(sr.completed_at, sr.created_at) DESC NULLS LAST
        LIMIT $2
        """, mechanic_id, limit)
    jobs = []
    for r in rows:
        j = dict(r)
        for k in ("created_at", "accepted_at", "en_route_at", "arrived_at", "service_started_at", "completed_at"):
            if j.get(k):
                j[k] = j[k].isoformat()
        jobs.append(j)
    return {"mechanic_id": mechanic_id, "total": len(jobs), "jobs": jobs}


# ════════════════════════════════ IN-JOB CHAT ════════════════════════════════
# Persisted, two-way chat between a driver and the mechanic on a request. Messages
# survive refresh, load as history, reach the other party even if they were
# offline, and broadcast live over the WebSocket. Each message is auto-"seen" by
# its sender; unread = the other party's messages this side hasn't opened yet.

class ChatSendIn(BaseModel):
    sender_role: str            # 'driver' | 'mechanic'
    sender_id: str = ""
    body: str = ""
    media_type: str = "none"    # 'none' | 'voice' | 'image'
    media_url: Optional[str] = None


def _chat_row_to_dict(r) -> dict:
    d = dict(r)
    if d.get("created_at"):
        d["created_at"] = d["created_at"].isoformat()
    return d


async def _broadcast_chat(msg: dict):
    try:
        await manager.broadcast({
            "type": "chat_message",
            "service_request_id": str(msg["request_id"]),
            "id": msg["id"],
            "sender_role": msg["sender_role"],
            "sender_id": msg["sender_id"],
            "message": msg.get("body", ""),       # legacy field name kept for existing listeners
            "media_type": msg.get("media_type", "none"),
            "media_url": msg.get("media_url"),
            "created_at": msg.get("created_at"),
        })
    except Exception as e:
        logger.warning(f"Failed to broadcast chat message: {e}")


async def _insert_chat(db, request_id: int, sender_role: str, sender_id: str,
                       body: str, media_type: str, media_url) -> dict:
    row = await db.fetchrow(
        """
        INSERT INTO chat_messages
            (request_id, sender_role, sender_id, body, media_type, media_url,
             seen_by_driver, seen_by_mechanic)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, request_id, sender_role, sender_id, body, media_type,
                  media_url, seen_by_driver, seen_by_mechanic, created_at
        """,
        request_id, sender_role, sender_id, body, media_type, media_url,
        sender_role == "driver", sender_role == "mechanic",
    )
    return _chat_row_to_dict(row)


@app.get("/requests/{request_id}/messages", tags=["Chat"])
async def list_messages(request_id: int, role: Optional[str] = None,
                        mark_seen: bool = False, db=Depends(get_db)):
    """Chat history for a request, oldest first. When mark_seen + role are given,
    the other party's messages are marked seen for that role (clears unread)."""
    if mark_seen and role in ("driver", "mechanic"):
        col = "seen_by_driver" if role == "driver" else "seen_by_mechanic"
        other = "mechanic" if role == "driver" else "driver"
        await db.execute(
            f"UPDATE chat_messages SET {col} = TRUE "
            f"WHERE request_id = $1 AND sender_role = $2 AND {col} = FALSE",
            request_id, other,
        )
    rows = await db.fetch(
        """
        SELECT id, request_id, sender_role, sender_id, body, media_type,
               media_url, seen_by_driver, seen_by_mechanic, created_at
        FROM chat_messages WHERE request_id = $1 ORDER BY created_at ASC, id ASC
        """,
        request_id,
    )
    return {"request_id": request_id, "messages": [_chat_row_to_dict(r) for r in rows]}


@app.get("/requests/{request_id}/messages/unread", tags=["Chat"])
async def unread_count(request_id: int, role: str, db=Depends(get_db)):
    """How many messages from the OTHER party this role hasn't seen yet."""
    if role not in ("driver", "mechanic"):
        return {"unread": 0}
    col = "seen_by_driver" if role == "driver" else "seen_by_mechanic"
    other = "mechanic" if role == "driver" else "driver"
    n = await db.fetchval(
        f"SELECT COUNT(*) FROM chat_messages "
        f"WHERE request_id = $1 AND sender_role = $2 AND {col} = FALSE",
        request_id, other,
    )
    return {"unread": int(n or 0)}


@app.post("/requests/{request_id}/messages/seen", tags=["Chat"])
async def mark_messages_seen(request_id: int, body: dict, db=Depends(get_db)):
    role = (body or {}).get("role")
    if role not in ("driver", "mechanic"):
        raise HTTPException(status_code=400, detail="role must be 'driver' or 'mechanic'")
    col = "seen_by_driver" if role == "driver" else "seen_by_mechanic"
    other = "mechanic" if role == "driver" else "driver"
    await db.execute(
        f"UPDATE chat_messages SET {col} = TRUE "
        f"WHERE request_id = $1 AND sender_role = $2 AND {col} = FALSE",
        request_id, other,
    )
    return {"unread": 0}


@app.post("/requests/{request_id}/messages", tags=["Chat"])
async def send_message(request_id: int, payload: ChatSendIn, db=Depends(get_db)):
    """Persist a text (or already-uploaded media) chat message and broadcast it."""
    role = payload.sender_role if payload.sender_role in ("driver", "mechanic") else "driver"
    if not (payload.body or "").strip() and not payload.media_url:
        raise HTTPException(status_code=400, detail="Message is empty")
    msg = await _insert_chat(db, request_id, role, payload.sender_id or "",
                             payload.body or "", payload.media_type or "none",
                             payload.media_url)
    await _broadcast_chat(msg)
    return msg


@app.post("/requests/{request_id}/messages/media", tags=["Chat"])
async def send_media_message(
    request_id: int,
    file: UploadFile = File(...),
    sender_role: str = Form(...),
    sender_id: str = Form(""),
    body: str = Form(""),
    db=Depends(get_db),
):
    """Upload a voice note or photo to storage, persist the message, broadcast it."""
    role = sender_role if sender_role in ("driver", "mechanic") else "driver"
    file_type = _get_file_type(file)                       # 'voice' | 'photo' | 'document'
    media_type = "voice" if file_type == "voice" else "image"
    suffix = Path(file.filename or "").suffix or (".webm" if media_type == "voice" else ".jpg")
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await file.read())
            temp_path = tmp.name
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not buffer upload: {e}")
    try:
        storage = get_storage()
        info = await storage.upload_file(temp_path, file_type, str(request_id))
        media_url = info["url"]
    except Exception as e:
        logger.error(f"Chat media upload failed: {e}")
        raise HTTPException(status_code=502, detail="Media upload failed")
    finally:
        Path(temp_path).unlink(missing_ok=True)
    msg = await _insert_chat(db, request_id, role, sender_id or "", body or "",
                             media_type, media_url)
    await _broadcast_chat(msg)
    return msg


# ════════════════════════════════ SPARE PARTS DEALER DIRECTORY ════════════════════════════════

import math as _math

class DealerCreate(BaseModel):
    name: str
    phone: str
    address: str = ""
    location: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    specialty: str = ""
    description: str = ""
    verified: bool = False

class DealerUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    specialty: Optional[str] = None
    description: Optional[str] = None
    verified: Optional[bool] = None
    active: Optional[bool] = None

class DealerOut(BaseModel):
    id: int
    name: str
    phone: str
    address: str
    location: str
    latitude: Optional[float]
    longitude: Optional[float]
    specialty: str
    description: str
    verified: bool
    active: bool
    created_at: Optional[str]
    updated_at: Optional[str]
    distance_km: Optional[float] = None  # populated only when searching by proximity


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    R = 6371.0
    dlat = _math.radians(lat2 - lat1)
    dlon = _math.radians(lon2 - lon1)
    a = (_math.sin(dlat / 2) ** 2
         + _math.cos(_math.radians(lat1)) * _math.cos(_math.radians(lat2))
         * _math.sin(dlon / 2) ** 2)
    return R * 2 * _math.atan2(_math.sqrt(a), _math.sqrt(1 - a))


def _dealer_row_to_dict(row) -> dict:
    d = dict(row)
    if d.get("created_at"):
        d["created_at"] = d["created_at"].isoformat()
    if d.get("updated_at"):
        d["updated_at"] = d["updated_at"].isoformat()
    d.setdefault("distance_km", None)
    return d


@app.get("/dealers", tags=["Spare Parts Dealers"])
async def list_dealers(
    specialty: Optional[str] = None,
    verified_only: bool = False,
    limit: int = 50,
    offset: int = 0,
    db=Depends(get_db),
):
    """
    List all active spare parts dealers.
    - Filter by specialty (partial, case-insensitive)
    - Filter to verified dealers only
    No auth required — public lookup.
    """
    conditions = ["active = TRUE"]
    params: list = []

    if verified_only:
        conditions.append("verified = TRUE")

    if specialty:
        params.append(f"%{specialty}%")
        conditions.append(f"specialty ILIKE ${len(params)}")

    where = " AND ".join(conditions)
    params += [limit, offset]

    rows = await db.fetch(
        f"""
        SELECT id, name, phone, address, location, latitude, longitude,
               specialty, description, verified, active, created_at, updated_at
        FROM spare_parts_dealers
        WHERE {where}
        ORDER BY verified DESC, name ASC
        LIMIT ${len(params) - 1} OFFSET ${len(params)}
        """,
        *params,
    )
    total = await db.fetchval(
        f"SELECT COUNT(*) FROM spare_parts_dealers WHERE {where}",
        *params[:-2],
    )
    return {
        "total": total or 0,
        "dealers": [_dealer_row_to_dict(r) for r in rows],
    }


@app.get("/dealers/search", tags=["Spare Parts Dealers"])
async def search_dealers_nearby(
    lat: float,
    lon: float,
    radius_km: float = 10.0,
    specialty: Optional[str] = None,
    verified_only: bool = False,
    db=Depends(get_db),
):
    """
    Find dealers within `radius_km` kilometres of a given coordinate.
    Results are sorted by distance (nearest first).
    No auth required.
    """
    conditions = ["active = TRUE", "latitude IS NOT NULL", "longitude IS NOT NULL"]
    params: list = []

    if verified_only:
        conditions.append("verified = TRUE")

    if specialty:
        params.append(f"%{specialty}%")
        conditions.append(f"specialty ILIKE ${len(params)}")

    where = " AND ".join(conditions)

    rows = await db.fetch(
        f"""
        SELECT id, name, phone, address, location, latitude, longitude,
               specialty, description, verified, active, created_at, updated_at
        FROM spare_parts_dealers
        WHERE {where}
        """,
        *params,
    )

    results = []
    for r in rows:
        dist = _haversine_km(lat, lon, r["latitude"], r["longitude"])
        if dist <= radius_km:
            d = _dealer_row_to_dict(r)
            d["distance_km"] = round(dist, 2)
            results.append(d)

    results.sort(key=lambda x: x["distance_km"])
    return {"total": len(results), "radius_km": radius_km, "dealers": results}


@app.get("/dealers/{dealer_id}", tags=["Spare Parts Dealers"])
async def get_dealer(dealer_id: int, db=Depends(get_db)):
    """Get a single spare parts dealer by ID. No auth required."""
    row = await db.fetchrow(
        """
        SELECT id, name, phone, address, location, latitude, longitude,
               specialty, description, verified, active, created_at, updated_at
        FROM spare_parts_dealers WHERE id = $1
        """,
        dealer_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Dealer not found")
    return _dealer_row_to_dict(row)


@app.post("/dealers", tags=["Spare Parts Dealers"], status_code=201)
async def create_dealer(
    body: DealerCreate,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Add a new spare parts dealer. Admin only."""
    if (current_user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    row = await db.fetchrow(
        """
        INSERT INTO spare_parts_dealers
            (name, phone, address, location, latitude, longitude,
             specialty, description, verified)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, name, phone, address, location, latitude, longitude,
                  specialty, description, verified, active, created_at, updated_at
        """,
        body.name, body.phone, body.address, body.location,
        body.latitude, body.longitude, body.specialty,
        body.description, body.verified,
    )
    return _dealer_row_to_dict(row)


@app.put("/dealers/{dealer_id}", tags=["Spare Parts Dealers"])
async def update_dealer(
    dealer_id: int,
    body: DealerUpdate,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Update dealer details. Admin only."""
    if (current_user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    existing = await db.fetchrow(
        "SELECT id FROM spare_parts_dealers WHERE id = $1", dealer_id
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Dealer not found")

    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"] = datetime.utcnow()
    set_clauses = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    values = list(updates.values())

    row = await db.fetchrow(
        f"""
        UPDATE spare_parts_dealers SET {set_clauses}
        WHERE id = $1
        RETURNING id, name, phone, address, location, latitude, longitude,
                  specialty, description, verified, active, created_at, updated_at
        """,
        dealer_id, *values,
    )
    return _dealer_row_to_dict(row)


@app.delete("/dealers/{dealer_id}", tags=["Spare Parts Dealers"])
async def delete_dealer(
    dealer_id: int,
    current_user: Dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Soft-delete a dealer (sets active=FALSE).
    Pass ?hard=true to permanently remove (admin only).
    """
    if (current_user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    existing = await db.fetchrow(
        "SELECT id FROM spare_parts_dealers WHERE id = $1", dealer_id
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Dealer not found")

    await db.execute(
        "UPDATE spare_parts_dealers SET active = FALSE, updated_at = NOW() WHERE id = $1",
        dealer_id,
    )
    return {"detail": "Dealer deactivated", "dealer_id": dealer_id}


# ────────────────────────────── GLOBAL EXCEPTION HANDLER ──────────────────────────────
# Catches and logs any unhandled exceptions to help with production debugging

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Log all unhandled exceptions with request context"""
    print("🔥 UNHANDLED ERROR:", repr(exc))
    logger.exception(f"🔴 UNHANDLED EXCEPTION: {type(exc).__name__}")
    logger.error(f"   Path: {request.method} {request.url.path}")
    logger.error(f"   Origin: {request.headers.get('origin', 'NO ORIGIN')}")
    logger.error(f"   Details: {str(exc)}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "error_type": type(exc).__name__}
    )

# ────────────────────────────── OPTIONAL STATIC / SPA FALLBACK ──────────────────────────────
# Same as in auth-service - allows serving a frontend bundle or SPA fallback if needed later
frontend_dir = os.getenv(
    "FRONTEND_DIST",
    str(Path(__file__).resolve().parents[1] / "frontend")
)
frontend_path = Path(frontend_dir)
index_file = frontend_path / "index.html"

if frontend_path.exists() and index_file.exists():
    app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="frontend")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        return FileResponse(index_file)