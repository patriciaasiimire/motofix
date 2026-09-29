# payments/app/main.py — Payments & Billing Service
#
# A standalone service dedicated to money: it handles the payment side of a job from
# quote to payout. The flow it supports:
#   1. /payments/quote   — the mechanic proposes a price for the job.
#   2. /payments/approve — the driver accepts that price.
#   3. /payments/collect — charge the driver via Mobile Money (MTN/Airtel).
#   4. /payments/disburse— pay the mechanic their share.
#   5. /payments/callback— the mobile-money network tells us a payment succeeded/failed.
# Plus read endpoints: /status, /earnings (per mechanic) and /transactions (for admin).
#
# NOTE: the main dispatch service (../../app/main.py) also contains payment endpoints;
# this dedicated service is the cleaner, self-contained version of that billing logic.

import os
import uuid
import base64
import logging
from datetime import datetime, timezone
from typing import Optional

import asyncpg
import httpx
from fastapi import FastAPI, Depends, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("motofix.payments")

# ──────────────────────────────────────────────
# Env
# ──────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")
SECRET_KEY = os.getenv("SECRET_KEY")
DRIVER_SECRET_KEY = os.getenv("DRIVER_SECRET_KEY")

MOMO_COLLECTIONS_USER_ID = os.getenv("MOMO_COLLECTIONS_USER_ID")
MOMO_COLLECTIONS_API_KEY = os.getenv("MOMO_COLLECTIONS_API_KEY")
MOMO_COLLECTIONS_PRIMARY_KEY = os.getenv("MOMO_COLLECTIONS_PRIMARY_KEY")

MOMO_DISBURSEMENTS_USER_ID = os.getenv("MOMO_DISBURSEMENTS_USER_ID")
MOMO_DISBURSEMENTS_API_KEY = os.getenv("MOMO_DISBURSEMENTS_API_KEY")
MOMO_DISBURSEMENTS_PRIMARY_KEY = os.getenv("MOMO_DISBURSEMENTS_PRIMARY_KEY")

PLATFORM_COMMISSION = int(os.getenv("PLATFORM_COMMISSION", "10000"))

MOMO_BASE = "https://sandbox.momodeveloper.mtn.com"

ALGORITHM = "HS256"

