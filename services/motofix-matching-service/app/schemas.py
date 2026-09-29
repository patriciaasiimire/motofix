# schemas.py
# Defines the SHAPE of the data this service sends and receives over the API.
# Each class is one "form": it lists the fields allowed, their types, and whether
# they're required. FastAPI uses these to automatically check incoming requests
# and to document the API. Read these first to understand what the service expects.
#
#   MatchRequest      — what the caller sends in (where + what kind of help is needed)
#   MechanicCandidate — one scored mechanic in the reply
#   MatchResponse     — the full reply: the ranked list of candidates
#   DispatchOutcome   — report back whether a mechanic accepted/declined/expired

from pydantic import BaseModel, Field
from typing import List, Optional, Dict


class MatchRequest(BaseModel):
    request_id: Optional[int] = Field(None, description="Service request ID (used for dispatch tracking and re-dispatch)")
    latitude: float = Field(..., description="Breakdown latitude")
    longitude: float = Field(..., description="Breakdown longitude")
    service_type: str = Field(..., description="Type of service needed, e.g. 'tyre change', 'towing', 'engine repair'")
    excluded_mechanic_ids: Optional[List[int]] = Field(
        default_factory=list,
        description="IDs of mechanics already tried for this request (manual override; DB history is also used automatically)",
    )
    preferred_mechanic_id: Optional[int] = Field(
        None,
        description="Driver's saved helper; boosted only when verified, available, nearby, and capable for this job type.",
    )
    top_n: Optional[int] = Field(5, description="Maximum number of candidates to return", ge=1, le=20)


class MechanicCandidate(BaseModel):
    mechanic_id: int
    mechanic_name: str
    phone: Optional[str]
    fcm_token: Optional[str] = None
    distance_km: float
    total_score: float
    match_priority: float = 0.0          # 0–100 headline "match priority %"
    rationale: str = ""                  # one-line human explanation of the score
    capability_tier: Optional[int] = None
    score_breakdown: Dict[str, float]
    weights: Dict[str, float]


class MatchResponse(BaseModel):
    request_id: Optional[int]
    candidates: List[MechanicCandidate]
    total_eligible: int


class DispatchOutcome(BaseModel):
    mechanic_id: int
    outcome: str = Field(..., description="One of: accepted, declined, expired")
