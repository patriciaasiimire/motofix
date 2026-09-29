# app/routers/admin.py
# The admin dashboard's data endpoints — the biggest part of this service. Every
# endpoint here is admin-only (protected by verify_admin_token) and mostly READS
# data to build the control-room screens: platform totals, charts/trends, revenue,
# and detailed lists of service requests, drivers and mechanics.
#
# It reads from two databases: get_db (this service's data) and get_auth_db (the
# auth service's users/mechanics), so it can join the full picture together.

import logging
from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from ..deps import verify_admin_token
from ..db import get_db, get_auth_db

router = APIRouter(prefix="/admin", tags=["Admin"])

_PAYMENT_STATUS_ALIASES = {
    "success": "success",
    "successful": "success",
    "cash": "cash",
    "pending": "pending",
    "initiated": "initiated",
    "processing": "initiated",
    "failed": "failed",
    "failure": "failed",
    "declined": "failed",
    "rejected": "failed",
    "expired": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}
_PAYMENT_STATUS_VALUES = {
    "success": ["success", "successful"],
    "cash": ["cash"],
    "pending": ["pending"],
    "initiated": ["initiated", "processing"],
    "failed": ["failed", "failure", "declined", "rejected", "expired"],
    "cancelled": ["cancelled", "canceled"],
}


def _normalise_payment_status(value: Optional[str]) -> str:
    """Return success | pending | failed | initiated | cash | cancelled | unknown."""
    normalized = (value or "").strip().lower()
    return _PAYMENT_STATUS_ALIASES.get(normalized, "pending" if not normalized else "unknown")


def _payment_status_filter_values(value: str) -> list[str]:
    normalized = _normalise_payment_status(value)
    if normalized == "unknown":
        raise HTTPException(status_code=422, detail="Unsupported payment status filter")
    return _PAYMENT_STATUS_VALUES[normalized]


# ──────────────────────────── MODELS ────────────────────────────

class MediaFile(BaseModel):
    url: str
    file_type: str  # "voice", "photo", "document"
    size_kb: float
    uploaded_at: str


class ServiceRequestResponse(BaseModel):
    id: str
    customer_name: str
    customer_phone: str
    location: str
    description: str
    service_type: str
    status: str
    media_files: Optional[List[MediaFile]] = []
    created_at: str
    updated_at: Optional[str] = None
    dispatched_at: Optional[str] = None
    accepted_at: Optional[str] = None
    en_route_at: Optional[str] = None
    arrived_at: Optional[str] = None
    service_started_at: Optional[str] = None
    completed_at: Optional[str] = None
    time_to_accept_min: Optional[int] = Field(default=None, description="Dispatched → Accepted")
    drive_time_min: Optional[int] = Field(default=None, description="En route/Accepted → Arrived")
    service_time_min: Optional[int] = Field(default=None, description="Service started → Completed")
    total_duration_min: Optional[int] = Field(default=None, description="Dispatched → Completed")


def _minutes_between(a: Optional[datetime], b: Optional[datetime]) -> Optional[int]:
    if not a or not b:
        return None
    try:
        mins = int(round((b - a).total_seconds() / 60.0))
        return max(0, mins)
    except Exception:
        return None


# ────────────────────────── SERVICE REQUESTS ──────────────────────────

@router.get("/requests")
async def list_requests(
    status: Optional[str] = Query(None),
    limit: int = 100,
    db=Depends(get_db),
    admin=Depends(verify_admin_token)
):
    """
    List service requests with media files.
    Returns requests with voice notes, photos, and documents.
    """
    base_query = """
        SELECT *
        FROM service_requests
        {where}
        ORDER BY created_at DESC
        LIMIT $1
    """
    if status:
        rows = await db.fetch(base_query.format(where="WHERE status = $2"), limit, status)
    else:
        rows = await db.fetch(base_query.format(where=""), limit)
    
    # Fetch media files for each request
    requests_data = []
    for row in rows:
        request_dict = dict(row)
        media_rows = await db.fetch(
            "SELECT url, file_type, size_kb, uploaded_at FROM media_files WHERE request_id = $1 ORDER BY uploaded_at DESC",
            row['id']
        )
        request_dict['media_files'] = [dict(m) for m in media_rows] if media_rows else []

        dispatched_at = request_dict.get("dispatched_at") or request_dict.get("created_at")
        accepted_at = request_dict.get("accepted_at")
        en_route_at = request_dict.get("en_route_at") or accepted_at
        arrived_at = request_dict.get("arrived_at")
        service_started_at = request_dict.get("service_started_at")
        completed_at = request_dict.get("completed_at")

        request_dict["time_to_accept_min"] = _minutes_between(dispatched_at, accepted_at)
        request_dict["drive_time_min"] = _minutes_between(en_route_at, arrived_at)
        request_dict["service_time_min"] = _minutes_between(service_started_at, completed_at)
        request_dict["total_duration_min"] = _minutes_between(dispatched_at, completed_at)
        requests_data.append(request_dict)
    
    return requests_data