# ──────────────────────────────────────────────
# App
# ──────────────────────────────────────────────
app = FastAPI(title="MOTOFIX - Payments and Billing Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://customer.motofix.org",
        "https://motofix-mechanic-connect.onrender.com",
        "https://admin.motofix.org",
        "http://localhost:8080",
        "http://localhost:8081",
        "http://localhost:8082",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8081",
        "http://127.0.0.1:8082",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# DB pool
# ──────────────────────────────────────────────
db_pool: Optional[asyncpg.Pool] = None

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    request_id INTEGER UNIQUE,
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
"""


@app.on_event("startup")
async def startup():
    global db_pool
    if not SECRET_KEY:
        logger.critical("Missing required SECRET_KEY environment variable for motofix-payments-service")
        raise RuntimeError("SECRET_KEY environment variable is required before motofix-payments-service startup")
    logger.info("Connecting to PostgreSQL…")
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    async with db_pool.acquire() as conn:
        await conn.execute(CREATE_TABLE_SQL)
    logger.info("DB pool ready, payments table ensured.")


@app.on_event("shutdown")
async def shutdown():
    if db_pool:
        await db_pool.close()
        logger.info("DB pool closed.")


async def get_db() -> asyncpg.Connection:
    async with db_pool.acquire() as conn:
        yield conn


# ──────────────────────────────────────────────
# Auth
# ──────────────────────────────────────────────
bearer_scheme = HTTPBearer(auto_error=False)


def decode_token(token: str) -> dict:
    """Try SECRET_KEY first, fall back to DRIVER_SECRET_KEY."""
    keys = [k for k in [SECRET_KEY, DRIVER_SECRET_KEY] if k]
    last_err = None
    for key in keys:
        try:
            payload = jwt.decode(token, key, algorithms=[ALGORITHM])
            return {
                "id": payload.get("sub") or payload.get("id"),
                "role": payload.get("role"),
                "phone": payload.get("phone"),
            }
        except JWTError as e:
            last_err = e
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {last_err}")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return decode_token(credentials.credentials)


def require_role(*roles: str):
    async def checker(user: dict = Depends(get_current_user)) -> dict:
        if user.get("role") not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role(s): {roles}. Got: {user.get('role')}",
            )
        return user
    return checker


# ──────────────────────────────────────────────
# MTN MoMo helpers
# ──────────────────────────────────────────────
def _momo_credentials(product: str) -> tuple[str, str, str]:
    """Return (user_id, api_key, primary_key) for the given product."""
    if product == "collection":
        return (
            MOMO_COLLECTIONS_USER_ID,
            MOMO_COLLECTIONS_API_KEY,
            MOMO_COLLECTIONS_PRIMARY_KEY,
        )
    elif product == "disbursement":
        return (
            MOMO_DISBURSEMENTS_USER_ID,
            MOMO_DISBURSEMENTS_API_KEY,
            MOMO_DISBURSEMENTS_PRIMARY_KEY,
        )
    raise ValueError(f"Unknown MoMo product: {product}")


async def get_momo_token(product: str) -> str:
    user_id, api_key, primary_key = _momo_credentials(product)
    raw = f"{user_id}:{api_key}"
    encoded = base64.b64encode(raw.encode()).decode()
    url = f"{MOMO_BASE}/{product}/token/"
    headers = {
        "Authorization": f"Basic {encoded}",
        "Ocp-Apim-Subscription-Key": primary_key,
        "Content-Length": "0",
    }
    logger.info("MTN token request → POST %s | headers (no secret shown)", url)
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, headers=headers, content=b"")
    logger.info("MTN token response ← status=%s body=%s", resp.status_code, resp.text)
    resp.raise_for_status()
    return resp.json()["access_token"]


# ──────────────────────────────────────────────
# Pydantic schemas
# ──────────────────────────────────────────────
class QuoteRequest(BaseModel):
    request_id: int
    quoted_amount: int
    mechanic_id: Optional[int] = None      # falls back to JWT sub
    mechanic_phone: Optional[str] = None   # falls back to JWT phone


class CollectRequest(BaseModel):
    phone: str


# ──────────────────────────────────────────────
# Helper: row → dict
# ──────────────────────────────────────────────
def row_to_dict(row) -> dict:
    if row is None:
        return None
    return dict(row)


# ──────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────

@app.post("/payments/quote")
async def submit_quote(
    body: QuoteRequest,
    user: dict = Depends(require_role("mechanic")),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Mechanic submits or updates a quote for a service request."""
    # Prefer body values; fall back to what's in the JWT
    mechanic_id = body.mechanic_id if body.mechanic_id is not None else int(user["id"])
    mechanic_phone = body.mechanic_phone if body.mechanic_phone is not None else user.get("phone")
    mechanic_payout = body.quoted_amount - PLATFORM_COMMISSION
    logger.info(
        "Quote upsert: request_id=%s mechanic_id=%s amount=%s payout=%s",
        body.request_id, mechanic_id, body.quoted_amount, mechanic_payout,
    )
    row = await conn.fetchrow(
        """
        INSERT INTO payments (request_id, mechanic_id, mechanic_phone, quoted_amount, commission, mechanic_payout)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (request_id) DO UPDATE
            SET mechanic_id      = EXCLUDED.mechanic_id,
                mechanic_phone   = EXCLUDED.mechanic_phone,
                quoted_amount    = EXCLUDED.quoted_amount,
                commission       = EXCLUDED.commission,
                mechanic_payout  = EXCLUDED.mechanic_payout
        RETURNING *
        """,
        body.request_id, mechanic_id, mechanic_phone,
        body.quoted_amount, PLATFORM_COMMISSION, mechanic_payout,
    )
    return row_to_dict(row)


@app.get("/payments/quote/{request_id}")
async def get_quote(
    request_id: int,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Return the payment / quote record for a service request."""
    row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Payment record not found")
    return row_to_dict(row)


@app.post("/payments/approve/{request_id}")
async def approve_quote(
    request_id: int,
    user: dict = Depends(require_role("driver")),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Driver approves the mechanic's quote."""
    result = await conn.execute(
        "UPDATE payments SET quote_approved = TRUE WHERE request_id = $1",
        request_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Payment record not found")
    logger.info("Quote approved: request_id=%s driver=%s", request_id, user.get("id"))
    return {"detail": "Quote approved", "request_id": request_id}


@app.post("/payments/collect/{request_id}")
async def collect_payment(
    request_id: int,
    body: CollectRequest,
    user: dict = Depends(require_role("driver")),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Initiate MTN MoMo collection from the driver."""
    row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Payment record not found")
    if not row["quote_approved"]:
        raise HTTPException(status_code=400, detail="Quote has not been approved yet")

    quoted_amount = row["quoted_amount"]
    reference_id = str(uuid.uuid4())

    token = await get_momo_token("collection")

    url = f"{MOMO_BASE}/collection/v1_0/requesttopay"
    headers = {
        "X-Reference-Id": reference_id,
        "X-Target-Environment": "sandbox",
        "Ocp-Apim-Subscription-Key": MOMO_COLLECTIONS_PRIMARY_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "amount": str(quoted_amount),
        "currency": "UGX",
        "externalId": reference_id,
        "payer": {"partyIdType": "MSISDN", "partyId": body.phone},
        "payerMessage": "MOTOFIX service payment",
        "payeeNote": "Job payment",
    }
    logger.info(
        "MTN collection request → POST %s | reference=%s phone=%s amount=%s",
        url, reference_id, body.phone, quoted_amount,
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, headers=headers, json=payload)
    logger.info(
        "MTN collection response ← status=%s body=%s",
        resp.status_code, resp.text,
    )

    if resp.status_code != 202:
        raise HTTPException(
            status_code=502,
            detail=f"MTN MoMo rejected collection request: {resp.status_code} {resp.text}",
        )

    await conn.execute(
        """
        UPDATE payments
        SET collection_reference = $1,
            driver_phone         = $2,
            collection_status    = 'pending'
        WHERE request_id = $3
        """,
        reference_id, body.phone, request_id,
    )
    logger.info("Collection initiated: request_id=%s reference=%s", request_id, reference_id)
    return {
        "detail": "Payment initiated",
        "reference_id": reference_id,
        "amount": quoted_amount,
    }


async def _trigger_disbursement(request_id: int, conn: asyncpg.Connection):
    """Internal helper — disburse to mechanic after successful collection."""
    row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)
    if not row or row["disbursement_status"] not in ("pending", None):
        logger.info(
            "Disbursement skipped: request_id=%s disbursement_status=%s",
            request_id, row["disbursement_status"] if row else "N/A",
        )
        return

    mechanic_payout = row["mechanic_payout"]
    mechanic_phone = row["mechanic_phone"]
    disbursement_reference = str(uuid.uuid4())

    token = await get_momo_token("disbursement")

    url = f"{MOMO_BASE}/disbursement/v1_0/transfer"
    headers = {
        "X-Reference-Id": disbursement_reference,
        "X-Target-Environment": "sandbox",
        "Ocp-Apim-Subscription-Key": MOMO_DISBURSEMENTS_PRIMARY_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "amount": str(mechanic_payout),
        "currency": "UGX",
        "externalId": disbursement_reference,
        "payee": {"partyIdType": "MSISDN", "partyId": mechanic_phone},
        "payerMessage": "MOTOFIX mechanic payout",
        "payeeNote": "Job completed",
    }
    logger.info(
        "MTN disbursement request → POST %s | reference=%s phone=%s amount=%s",
        url, disbursement_reference, mechanic_phone, mechanic_payout,
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, headers=headers, json=payload)
    logger.info(
        "MTN disbursement response ← status=%s body=%s",
        resp.status_code, resp.text,
    )

    await conn.execute(
        """
        UPDATE payments
        SET disbursement_reference = $1,
            disbursement_status    = 'pending'
        WHERE request_id = $2
        """,
        disbursement_reference, request_id,
    )
    logger.info(
        "Disbursement initiated: request_id=%s reference=%s",
        request_id, disbursement_reference,
    )


@app.get("/payments/status/{request_id}")
async def check_status(
    request_id: int,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Poll payment status; auto-disburse on successful collection."""
    row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Payment record not found")

    # Poll MTN if collection is still pending
    if row["collection_status"] == "pending" and row["collection_reference"]:
        collection_ref = row["collection_reference"]
        token = await get_momo_token("collection")
        url = f"{MOMO_BASE}/collection/v1_0/requesttopay/{collection_ref}"
        headers = {
            "Ocp-Apim-Subscription-Key": MOMO_COLLECTIONS_PRIMARY_KEY,
            "Authorization": f"Bearer {token}",
            "X-Target-Environment": "sandbox",
        }
        logger.info(
            "MTN status poll request → GET %s | reference=%s",
            url, collection_ref,
        )
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, headers=headers)
        logger.info(
            "MTN status poll response ← status=%s body=%s",
            resp.status_code, resp.text,
        )

        if resp.status_code == 200:
            mtn_data = resp.json()
            mtn_status = mtn_data.get("status", "").upper()
            logger.info("MTN collection status for ref=%s: %s", collection_ref, mtn_status)

            if mtn_status == "SUCCESSFUL":
                await conn.execute(
                    "UPDATE payments SET collection_status = 'successful' WHERE request_id = $1",
                    request_id,
                )
                logger.info("Collection SUCCESSFUL for request_id=%s — triggering disbursement", request_id)
                await _trigger_disbursement(request_id, conn)

            elif mtn_status == "FAILED":
                await conn.execute(
                    "UPDATE payments SET collection_status = 'failed' WHERE request_id = $1",
                    request_id,
                )
                logger.warning("Collection FAILED for request_id=%s", request_id)

        # Re-fetch after potential update
        row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)

    return row_to_dict(row)


@app.post("/payments/disburse/{request_id}")
async def disburse_payment(
    request_id: int,
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Manually trigger disbursement to mechanic (internal use)."""
    row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Payment record not found")
    if row["collection_status"] != "successful":
        raise HTTPException(status_code=400, detail="Collection must be successful before disbursing")

    await _trigger_disbursement(request_id, conn)
    row = await conn.fetchrow("SELECT * FROM payments WHERE request_id = $1", request_id)
    return row_to_dict(row)


@app.post("/payments/callback")
async def momo_callback(request: Request, conn: asyncpg.Connection = Depends(get_db)):
    """MTN MoMo webhook — no auth required."""
    try:
        body = await request.json()
    except Exception:
        body = await request.body()
        logger.warning("Callback received non-JSON body: %s", body)
        return {"detail": "Received"}

    logger.info("MTN callback received: %s", body)

    ref = body.get("financialTransactionId") or body.get("externalId") or body.get("referenceId")
    mtn_status = str(body.get("status", "")).upper()

    if mtn_status == "SUCCESSFUL" and ref:
        row = await conn.fetchrow(
            "SELECT * FROM payments WHERE collection_reference = $1", ref
        )
        if row:
            await conn.execute(
                "UPDATE payments SET collection_status = 'successful' WHERE collection_reference = $1",
                ref,
            )
            logger.info("Callback: collection marked successful for ref=%s — triggering disbursement", ref)
            await _trigger_disbursement(row["request_id"], conn)
        else:
            logger.warning("Callback: no payment found for collection_reference=%s", ref)
    else:
        logger.info("Callback: status=%s ref=%s — no action taken", mtn_status, ref)

    return {"detail": "Callback received"}


@app.get("/payments/earnings/{mechanic_id}")
async def get_earnings(
    mechanic_id: int,
    user: dict = Depends(require_role("mechanic")),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Return successful payments for a mechanic with earnings summary."""
    rows = await conn.fetch(
        """
        SELECT * FROM payments
        WHERE mechanic_id = $1 AND collection_status = 'successful'
        ORDER BY created_at DESC
        """,
        mechanic_id,
    )
    payments = [row_to_dict(r) for r in rows]

    total_earned = sum(p["mechanic_payout"] or 0 for p in payments)

    now = datetime.now(timezone.utc)
    this_month_earned = sum(
        p["mechanic_payout"] or 0
        for p in payments
        if p["created_at"]
        and p["created_at"].year == now.year
        and p["created_at"].month == now.month
    )

    return {
        "mechanic_id": mechanic_id,
        "total_earned": total_earned,
        "this_month_earned": this_month_earned,
        "payments": payments,
    }


@app.get("/payments/transactions")
async def get_transactions(
    user: dict = Depends(get_current_user),
    conn: asyncpg.Connection = Depends(get_db),
):
    """Return all payment records (admin dashboard)."""
    rows = await conn.fetch("SELECT * FROM payments ORDER BY created_at DESC")
    return [row_to_dict(r) for r in rows]


# ──────────────────────────────────────────────
# Health check
# ──────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "motofix-payments-service",
        "jwt_secret_configured": bool(SECRET_KEY),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
