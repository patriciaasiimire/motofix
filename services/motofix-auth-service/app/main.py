# motofix-auth-service/app/main.py — Authentication Service (entry point)
#
# This service owns WHO everyone is and whether they're allowed in: drivers,
# mechanics/tow providers, and admins all register and log in here. It also holds
# provider applications, the admin-managed spare-parts catalog, and parts orders.
#
# This file just starts the service: it opens the database connection pool, makes
# sure the tables exist, sets up CORS (which web addresses may call us), and plugs
# in the routers below. The actual endpoints live in those router files:
#   routers/driver.py   — driver sign-up + OTP login
#   routers/provider.py — mechanic / tow-provider sign-up + login
#   routers/admin.py    — admin login + verifying providers
#   routers/users.py    — shared user lookups/updates
#   routers/applications.py — provider applications (submit / review / approve)
#   routers/parts_catalog.py, parts_orders.py — spare-parts catalog + driver orders

import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncpg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

load_dotenv()


def _require_secret() -> str:
    secret = os.getenv("SECRET_KEY")
    if not secret:
        logging.getLogger("motofix-auth").critical(
            "Missing required SECRET_KEY environment variable for auth-service"
        )
        raise RuntimeError("SECRET_KEY environment variable is required before auth-service startup")
    return secret

from .routers import users
from .routers import driver, provider, admin, applications, parts_catalog, parts_orders
from app.core.cors import setup_cors

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("motofix-auth")