# ───────────────────────────── MECHANICS ──────────────────────────────

@router.get("/mechanics")
async def list_mechanics(
    verified: Optional[bool] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(10, ge=1, le=200),
    db=Depends(get_auth_db),
    admin=Depends(verify_admin_token)
):
    """
    Return mechanics with optional search and pagination.
    Supports filtering by verification status and fuzzy match on name/phone/location.
    """
    offset = (page - 1) * pageSize
    params = []
    conditions = []

    if verified is not None:
        conditions.append(f"is_verified = ${len(params) + 1}")
        params.append(verified)

    if search:
        like_term = f"%{search.lower()}%"
        conditions.append(
            f"(lower(full_name) LIKE ${len(params) + 1} OR lower(phone) LIKE ${len(params) + 1} OR lower(location) LIKE ${len(params) + 1})"
        )
        params.append(like_term)

    where_sql = " WHERE " + " AND ".join(conditions) if conditions else ""

    try:
        total = await db.fetchval(f"SELECT COUNT(*) FROM mechanics{where_sql}", *params)
        query = f"""
            SELECT id, phone, full_name AS name, location, is_verified, is_available, rating, jobs_completed, created_at
            FROM mechanics
            {where_sql}
            ORDER BY created_at DESC
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
        """
        rows = await db.fetch(query, *params, pageSize, offset)
    except Exception as exc:
        logger.exception("Admin mechanics list query failed")
        raise HTTPException(status_code=503, detail="Mechanics data is temporarily unavailable") from exc

    data = [dict(r) for r in rows]
    return {
        "data": data,
        "page": page,
        "pageSize": pageSize,
        "total": total,
        "totalPages": (total + pageSize - 1) // pageSize if total is not None else 0,
    }


# ───────────────────────────── PAYMENTS WITH PAGINATION ───────────────────────────────

@router.get("/payments")
async def list_payments(
    search: Optional[str] = Query(None, description="Search by driver name or phone"),
    collection_status: Optional[str] = Query(None),
    disbursement_status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db=Depends(get_db),
    auth_db=Depends(get_auth_db),
    admin=Depends(verify_admin_token)
):
    offset = (page - 1) * page_size
    params: list = []
    conditions: list = []

    if search:
        like = f"%{search.lower()}%"
        conditions.append(
            f"(lower(sr.customer_name) LIKE ${len(params)+1} OR lower(sr.phone) LIKE ${len(params)+1})"
        )
        params.append(like)

    if collection_status:
        conditions.append(f"LOWER(COALESCE(p.collection_status, '')) = ANY(${len(params)+1}::text[])")
        params.append(_payment_status_filter_values(collection_status))

    if disbursement_status:
        conditions.append(f"LOWER(COALESCE(p.disbursement_status, '')) = ANY(${len(params)+1}::text[])")
        params.append(_payment_status_filter_values(disbursement_status))

    where_sql = " WHERE " + " AND ".join(conditions) if conditions else ""

    base_from = f"""
        FROM payments p
        JOIN service_requests sr ON p.request_id = sr.id
    """

    try:
        total = await db.fetchval(f"SELECT COUNT(*) {base_from}{where_sql}", *params)
        query = f"""
            SELECT p.id, p.request_id, p.quoted_amount, p.commission, p.mechanic_payout,
                   p.collection_status, p.disbursement_status, p.provider,
                   p.collection_reference, p.disbursement_reference, p.created_at,
                   sr.customer_name, sr.phone AS driver_phone, sr.service_type,
                   NULL::text AS mechanic_name, p.mechanic_id
            {base_from}
            {where_sql}
            ORDER BY p.created_at DESC
            LIMIT ${len(params)+1} OFFSET ${len(params)+2}
        """
        rows = await db.fetch(query, *params, page_size, offset)
    except Exception as exc:
        logger.exception("Payment records query failed")
        raise HTTPException(status_code=503, detail="Payment records are temporarily unavailable") from exc

    mechanic_ids = list({row["mechanic_id"] for row in rows if row["mechanic_id"] is not None})
    mechanic_names = {}
    if mechanic_ids:
        try:
            name_rows = await auth_db.fetch(
                "SELECT id, full_name FROM mechanics WHERE id = ANY($1::int[])", mechanic_ids
            )
            mechanic_names = {row["id"]: row["full_name"] for row in name_rows}
        except Exception as exc:
            logger.exception("Payment mechanic-name lookup failed")
            raise HTTPException(status_code=503, detail="Payment provider data is temporarily unavailable") from exc

    # Boundary vocabulary: success | pending | failed | initiated | cash | cancelled.
    data = []
    for row in rows:
        payment = dict(row)
        payment["mechanic_name"] = mechanic_names.get(payment["mechanic_id"])
        payment["collection_status"] = _normalise_payment_status(payment["collection_status"])
        payment["disbursement_status"] = _normalise_payment_status(payment["disbursement_status"])
        data.append(payment)

    return {
        "data": data,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total_items": total,
            "total_pages": max(1, (total + page_size - 1) // page_size),
            "has_next": page * page_size < total,
            "has_prev": page > 1,
        },
        "search": {"search": search, "collection_status": collection_status, "disbursement_status": disbursement_status},
    }


