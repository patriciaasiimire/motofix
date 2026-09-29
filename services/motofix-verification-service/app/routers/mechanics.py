# app/routers/mechanics.py
# Endpoints for listing and managing mechanic records. The most important one is the
# "list mechanics" query the matching service calls (it can filter to verified-only and
# available-only) to find candidates for a breakdown. Also supports create/update/lookup.

from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Optional
from pydantic import BaseModel
import asyncpg

router = APIRouter(prefix="/mechanics", tags=["Mechanics"])

# ────────────────────────────── SCHEMAS ──────────────────────────────

class MechanicBase(BaseModel):
    phone: str
    name: str
    location: str | None = None
    is_verified: bool = False
    rating: int = 0
    jobs_completed: int = 0


class Mechanic(MechanicBase):
    id: int

    class Config:
        from_attributes = True  # For Pydantic v2 compatibility


# ────────────────────────────── DEPENDENCY ──────────────────────────────

async def get_db() -> asyncpg.Connection:
    from ..main import pool  # Import pool from main.py
    async with pool.acquire() as conn:
        yield conn


# ────────────────────────────── ENDPOINTS ──────────────────────────────

@router.get("/")
async def read_all(
    db: asyncpg.Connection = Depends(get_db),
    verified_only: Optional[bool] = Query(None),
    available_only: Optional[bool] = Query(None),
):
    """
    List mechanics. Supports verified_only and available_only filters.
    Returns extended fields required by the matching/scoring service:
    latitude, longitude, specialisations (array), avg_rating, rating_count, fcm_token.
    """
    conditions = []
    if verified_only:
        conditions.append("is_verified = true")
    if available_only:
        conditions.append("is_available = true")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    rows = await db.fetch(f"""
        SELECT id, phone, full_name, location, latitude, longitude,
               specialty, is_available, is_verified, rating, total_ratings,
               jobs_completed, fcm_token
        FROM mechanics
        {where}
        ORDER BY id DESC
    """)

    result = []
    for r in rows:
        row = dict(r)
        # Normalise field names to what the scoring algorithm expects
        row["name"] = row.pop("full_name", None) or f"Mechanic {row['id']}"
        row["avg_rating"] = float(row.get("rating") or 0)
        row["rating_count"] = int(row.get("total_ratings") or 0)
        # Split specialty CSV into specialisations array
        spec = (row.get("specialty") or "").strip()
        row["specialisations"] = [s.strip() for s in spec.split(",") if s.strip()] if spec else []
        result.append(row)

    return result


@router.get("/{mechanic_id}", response_model=Mechanic)
async def read_one(mechanic_id: int, db: asyncpg.Connection = Depends(get_db)):
    query = """
        SELECT id, phone, full_name AS name, location, is_verified, rating, jobs_completed
        FROM mechanics
        WHERE id = $1
    """
    result = await db.fetchrow(query, mechanic_id)
    if not result:
        raise HTTPException(status_code=404, detail="Mechanic not found")
    return dict(result)