# ── Lifespan — DB pool creation + schema bootstrap ────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    _require_secret()
    database_url = os.getenv("DATABASE_URL")
    # Resilient pool: a small warm pool (so we don't storm Postgres on startup),
    # room to grow under load, and recycling of idle connections so a stale one
    # (e.g. after Postgres was briefly busy) is replaced instead of timing out.
    pool = await asyncpg.create_pool(
        dsn=database_url,
        min_size=3,
        max_size=12,
        timeout=30,                              # max wait to acquire a connection
        command_timeout=60,
        max_inactive_connection_lifetime=180.0,  # recycle idle conns every 3 min
    )

    # Expose pool on app.state so middleware (blacklist check) can reach it
    app.state.pool = pool

    async with pool.acquire() as conn:

        # ── users ──────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id           SERIAL PRIMARY KEY,
                phone        TEXT UNIQUE NOT NULL,
                full_name    TEXT DEFAULT '',
                role         TEXT NOT NULL DEFAULT 'driver',
                number_plate TEXT,
                fcm_token    TEXT,
                created_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        # Idempotent column additions for older deployments
        for col_sql in [
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS number_plate TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_type TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb",
        ]:
            await conn.execute(col_sql)

        # ── mechanics ──────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS mechanics (
                id            SERIAL PRIMARY KEY,
                full_name     TEXT NOT NULL,
                phone         TEXT UNIQUE NOT NULL,
                location      TEXT NOT NULL,
                latitude      DOUBLE PRECISION NOT NULL DEFAULT 0,
                longitude     DOUBLE PRECISION NOT NULL DEFAULT 0,
                specialty     TEXT,
                provider_type TEXT NOT NULL DEFAULT 'mechanic',
                vehicle_type  TEXT DEFAULT 'boda',
                password_hash TEXT NOT NULL,
                is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
                is_available  BOOLEAN NOT NULL DEFAULT FALSE,
                rating        DOUBLE PRECISION NOT NULL DEFAULT 0,
                total_ratings INTEGER NOT NULL DEFAULT 0,
                jobs_completed INTEGER NOT NULL DEFAULT 0,
                created_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── towing_providers ───────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS towing_providers (
                id               SERIAL PRIMARY KEY,
                full_name        TEXT NOT NULL,
                phone            TEXT UNIQUE NOT NULL,
                location         TEXT NOT NULL,
                latitude         DOUBLE PRECISION NOT NULL DEFAULT 0,
                longitude        DOUBLE PRECISION NOT NULL DEFAULT 0,
                vehicle_capacity INTEGER DEFAULT 1,
                password_hash    TEXT NOT NULL,
                is_verified      BOOLEAN NOT NULL DEFAULT FALSE,
                is_available     BOOLEAN NOT NULL DEFAULT FALSE,
                rating           DOUBLE PRECISION NOT NULL DEFAULT 0,
                total_ratings    INTEGER NOT NULL DEFAULT 0,
                jobs_completed   INTEGER NOT NULL DEFAULT 0,
                created_at       TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── admins ─────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS admins (
                id            SERIAL PRIMARY KEY,
                full_name     TEXT NOT NULL,
                email         TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'admin',
                created_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── otp_store ──────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS otp_store (
                id         SERIAL PRIMARY KEY,
                phone      TEXT NOT NULL,
                otp_code   VARCHAR(6) NOT NULL,
                attempts   INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_otp_store_phone ON otp_store (phone)"
        )

        # ── spare_parts_catalog ────────────────────────────────────────────
        # Admin-curated overrides for the AI's parts/price/fee suggestions,
        # keyed by the diagnosis fault_category. When an entry exists it takes
        # precedence over whatever the diagnosis engine generated.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS spare_parts_catalog (
                id               SERIAL PRIMARY KEY,
                fault_category   TEXT UNIQUE NOT NULL,
                label            TEXT NOT NULL DEFAULT '',
                parts            JSONB NOT NULL DEFAULT '[]'::jsonb,
                service_fee_min  INTEGER,
                service_fee_max  INTEGER,
                notes            TEXT,
                updated_by       INTEGER,
                created_at       TIMESTAMPTZ DEFAULT NOW(),
                updated_at       TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── spare_part_orders ──────────────────────────────────────────────
        # A driver's self-fix parts order, sent to a (Google Places) dealer via
        # WhatsApp/SMS and kept here so the driver has an order history.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS spare_part_orders (
                id                  SERIAL PRIMARY KEY,
                user_id             INTEGER NOT NULL,
                owner_role          TEXT NOT NULL DEFAULT 'driver',
                fault_category      TEXT,
                fault_label         TEXT,
                parts               JSONB NOT NULL DEFAULT '[]'::jsonb,
                dealer_name         TEXT,
                dealer_phone        TEXT,
                dealer_place_id     TEXT,
                estimated_total_min INTEGER,
                estimated_total_max INTEGER,
                status              TEXT NOT NULL DEFAULT 'sent',
                created_at          TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        # owner_role distinguishes a driver (users.id) from a mechanic/towing
        # provider (mechanics/towing_providers.id) — those id sequences overlap.
        await conn.execute(
            "ALTER TABLE spare_part_orders ADD COLUMN IF NOT EXISTS owner_role TEXT NOT NULL DEFAULT 'driver'"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_spare_part_orders_owner ON spare_part_orders (owner_role, user_id)"
        )

        # Pending registration data for NEW drivers — the users row is only
        # created once the OTP is verified, so name/plate live here until then.
        for col_sql in [
            "ALTER TABLE otp_store ADD COLUMN IF NOT EXISTS pending_full_name TEXT",
            "ALTER TABLE otp_store ADD COLUMN IF NOT EXISTS pending_number_plate TEXT",
        ]:
            await conn.execute(col_sql)

        # ── token_blacklist ────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS token_blacklist (
                id         SERIAL PRIMARY KEY,
                token_hash TEXT UNIQUE NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_token_blacklist_hash ON token_blacklist (token_hash)"
        )

        # ── provider_applications ──────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS provider_applications (
                id                   SERIAL PRIMARY KEY,
                full_name            TEXT NOT NULL,
                phone                TEXT NOT NULL,
                email                TEXT,
                provider_type        TEXT NOT NULL,
                specializations      TEXT,
                service_area         TEXT,
                years_experience     TEXT,
                business_name        TEXT,
                business_reg_number  TEXT,
                business_address     TEXT,
                mobile_money_number  TEXT,
                garage_affiliation   TEXT,
                referral_name        TEXT,
                referral_phone       TEXT,
                face_scan_url        TEXT,
                national_id_url      TEXT,
                certification_url    TEXT,
                profile_photo_url    TEXT,
                verification_status  TEXT NOT NULL DEFAULT 'pending',
                rejection_reason     TEXT,
                reviewed_by          INTEGER,
                submitted_at         TIMESTAMPTZ DEFAULT NOW(),
                reviewed_at          TIMESTAMPTZ
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_provider_apps_phone ON provider_applications (phone)"
        )

        # ── platform_config ────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS platform_config (
                id               INTEGER PRIMARY KEY DEFAULT 1,
                service_fee_pct  NUMERIC(5,2) NOT NULL DEFAULT 10.0,
                provider_cut_pct NUMERIC(5,2) NOT NULL DEFAULT 80.0,
                updated_at       TIMESTAMPTZ,
                updated_by       INTEGER
            )
        """)
        await conn.execute(
            "INSERT INTO platform_config (id) VALUES (1) ON CONFLICT DO NOTHING"
        )
        for col_sql in [
            "ALTER TABLE platform_config ADD COLUMN IF NOT EXISTS maintenance_active BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE platform_config ADD COLUMN IF NOT EXISTS maintenance_start TIMESTAMPTZ",
            "ALTER TABLE platform_config ADD COLUMN IF NOT EXISTS maintenance_end TIMESTAMPTZ",
            "ALTER TABLE platform_config ADD COLUMN IF NOT EXISTS maintenance_message TEXT",
        ]:
            await conn.execute(col_sql)

        # ── SPN + password_changed columns (idempotent) ───────────────────
        for col_sql in [
            "ALTER TABLE mechanics        ADD COLUMN IF NOT EXISTS spn              TEXT UNIQUE",
            "ALTER TABLE towing_providers ADD COLUMN IF NOT EXISTS spn              TEXT UNIQUE",
            "ALTER TABLE mechanics        ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE towing_providers ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE mechanics        ADD COLUMN IF NOT EXISTS is_banned        BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE towing_providers ADD COLUMN IF NOT EXISTS is_banned        BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE mechanics        ADD COLUMN IF NOT EXISTS ban_reason       TEXT",
            "ALTER TABLE towing_providers ADD COLUMN IF NOT EXISTS ban_reason       TEXT",
            "ALTER TABLE mechanics        ADD COLUMN IF NOT EXISTS banned_at        TIMESTAMPTZ",
            "ALTER TABLE towing_providers ADD COLUMN IF NOT EXISTS banned_at        TIMESTAMPTZ",
        ]:
            await conn.execute(col_sql)

        # Global SPN counter — guarantees uniqueness across mechanics + towing_providers
        await conn.execute("CREATE SEQUENCE IF NOT EXISTS spn_seq START 1")

        # ── id_registry — fraud / duplicate-ID detection ───────────────────
        # Stores normalised ID numbers from verified applications so the same
        # ID cannot be used to register multiple accounts.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS id_registry (
                id             SERIAL PRIMARY KEY,
                id_number      TEXT UNIQUE NOT NULL,  -- always stored UPPER/normalised
                full_name      TEXT,
                phone          TEXT,
                application_id INTEGER,
                created_at     TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── provider_applications: re-upload support ───────────────────────
        for col_sql in [
            "ALTER TABLE provider_applications ADD COLUMN IF NOT EXISTS reupload_requested_docs TEXT",
            "ALTER TABLE provider_applications ADD COLUMN IF NOT EXISTS reupload_requested_at   TIMESTAMPTZ",
        ]:
            await conn.execute(col_sql)

        # ── rate_limit_buckets ────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS rate_limit_buckets (
                key        TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time ON rate_limit_buckets (key, created_at)"
        )

        # ── system_logs ────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS system_logs (
                id          SERIAL PRIMARY KEY,
                event_type  TEXT NOT NULL,
                user_id     INTEGER,
                mechanic_id INTEGER,
                request_id  INTEGER,
                description TEXT DEFAULT '',
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)

    logger.info("✅ DB schema bootstrap complete")

    yield

    await pool.close()


# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="MOTOFIX - Authentication Service",
    description="Phone + OTP login for drivers; password login for mechanics, towing providers and admins.",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS — must be added before routers
setup_cors(app)


# ── Routers ────────────────────────────────────────────────────────────────────

app.include_router(driver.router)        # /auth/register/driver, /auth/verify-otp, /auth/me, /auth/logout
app.include_router(provider.router)      # /auth/register/provider, /auth/login/provider, /auth/me/provider, /auth/provider/me/availability
app.include_router(admin.router)         # /auth/login/admin, /auth/admin/verify-provider/{id}
app.include_router(users.router)         # /users/me, /users/me/fcm-token
app.include_router(applications.router)  # /providers/applications, /providers/applications/{id}/approve|reject
app.include_router(parts_catalog.router) # /auth/admin/parts-catalog, /auth/parts-catalog/{fault_category}
app.include_router(parts_orders.router)  # /auth/me/parts-orders (driver self-fix parts orders)

# ── Static file serving for uploaded documents ────────────────────────────────
_UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")
os.makedirs(_UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_UPLOAD_DIR), name="uploads")


# ── Maintenance mode middleware ────────────────────────────────────────────────

MAINTENANCE_EXEMPT = {"/health", "/auth/login/admin", "/auth/maintenance-status"}

@app.middleware("http")
async def maintenance_check(request: Request, call_next):
    path = request.url.path
    if path in MAINTENANCE_EXEMPT or path.startswith("/auth/admin"):
        return await call_next(request)
    pool = getattr(request.app.state, "pool", None)
    if pool:
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT maintenance_active, maintenance_end FROM platform_config WHERE id = 1"
                )
                if row and row["maintenance_active"]:
                    end_time = row["maintenance_end"]
                    now = datetime.now(timezone.utc)

                    # Auto-deactivate if the scheduled window has passed
                    if end_time and end_time.astimezone(timezone.utc) <= now:
                        await conn.execute(
                            "UPDATE platform_config SET maintenance_active = FALSE, "
                            "maintenance_start = NULL, maintenance_end = NULL, "
                            "maintenance_message = NULL WHERE id = 1"
                        )
                        logger.info("Maintenance window expired — platform auto-restored.")
                    else:
                        end_note = (f" Expected back: {end_time.strftime('%d %b %Y %I:%M %p')}."
                                    if end_time else "")
                        return JSONResponse(
                            status_code=503,
                            content={
                                "error": True,
                                "code": "MAINTENANCE",
                                "message": f"MOTOFIX is currently under scheduled maintenance.{end_note} Please try again later.",
                            },
                        )
        except Exception:
            pass
    return await call_next(request)


# ── Public mechanic profile (for drivers to view their assigned mechanic) ──────

@app.get("/auth/providers/{mechanic_id}/public", tags=["Providers"])
async def get_provider_public_profile(mechanic_id: int, request: Request):
    """Returns safe public fields for an assigned mechanic — no phone, no sensitive data."""
    pool = getattr(request.app.state, "pool", None)
    if not pool:
        raise HTTPException(status_code=503, detail="Database unavailable")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT m.id, m.full_name, m.specialty, m.provider_type,
                   m.rating, m.total_ratings, m.jobs_completed,
                   pa.profile_photo_url,
                   COALESCE(pa.business_name, pa.garage_affiliation) AS garage_name
            FROM mechanics m
            LEFT JOIN provider_applications pa
                   ON pa.phone = m.phone
                  AND pa.verification_status = 'approved'
            WHERE m.id = $1
            """,
            mechanic_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    # Recent customer reviews (rating + comment) live in the DISPATCH DB. Pull the
    # latest few so drivers can read real feedback before the mechanic arrives.
    # Reviewer names are shortened to "First L." for privacy.
    reviews = []
    try:
        from .routers.provider import _get_dispatch_pool
        dpool = await _get_dispatch_pool()
        if dpool:
            async with dpool.acquire() as dconn:
                rrows = await dconn.fetch(
                    """SELECT r.rating, r.comment, r.created_at,
                              sr.customer_name, sr.service_type
                       FROM reviews r
                       LEFT JOIN service_requests sr ON r.request_id = sr.id
                       WHERE r.mechanic_id = $1
                       ORDER BY r.created_at DESC
                       LIMIT 8""",
                    mechanic_id,
                )
                for r in rrows:
                    name = (r["customer_name"] or "").strip()
                    parts = [p for p in name.split() if p]
                    display = (parts[0] + (f" {parts[-1][0]}." if len(parts) > 1 else "")) if parts else "A driver"
                    reviews.append({
                        "rating":       r["rating"] or 0,
                        "comment":      (r["comment"] or "").strip(),
                        "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
                        "reviewer_name": display,
                        "service_type": r["service_type"],
                    })
    except Exception as exc:
        logger.warning("Could not load reviews for provider %s: %s", mechanic_id, exc)

    return {
        "id":               row["id"],
        "full_name":        row["full_name"],
        "specialty":        row["specialty"],
        "provider_type":    row["provider_type"],
        "rating":           row["rating"],
        "total_ratings":    row["total_ratings"],
        "jobs_completed":   row["jobs_completed"],
        "profile_photo_url": row["profile_photo_url"],
        "garage_name":      row["garage_name"],
        "reviews":          reviews,
    }


# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["Health"])
async def health_check():
    return {
        "status": "ok",
        "service": "motofix-auth-service",
        "jwt_secret_configured": bool(os.getenv("SECRET_KEY")),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ── Startup log ────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    _require_secret()
    logger.info("=" * 70)
    logger.info("🚀 MOTOFIX Auth Service v2.0 Starting")
    logger.info("=" * 70)


# ── Custom OpenAPI — adds BearerAuth so Swagger shows a "paste token" field ───

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
    }
    # Apply BearerAuth to every operation
    for path_item in schema.get("paths", {}).values():
        for operation in path_item.values():
            if isinstance(operation, dict):
                operation.setdefault("security", []).append({"BearerAuth": []})
    app.openapi_schema = schema
    return app.openapi_schema

app.openapi = custom_openapi


# ── Global exception handler ───────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("❌ Unhandled %s at %s: %s", type(exc).__name__, request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"error": True, "code": "INTERNAL_ERROR",
                 "message": "An unexpected error occurred", "status_code": 500},
    )