# ────────────────────────────── LIVE OPERATIONAL STATS ─────────────────────────────────

@router.get("/live-stats")
async def live_stats(
    db=Depends(get_db),
    auth_db=Depends(get_auth_db),
    admin=Depends(verify_admin_token)
):
    try:
        active_requests = await db.fetchval(
            "SELECT COUNT(*) FROM service_requests WHERE status NOT IN ('completed', 'cancelled')"
        ) or 0
        stuck_requests = await db.fetchval(
            "SELECT COUNT(*) FROM service_requests WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes'"
        ) or 0
        requests_today = await db.fetchval(
            "SELECT COUNT(*) FROM service_requests WHERE created_at >= CURRENT_DATE"
        ) or 0
        completed_created_today = await db.fetchval(
            "SELECT COUNT(*) FROM service_requests WHERE status = 'completed' AND created_at >= CURRENT_DATE"
        ) or 0
    except Exception as exc:
        logger.exception("Live request stats query failed")
        raise HTTPException(status_code=503, detail="Live request statistics are temporarily unavailable") from exc

    completion_rate_created_today = round(
        completed_created_today / requests_today * 100, 1
    ) if requests_today > 0 else 0.0

    try:
        towing_online = await auth_db.fetchval(
            "SELECT COUNT(*) FROM towing_providers WHERE is_available = true"
        ) or 0
        mechanics_online = await auth_db.fetchval(
            "SELECT COUNT(*) FROM mechanics WHERE is_available = true"
        ) or 0
    except Exception as exc:
        logger.exception("Live provider stats query failed")
        raise HTTPException(status_code=503, detail="Live provider statistics are temporarily unavailable") from exc

    return {
        "active_requests": active_requests,
        "stuck_requests": stuck_requests,
        "requests_today": requests_today,
        "completed_requests_created_today": completed_created_today,
        "completion_rate_created_today": completion_rate_created_today,
        "towing_online": towing_online,
        "mechanics_online": mechanics_online,
        "as_of": datetime.utcnow().isoformat() + "Z",
    }


# ────────────────────────────── MAP DATA ─────────────────────────────────

@router.get("/map-data")
async def map_data(
    db=Depends(get_db),
    auth_db=Depends(get_auth_db),
    admin=Depends(verify_admin_token)
):
    try:
        mechanic_rows = await auth_db.fetch(
            """SELECT id, full_name AS name, phone, location, is_verified, latitude, longitude
               FROM mechanics
               WHERE latitude IS NOT NULL AND longitude IS NOT NULL"""
        )
    except Exception as exc:
        logger.exception("Mechanics hotspot query failed")
        raise HTTPException(status_code=503, detail="Mechanics map data unavailable") from exc

    try:
        towing_rows = await auth_db.fetch(
            """SELECT id, full_name AS name, phone, location, is_verified, is_available, latitude, longitude
               FROM towing_providers
               WHERE latitude IS NOT NULL AND longitude IS NOT NULL"""
        )
    except Exception as exc:
        logger.exception("Towing providers map query failed")
        raise HTTPException(status_code=503, detail="Towing provider map data unavailable") from exc

    try:
        request_rows = await db.fetch(
            """SELECT id, customer_name, location, status, service_type, created_at
               FROM service_requests
               WHERE status NOT IN ('completed', 'cancelled')
               ORDER BY created_at DESC
               LIMIT 50"""
        )
    except Exception as exc:
        logger.exception("Active-request map query failed")
        raise HTTPException(status_code=503, detail="Active request map data unavailable") from exc
    return {
        "mechanics": [dict(row) for row in mechanic_rows],
        "towing_providers": [dict(row) for row in towing_rows],
        "active_requests": [dict(row) for row in request_rows],
    }


# ────────────────────────────── STATS ─────────────────────────────────

@router.get("/stats")
async def dashboard_stats(
    db=Depends(get_db),
    auth_db=Depends(get_auth_db),
    admin=Depends(verify_admin_token),
):
    try:
        stats = {
            "total_requests": await db.fetchval("SELECT COUNT(*) FROM service_requests") or 0,
            "completed_jobs": await db.fetchval("SELECT COUNT(*) FROM service_requests WHERE status = 'completed'") or 0,
            "pending_jobs": await db.fetchval("SELECT COUNT(*) FROM service_requests WHERE status IN ('pending', 'accepted')") or 0,
            "total_mechanics": await auth_db.fetchval("SELECT COUNT(*) FROM mechanics") or 0,
            "verified_mechanics": await auth_db.fetchval("SELECT COUNT(*) FROM mechanics WHERE is_verified = true") or 0,
        }
        # platform_fees is Motofix's revenue ledger; payments holds job-level quotes and collections.
        collected = await db.fetchval("SELECT COALESCE(SUM(amount), 0) FROM platform_fees WHERE status = 'paid'")
        pending = await db.fetchval("SELECT COALESCE(SUM(amount), 0) FROM platform_fees WHERE status = 'owed'")
        stats["revenue_collected_ugx"] = float(collected or 0)
        stats["pending_collections_ugx"] = float(pending or 0)
        stats["total_transactions"] = await db.fetchval("SELECT COUNT(*) FROM payments") or 0
        stats["as_of"] = datetime.utcnow().isoformat() + "Z"
        return stats
    except Exception as exc:
        logger.exception("Admin dashboard stats query failed")
        raise HTTPException(status_code=503, detail="Dashboard statistics are temporarily unavailable") from exc


@router.get("/dashboard/revenue-chart")
async def revenue_chart(limit: int = 30, db=Depends(get_db), admin=Depends(verify_admin_token)):
    query = """
        SELECT to_char(COALESCE(paid_at, created_at)::date, 'YYYY-MM-DD') AS date,
               COALESCE(SUM(amount), 0) AS amount
        FROM platform_fees WHERE status = 'paid'
        GROUP BY date ORDER BY date DESC LIMIT $1
    """
    try:
        rows = await db.fetch(query, limit)
    except Exception as exc:
        logger.exception("Revenue chart query failed")
        raise HTTPException(status_code=503, detail="Revenue chart is temporarily unavailable") from exc
    return list(reversed([{"date": row["date"], "amount": float(row["amount"])} for row in rows]))


@router.get("/mechanics/{mechanic_id}/reviews")
async def mechanic_reviews(mechanic_id: int, limit: int = 50, db=Depends(get_db), admin=Depends(verify_admin_token)):
    try:
        rows = await db.fetch(
            """SELECT r.id, r.request_id, r.rating, r.comment, r.created_at,
                      sr.customer_name, sr.service_type, sr.location
               FROM reviews r JOIN service_requests sr ON sr.id = r.request_id
               WHERE r.mechanic_id = $1 ORDER BY r.created_at DESC LIMIT $2""",
            mechanic_id, limit,
        )
        total = await db.fetchval("SELECT COUNT(*) FROM reviews WHERE mechanic_id = $1", mechanic_id)
        avg = await db.fetchval("SELECT AVG(rating)::NUMERIC(3,2) FROM reviews WHERE mechanic_id = $1", mechanic_id)
    except Exception as exc:
        logger.exception("Mechanic reviews query failed")
        raise HTTPException(status_code=503, detail="Mechanic reviews are temporarily unavailable") from exc
    reviews = []
    for row in rows:
        review = dict(row)
        if review.get("created_at"):
            review["created_at"] = review["created_at"].isoformat()
        reviews.append(review)
    return {"mechanic_id": mechanic_id, "total_reviews": total or 0, "average_rating": float(avg) if avg else None, "reviews": reviews}


class SystemLogOut(BaseModel):
    id: int
    actor_id: str
    actor_role: str
    action: str
    target_id: Optional[int] = None
    target_type: Optional[str] = None
    detail: Optional[str] = None
    created_at: Optional[str] = None


async def _ensure_system_logs(db):
    await db.execute("""
        CREATE TABLE IF NOT EXISTS system_logs (
            id SERIAL PRIMARY KEY, actor_id TEXT NOT NULL,
            actor_role TEXT NOT NULL DEFAULT 'system', action TEXT NOT NULL,
            target_id INTEGER, target_type TEXT, detail TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)


@router.get("/logs", tags=["Compliance"])
async def list_system_logs(
    action: Optional[str] = Query(None),
    actor_role: Optional[str] = Query(None),
    target_type: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db=Depends(get_db),
    admin=Depends(verify_admin_token),
):
    await _ensure_system_logs(db)
    conditions = []
    params = []
    if action:
        conditions.append(f"action = ${len(params)+1}")
        params.append(action)
    if actor_role:
        conditions.append(f"actor_role = ${len(params)+1}")
        params.append(actor_role)
    if target_type:
        conditions.append(f"target_type = ${len(params)+1}")
        params.append(target_type)
    where_sql = "WHERE " + " AND ".join(conditions) if conditions else ""

    total = await db.fetchval(f"SELECT COUNT(*) FROM system_logs {where_sql}", *params)
    rows = await db.fetch(
        f"""
        SELECT id, actor_id, actor_role, action, target_id, target_type, detail, created_at
        FROM system_logs
        {where_sql}
        ORDER BY created_at DESC
        LIMIT ${len(params)+1} OFFSET ${len(params)+2}
        """,
        *params, limit, offset,
    )

    logs = []
    for r in rows:
        lg = dict(r)
        if lg.get("created_at"):
            lg["created_at"] = lg["created_at"].isoformat()
        logs.append(lg)

    return {
        "total": total or 0,
        "limit": limit,
        "offset": offset,
        "logs": logs,
    }


@router.post("/logs", tags=["Compliance"])
async def write_system_log(
    actor_id: str,
    actor_role: str,
    action: str,
    target_id: Optional[int] = None,
    target_type: Optional[str] = None,
    detail: Optional[str] = None,
    db=Depends(get_db),
    admin=Depends(verify_admin_token),
):
    """Manually write a compliance audit log entry (admin only)."""
    await _ensure_system_logs(db)
    row = await db.fetchrow(
        """
        INSERT INTO system_logs (actor_id, actor_role, action, target_id, target_type, detail)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, actor_id, actor_role, action, target_id, target_type, detail, created_at
        """,
        actor_id, actor_role, action, target_id, target_type, detail,
    )
    result = dict(row)
    if result.get("created_at"):
        result["created_at"] = result["created_at"].isoformat()
    return result


@router.get("/compliance/report", tags=["Compliance"])
async def compliance_report(
    db=Depends(get_db),
    auth_db=Depends(get_auth_db),
    admin=Depends(verify_admin_token),
):
    """
    Summary compliance report for KCCA/UNRA submission.
    Covers verifications performed, requests handled, payments processed.
    """
    await _ensure_system_logs(db)

    total_requests = await db.fetchval("SELECT COUNT(*) FROM service_requests") or 0
    completed = await db.fetchval(
        "SELECT COUNT(*) FROM service_requests WHERE status = 'completed'"
    ) or 0
    cancelled = await db.fetchval(
        "SELECT COUNT(*) FROM service_requests WHERE status = 'cancelled'"
    ) or 0
    total_mechanics = await auth_db.fetchval("SELECT COUNT(*) FROM mechanics") or 0
    verified_mechanics = await auth_db.fetchval(
        "SELECT COUNT(*) FROM mechanics WHERE is_verified = true"
    ) or 0
    total_payments = await db.fetchval("SELECT COUNT(*) FROM payments") or 0
    job_collected_ugx = await db.fetchval(
        "SELECT COALESCE(SUM(quoted_amount), 0) FROM payments WHERE collection_status IN ('success','successful','cash')"
    ) or 0
    job_payouts_ugx = await db.fetchval(
        "SELECT COALESCE(SUM(mechanic_payout), 0) FROM payments WHERE disbursement_status = 'successful'"
    ) or 0
    fees_collected_ugx = await db.fetchval(
        "SELECT COALESCE(SUM(amount), 0) FROM platform_fees WHERE status = 'paid'"
    ) or 0
    fees_owed_ugx = await db.fetchval(
        "SELECT COALESCE(SUM(amount), 0) FROM platform_fees WHERE status = 'owed'"
    ) or 0

    # Verification events in the last 30 days
    verifications_30d = await db.fetchval(
        """
        SELECT COUNT(*) FROM system_logs
        WHERE action IN ('MECHANIC_VERIFIED', 'MECHANIC_UNVERIFIED')
          AND created_at >= NOW() - INTERVAL '30 days'
        """
    ) or 0

    return {
        "report_generated_at": datetime.utcnow().isoformat() + "Z",
        "service_requests": {
            "total": total_requests,
            "completed": completed,
            "cancelled": cancelled,
            "completion_rate_pct": round(completed / total_requests * 100, 1) if total_requests else 0,
        },
        "mechanic_management": {
            "total_registered": total_mechanics,
            "verified": verified_mechanics,
            "unverified": total_mechanics - verified_mechanics,
            "verification_events_last_30d": verifications_30d,
        },
        "job_payment_records": {
            "total_records": total_payments,
            "quoted_amounts_collected_ugx": float(job_collected_ugx),
            "mechanic_payouts_recorded_ugx": float(job_payouts_ugx),
        },
        "platform_fees": {
            "collected_ugx": float(fees_collected_ugx),
            "outstanding_ugx": float(fees_owed_ugx),
        },
        "compliance_framework": "Uganda Data Protection and Privacy Act (2019)",
        "reporting_entities": ["KCCA", "UNRA"],
    }


# ─────────────── SUBSCRIPTION MANAGEMENT ───────────────

class SubscriptionRecord(BaseModel):
    mechanic_id: int
    mechanic_phone: str
    status: str                              # trial | active | grace | expired
    plan: Optional[str] = "monthly"
    amount_ugx: Optional[int] = 20000
    trial_ends_at: Optional[str] = None
    current_period_start: Optional[str] = None
    current_period_end: Optional[str] = None
    grace_ends_at: Optional[str] = None
    payment_ref: Optional[str] = None
    payment_method: Optional[str] = None


class RecordPaymentIn(BaseModel):
    mechanic_id: int
    mechanic_phone: str
    amount_ugx: int = 20000
    payment_method: str = "bank_transfer"
    payment_ref: Optional[str] = None
    recorded_by: Optional[str] = None


@router.get("/subscriptions")
async def list_subscriptions(
    status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=200),
    db=Depends(get_db),
    admin=Depends(verify_admin_token),
):
    """List mechanic subscriptions with optional status filter."""
    if os.getenv("ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS", "").lower() != "true":
        raise HTTPException(
            status_code=410,
            detail="Legacy subscription routes are disabled by default. Set ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS=true to enable them.",
        )
    offset = (page - 1) * pageSize
    conditions = []
    params: list = []

    if status:
        conditions.append(f"status = ${len(params)+1}")
        params.append(status)

    where_sql = "WHERE " + " AND ".join(conditions) if conditions else ""
    total = await db.fetchval(f"SELECT COUNT(*) FROM subscriptions {where_sql}", *params)
    rows = await db.fetch(
        f"""SELECT * FROM subscriptions {where_sql}
            ORDER BY updated_at DESC
            LIMIT ${len(params)+1} OFFSET ${len(params)+2}""",
        *params, pageSize, offset,
    )

    def _fmt(r):
        d = dict(r)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        return d

    return {
        "data": [_fmt(r) for r in rows],
        "page": page, "pageSize": pageSize,
        "total": total or 0,
        "totalPages": max(1, ((total or 0) + pageSize - 1) // pageSize),
    }


@router.post("/subscriptions/record-payment")
async def record_subscription_payment(
    body: RecordPaymentIn,
    db=Depends(get_db),
    admin=Depends(verify_admin_token),
):
    """
    Admin records a bank-transfer subscription payment for a mechanic.
    Activates or renews the subscription for one calendar month.
    """
    if os.getenv("ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS", "").lower() != "true":
        raise HTTPException(
            status_code=410,
            detail="Legacy subscription routes are disabled by default. Set ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS=true to enable them.",
        )
    from datetime import timezone, timedelta

    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    period_start = now
    period_end = now + timedelta(days=30)

    # Upsert subscription row
    await db.execute("""
        INSERT INTO subscriptions
            (mechanic_id, mechanic_phone, status, plan, amount_ugx,
             current_period_start, current_period_end, payment_ref, payment_method, updated_at)
        VALUES ($1,$2,'active','monthly',$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (mechanic_id) DO UPDATE SET
            status               = 'active',
            current_period_start = EXCLUDED.current_period_start,
            current_period_end   = EXCLUDED.current_period_end,
            payment_ref          = EXCLUDED.payment_ref,
            payment_method       = EXCLUDED.payment_method,
            amount_ugx           = EXCLUDED.amount_ugx,
            grace_ends_at        = NULL,
            updated_at           = NOW()
    """, body.mechanic_id, body.mechanic_phone, body.amount_ugx,
         period_start, period_end, body.payment_ref, body.payment_method)

    # Log the payment event
    await db.execute("""
        INSERT INTO subscription_payments
            (mechanic_id, mechanic_phone, amount_ugx, payment_method, payment_ref,
             period_start, period_end, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    """, body.mechanic_id, body.mechanic_phone, body.amount_ugx,
         body.payment_method, body.payment_ref, period_start, period_end,
         body.recorded_by or "admin")

    return {
        "message": "Payment recorded — subscription activated",
        "mechanic_id": body.mechanic_id,
        "status": "active",
        "period_end": period_end.isoformat(),
    }


@router.get("/subscriptions/{mechanic_id}")
async def get_subscription(
    mechanic_id: int,
    db=Depends(get_db),
    admin=Depends(verify_admin_token),
):
    """Get the current subscription state for a mechanic."""
    if os.getenv("ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS", "").lower() != "true":
        raise HTTPException(
            status_code=410,
            detail="Legacy subscription routes are disabled by default. Set ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS=true to enable them.",
        )
    row = await db.fetchrow(
        "SELECT * FROM subscriptions WHERE mechanic_id = $1", mechanic_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="No subscription found for this mechanic")
    d = dict(row)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


@router.get("/subscriptions/{mechanic_id}/payments")
async def subscription_payment_history(
    mechanic_id: int,
    limit: int = 24,
    db=Depends(get_db),
    admin=Depends(verify_admin_token),
):
    """Full payment history for a mechanic's subscription."""
    if os.getenv("ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS", "").lower() != "true":
        raise HTTPException(
            status_code=410,
            detail="Legacy subscription routes are disabled by default. Set ENABLE_LEGACY_SUBSCRIPTION_ENDPOINTS=true to enable them.",
        )
    rows = await db.fetch(
        """SELECT * FROM subscription_payments WHERE mechanic_id = $1
           ORDER BY created_at DESC LIMIT $2""",
        mechanic_id, limit,
    )
    results = []
    for r in rows:
        d = dict(r)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        results.append(d)
    return {"mechanic_id": mechanic_id, "payments": results}


# ─────────────── ADMIN NOTIFICATIONS FEED ───────────────

@router.get("/notifications")
async def admin_notifications(
    limit: int = Query(30, ge=1, le=100),
    db=Depends(get_db),
    auth_db=Depends(get_auth_db),
    admin=Depends(verify_admin_token),
):
    """
    Aggregate real events into a notification feed for the admin portal.
    Sources: service_requests, payments (dispatch DB) + provider_applications, users (auth DB).
    """
    events = []

    # ── Service requests ─────────────────────────────────────────────
    try:
        rows = await db.fetch(
            """SELECT id, customer_name, service_type, location, status, created_at
               FROM service_requests
               ORDER BY created_at DESC
               LIMIT 15"""
        )
        for r in rows:
            cname = r["customer_name"] or "A driver"
            stype = (r["service_type"] or "service").lower()
            loc   = r["location"] or "unknown location"
            status = r["status"] or "pending"
            events.append({
                "id":         f"req-{r['id']}",
                "type":       "request",
                "title":      "New Service Request",
                "body":       f"{cname} submitted a {stype} request.",
                "detail":     (
                    f"{cname} submitted a service request for {stype} at {loc}. "
                    f"Current status: {status}. Request ID: #{r['id']}."
                ),
                "created_at": r["created_at"].isoformat(),
            })
    except Exception as exc:
        logger.exception("Recent service-request activity query failed")
        raise HTTPException(status_code=503, detail="Recent activity is temporarily unavailable") from exc

    # ── Successful payments ──────────────────────────────────────────
    try:
        rows = await db.fetch(
            """SELECT p.id, p.request_id, p.quoted_amount, p.collection_status,
                      p.disbursement_status, p.created_at,
                      sr.customer_name, sr.service_type
               FROM payments p
               LEFT JOIN service_requests sr ON p.request_id = sr.id
               WHERE p.collection_status IN ('success','successful','cash')
               ORDER BY p.created_at DESC
               LIMIT 10"""
        )
        for r in rows:
            cname = r["customer_name"] or "a driver"
            amt   = int(r["quoted_amount"] or 0)
            stype = r["service_type"] or "service"
            events.append({
                "id":         f"pay-{r['id']}",
                "type":       "payment",
                "title":      "Payment Received",
                "body":       f"UGX {amt:,} collected for Request #{r['request_id']}.",
                "detail":     (
                    f"A payment of UGX {amt:,} was successfully collected for "
                    f"Request #{r['request_id']} ({stype} — {cname}). "
                    f"Disbursement status: {r['disbursement_status'] or 'pending'}."
                ),
                "created_at": r["created_at"].isoformat(),
            })
    except Exception as exc:
        logger.exception("Recent job-payment activity query failed")
        raise HTTPException(status_code=503, detail="Recent activity is temporarily unavailable") from exc

    # ── Provider applications ────────────────────────────────────────
    try:
        rows = await auth_db.fetch(
            """SELECT id, full_name, phone, provider_type, service_area,
                      verification_status, submitted_at
               FROM provider_applications
               ORDER BY submitted_at DESC
               LIMIT 10"""
        )
        for r in rows:
            name   = r["full_name"] or "A provider"
            ptype  = (r["provider_type"] or "provider").replace("_", " ")
            area   = r["service_area"] or "unspecified area"
            vstatus = r["verification_status"] or "pending"
            ts = r["submitted_at"]
            events.append({
                "id":         f"app-{r['id']}",
                "type":       "provider",
                "title":      "Provider Application",
                "body":       f"{name} applied as a {ptype}.",
                "detail":     (
                    f"{name} ({r['phone']}) submitted a {ptype} application. "
                    f"Service area: {area}. Verification status: {vstatus}."
                ),
                "created_at": ts.isoformat() if ts else datetime.utcnow().isoformat(),
            })
    except Exception as exc:
        logger.exception("Provider-application activity query failed")
        raise HTTPException(status_code=503, detail="Recent activity is temporarily unavailable") from exc

    # ── Driver registrations ─────────────────────────────────────────
    try:
        rows = await auth_db.fetch(
            """SELECT id, phone, full_name, number_plate, vehicle_type, created_at
               FROM users
               ORDER BY created_at DESC
               LIMIT 10"""
        )
        for r in rows:
            name    = r["full_name"] or r["phone"] or "A driver"
            plate   = r["number_plate"] or ""
            vtype   = r["vehicle_type"] or ""
            vehicle = f" ({vtype} — {plate})" if plate else (f" ({vtype})" if vtype else "")
            events.append({
                "id":         f"drv-{r['id']}",
                "type":       "driver",
                "title":      "New Driver Registered",
                "body":       f"{name} completed driver registration.",
                "detail":     (
                    f"{name} (Phone: {r['phone']}) registered as a driver{vehicle}. "
                    f"Account is active."
                ),
                "created_at": r["created_at"].isoformat(),
            })
    except Exception as exc:
        logger.exception("Driver-registration activity query failed")
        raise HTTPException(status_code=503, detail="Recent activity is temporarily unavailable") from exc

    # ── Platform-fee payments (a mechanic settled their owed balance) ─────────
    # Paid platform_fees rows live in the dispatch DB; group them into one event per
    # payment (same ref = one MoMo payment) so the admin sees "X paid UGX Y for N jobs".
    try:
        rows = await db.fetch(
            """SELECT mechanic_id, payment_ref, request_id, amount, paid_at
               FROM platform_fees
               WHERE status = 'paid' AND paid_at IS NOT NULL
               ORDER BY paid_at DESC
               LIMIT 60"""
        )
        groups: dict = {}
        for r in rows:
            key = (r["mechanic_id"], r["payment_ref"] or r["paid_at"].isoformat())
            g = groups.setdefault(key, {
                "mechanic_id": r["mechanic_id"], "ref": r["payment_ref"],
                "amount": 0, "jobs": [], "paid_at": r["paid_at"],
            })
            g["amount"] += int(r["amount"] or 0)
            g["jobs"].append(int(r["request_id"]))
            if r["paid_at"] and r["paid_at"] > g["paid_at"]:
                g["paid_at"] = r["paid_at"]

        # Resolve mechanic names from the auth DB (mechanics, then towing_providers).
        mech_ids = list({g["mechanic_id"] for g in groups.values()})
        names: dict = {}
        if mech_ids:
            try:
                for n in await auth_db.fetch("SELECT id, full_name FROM mechanics WHERE id = ANY($1::int[])", mech_ids):
                    names[n["id"]] = n["full_name"]
            except Exception as exc:
                logger.exception("Mechanic-name activity lookup failed")
                raise HTTPException(status_code=503, detail="Recent activity provider data is unavailable") from exc
            try:
                for t in await auth_db.fetch("SELECT id, full_name FROM towing_providers WHERE id = ANY($1::int[])", mech_ids):
                    names.setdefault(t["id"], t["full_name"])
            except Exception as exc:
                logger.exception("Towing-provider activity lookup failed")
                raise HTTPException(status_code=503, detail="Recent activity provider data is unavailable") from exc

        for g in sorted(groups.values(), key=lambda x: x["paid_at"], reverse=True)[:10]:
            name = names.get(g["mechanic_id"]) or "A mechanic"
            n = len(g["jobs"])
            ids = ", ".join(f"#{j}" for j in g["jobs"])
            events.append({
                "id":         f"feepay-{g['mechanic_id']}-{g['ref'] or g['paid_at'].isoformat()}",
                "type":       "payment",
                "title":      "Platform Fee Paid",
                "body":       f"{name} paid UGX {g['amount']:,} for {n} job{'s' if n != 1 else ''}.",
                "detail":     (
                    f"{name} settled UGX {g['amount']:,} in platform fees covering {n} completed "
                    f"job{'s' if n != 1 else ''} ({ids}). Payment ref {g['ref'] or '—'}. "
                    f"The mechanic's account has been reinstated and can go online again."
                ),
                "created_at": g["paid_at"].isoformat(),
            })
    except Exception as exc:
        logger.exception("Platform-fee activity query failed")
        raise HTTPException(status_code=503, detail="Recent activity is temporarily unavailable") from exc

    # ── Sort newest-first, cap at limit ─────────────────────────────
    events.sort(key=lambda x: x["created_at"], reverse=True)
    return events[:limit]