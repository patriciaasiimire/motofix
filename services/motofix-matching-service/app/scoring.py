"""
Intelligent mechanic-matching scorer.

In plain words: when a driver reports a breakdown, this file decides WHICH nearby
mechanic should be offered the job first. It gives every mechanic a score out of 100
based on four things — do they have the right skill, are they reliable, are they
close by, and are they well rated — then ranks them best-first. The numbers below
(the "weights") say how much each of those four things matters.

Weights mirror the production XGBoost-Monotonic matching model's learned feature
importances (Top-1 accuracy 73%): expertise and availability dominate, with arrival
speed deliberately secondary — so a complex breakdown isn't sent to a closer
generalist. The monotonic property is preserved here by the linear proximity term:
match priority falls as distance rises, unless offset by stronger skill/rating.

  spec_match    35.46%  — right skill for the fault (primary filter)
  availability  29.78%  — available & reliable enough to take + finish the job
  proximity     10.20%  — arrival speed (secondary to expertise)
  rating         2.67%  — historical star quality
"""

import math
import os
from typing import Any, Dict, List, Optional

# ── Model feature importances (from the XGBoost-Monotonic matching model) ──────
WEIGHT_SPEC_MATCH   = 0.3546
WEIGHT_AVAILABILITY = 0.2978
WEIGHT_PROXIMITY    = 0.1020
WEIGHT_RATING       = 0.0267
# The four published importances sum to ~0.781; we normalise the final score by
# this so the headline number reads as a 0–100 "match priority %".
_WEIGHT_SUM = WEIGHT_SPEC_MATCH + WEIGHT_AVAILABILITY + WEIGHT_PROXIMITY + WEIGHT_RATING

# Hard cutoff — mechanics beyond this distance are not considered.
MAX_DISTANCE_KM = float(os.getenv("MATCH_MAX_DISTANCE_KM", "50"))
if MAX_DISTANCE_KM <= 0:
    raise RuntimeError("MATCH_MAX_DISTANCE_KM must be greater than zero")

# ── Capability matching ────────────────────────────────────────────────────────
# A request needs a specific capability; breakdown needs BOTH (the provider can
# either fix it on-site OR tow it if it can't be fixed).
_TOW_TERMS = {"tow", "towing", "recovery", "flatbed", "winch", "haul", "wrecker"}
_MECH_TERMS = {
    "mechanic", "mechanical", "repair", "engine", "electrical", "tyre", "tire",
    "battery", "brake", "suspension", "service", "diagnos", "fuel", "transmission",
}


def _capabilities(mechanic: Dict[str, Any]) -> tuple[bool, bool]:
    """Return (can_mechanic, can_tow) from provider_type, with a specialisations fallback."""
    pt = str(mechanic.get("provider_type") or "").strip().lower()
    specs = " ".join(mechanic.get("specialisations") or []).lower() + " " + str(mechanic.get("specialty") or "").lower()
    spec_tow = any(t in specs for t in _TOW_TERMS)
    spec_mech = any(t in specs for t in _MECH_TERMS)
    if pt == "both":
        return True, True
    if pt in ("towing_provider", "towing", "tow"):
        return spec_mech, True
    if pt == "mechanic":
        return True, spec_tow
    # Unknown provider_type → infer purely from what they list (generalist = mechanic)
    return (spec_mech or not spec_tow), spec_tow


def _capability_tier(mechanic: Dict[str, Any], service_type: str) -> int:
    """How well this provider fits the request: 2 = ideal, 1 = eligible, 0 = not.

    Breakdown Rescue ("car won't move"): the provider must be able to TOW it (so an
    unfixable car can still be moved); a 'both' provider is IDEAL because they can
    also try to fix it on-site first. Mechanic-only is ineligible — they can't move
    a dead car. Mechanic & Repair just needs mechanical capability.
    """
    st = (service_type or "").lower()
    can_mech, can_tow = _capabilities(mechanic)
    if any(term in st for term in ("tow", "recovery", "garage transfer")):
        return 1 if can_tow else 0
    if any(term in st for term in ("roadside assist", "on-site assist", "first aid")):
        return 1 if can_mech else 0
    if "breakdown" in st:
        if can_mech and can_tow:
            return 2          # fix-or-tow → ideal
        if can_tow:
            return 1          # tow-only → can still move the car
        return 0              # mechanic-only can't move an immovable car
    if "towing_provider" in st or any(t in st for t in ("tow", "recovery", "winch", "flatbed")):
        return 1 if can_tow else 0
    return 1 if can_mech else 0

# ── Individual scorers ────────────────────────────────────────────────────────

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return the straight-line distance in km between two map points (lat/lon).

    This is the standard "haversine" formula — it measures distance across the
    curved surface of the Earth, so it's accurate for real-world locations.
    You don't need to understand the maths to use it: give it two points,
    it gives you how many kilometres apart they are.
    """
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _proximity_score(distance_km: float) -> float:
    """Linear decay: 100 at 0 km → 0 at MAX_DISTANCE_KM."""
    if distance_km >= MAX_DISTANCE_KM:
        return 0.0
    return (1.0 - distance_km / MAX_DISTANCE_KM) * 100.0


def _specialisation_score(mechanic_specialisations: List[str], service_type: str) -> float:
    """
    100 — exact / direct keyword match
     50 — partial overlap with generic vehicle/fault terms
     30 — generalist (no specialisations listed)
      0 — no relevant match
    """
    if not mechanic_specialisations:
        return 30.0  # generalist — slight credit over a clear mismatch

    normalised_st = service_type.lower()
    for spec in mechanic_specialisations:
        spec_lower = spec.lower()
        if normalised_st in spec_lower or spec_lower in normalised_st:
            return 100.0

    # Partial match via generic automotive terms
    generic_terms = {
        "vehicle", "car", "motorcycle", "motorbike", "boda",
        "engine", "electrical", "tyre", "tire", "towing", "brake",
        "suspension", "transmission", "fuel", "battery",
    }
    st_words = set(normalised_st.split())
    for spec in mechanic_specialisations:
        spec_words = set(spec.lower().split())
        if st_words & spec_words & generic_terms:
            return 50.0

    return 0.0


def _rating_score(avg_rating: float, rating_count: int) -> float:
    """
    Turn a 0–5 star rating into a 0–100 score.

    Catch: a mechanic with one 5-star review isn't as proven as one with fifty.
    So we trust the rating more the more reviews there are. With no reviews we
    give a neutral 50; the score only fully reflects the stars once they have
    20+ reviews. (This "trust it more as evidence grows" idea is what the term
    "Bayesian confidence damper" refers to.)
    """
    if rating_count == 0:
        return 50.0
    raw = (avg_rating / 5.0) * 100.0
    # confidence goes from 0 (no reviews) up to 1.0 (20+ reviews).
    confidence = min(1.0, rating_count / 20.0)
    # Mix the real star score with a neutral 50 based on how much we trust it.
    return confidence * raw + (1.0 - confidence) * 50.0


def _performance_score(jobs_completed: int, jobs_declined: int, jobs_expired: int) -> float:
    """
    Completion rate as a percentage.
    New mechanics with no job history get a neutral 50.
    """
    total = jobs_completed + jobs_declined + jobs_expired
    if total == 0:
        return 50.0
    return (jobs_completed / total) * 100.0


# ── Composite scorer ──────────────────────────────────────────────────────────

def _match_rationale(spec: float, avail: float, prox: float, rat: float, distance_km: float) -> str:
    """One-line, human explanation of why this mechanic scored as they did — the
    kind of verdict shown in the matching dashboard."""
    bits: List[str] = []
    if spec >= 100:   bits.append("exact specialist for this fault")
    elif spec >= 50:  bits.append("relevant skills for this fault")
    elif spec <= 0:   bits.append("generalist — not a specialist")
    if rat >= 80:     bits.append("strong rating")
    if avail >= 70:   bits.append("reliable & responsive")
    if prox >= 70:    bits.append("very close by")
    elif prox <= 30:  bits.append(f"~{distance_km:.0f} km away")
    if not bits:
        return "Balanced fit across skill, availability, distance and rating."
    head = bits[0][0].upper() + bits[0][1:]
    return head + ("; " + ", ".join(bits[1:]) if len(bits) > 1 else "") + "."


def score_mechanic(
    mechanic: Dict[str, Any],
    request_lat: float,
    request_lon: float,
    service_type: str,
    excluded_ids: Optional[List[int]] = None,
    preferred_mechanic_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Score a single mechanic against a breakdown request.
    Returns None if the mechanic is ineligible (excluded, unverified, too far).
    """
    if excluded_ids and mechanic.get("id") in excluded_ids:
        return None

    if not mechanic.get("is_verified"):
        return None

    # Accept both explicit is_available flag (if present) and absence of it
    if mechanic.get("is_available") is False:
        return None

    m_lat = mechanic.get("latitude")
    m_lon = mechanic.get("longitude")

    if m_lat is None or m_lon is None:
        distance_km = MAX_DISTANCE_KM  # treat missing location as max distance
    else:
        distance_km = haversine_km(request_lat, request_lon, float(m_lat), float(m_lon))

    if distance_km > MAX_DISTANCE_KM:
        return None

    prox = _proximity_score(distance_km)
    spec = _specialisation_score(mechanic.get("specialisations") or [], service_type)
    rat = _rating_score(
        float(mechanic.get("avg_rating") or 0),
        int(mechanic.get("rating_count") or 0),
    )
    perf = _performance_score(
        int(mechanic.get("jobs_completed") or 0),
        int(mechanic.get("jobs_declined") or 0),
        int(mechanic.get("jobs_expired") or 0),
    )

    # Availability/reliability of an already-available mechanic (unavailable ones
    # were gated out above) — the model's 2nd-biggest driver after spec_match.
    avail = perf

    raw_total = (
        spec  * WEIGHT_SPEC_MATCH
        + avail * WEIGHT_AVAILABILITY
        + prox  * WEIGHT_PROXIMITY
        + rat   * WEIGHT_RATING
    )
    # Normalise to a 0–100 "match priority %" (the headline figure in the dashboard).
    match_priority = round(raw_total / _WEIGHT_SUM, 2)

    return {
        "mechanic_id": mechanic["id"],
        "is_preferred": mechanic["id"] == preferred_mechanic_id,
        "mechanic_name": (
            mechanic.get("full_name")
            or mechanic.get("name")
            or f"Mechanic {mechanic['id']}"
        ),
        "phone": mechanic.get("phone"),
        "fcm_token": mechanic.get("fcm_token"),
        "distance_km": round(distance_km, 2),
        "capability_tier": _capability_tier(mechanic, service_type),
        "total_score": match_priority,
        "match_priority": match_priority,
        "rationale": _match_rationale(spec, avail, prox, rat, distance_km),
        "score_breakdown": {
            "spec_match": round(spec, 2),
            "availability": round(avail, 2),
            "proximity": round(prox, 2),
            "rating": round(rat, 2),
        },
        "weights": {
            "spec_match": WEIGHT_SPEC_MATCH,
            "availability": WEIGHT_AVAILABILITY,
            "proximity": WEIGHT_PROXIMITY,
            "rating": WEIGHT_RATING,
        },
    }


def rank_mechanics(
    mechanics: List[Dict[str, Any]],
    request_lat: float,
    request_lon: float,
    service_type: str,
    excluded_ids: Optional[List[int]] = None,
    top_n: int = 5,
    preferred_mechanic_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Score all mechanics, prefer those with the required capability, return top N.

    Capability is a hard gate for normal scoring. Launch mode has a separate,
    explicitly labelled distance-only fallback when no capable candidate exists.
    """
    scored = []
    for m in mechanics:
        result = score_mechanic(
            m, request_lat, request_lon, service_type, excluded_ids, preferred_mechanic_id
        )
        if result is not None:
            scored.append(result)
    eligible = [s for s in scored if s.get("capability_tier", 0) >= 1]
    # Sort by capability tier first (ideal 'both' over tow-only for breakdown), then score.
    eligible.sort(
        key=lambda x: (x["is_preferred"], x.get("capability_tier", 0), x["total_score"]),
        reverse=True,
    )
    return eligible[:top_n]


def rank_launch_fallback(
    mechanics: List[Dict[str, Any]],
    request_lat: float,
    request_lon: float,
    excluded_ids: Optional[List[int]] = None,
    top_n: int = 5,
    service_type: str = "",
    preferred_mechanic_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Return nearest verified, available providers without implying skill scores."""
    excluded = set(excluded_ids or [])
    candidates = []
    for mechanic in mechanics:
        mechanic_id = mechanic.get("id")
        if mechanic_id in excluded or not mechanic.get("is_verified"):
            continue
        if mechanic.get("is_available") is not True:
            continue
        latitude, longitude = mechanic.get("latitude"), mechanic.get("longitude")
        if latitude is None or longitude is None:
            continue

        distance = haversine_km(request_lat, request_lon, float(latitude), float(longitude))
        if distance > MAX_DISTANCE_KM:
            continue
        capability_tier = _capability_tier(mechanic, service_type)

        candidates.append({
            "mechanic_id": mechanic_id,
            "is_preferred": mechanic_id == preferred_mechanic_id,
            "mechanic_name": mechanic.get("full_name") or mechanic.get("name") or f"Mechanic {mechanic_id}",
            "phone": mechanic.get("phone"),
            "fcm_token": mechanic.get("fcm_token"),
            "distance_km": round(distance, 2),
            "capability_tier": capability_tier,
            "total_score": 0.0,
            "match_priority": 0.0,
            "rationale": (
                "Launch fallback: nearest available"
                if capability_tier >= 1
                else "Launch fallback: nearest available alternate provider type"
            ),
            "score_breakdown": {
                "spec_match": 0.0,
                "availability": 0.0,
                "proximity": 0.0,
                "rating": 0.0,
            },
            "weights": {
                "spec_match": WEIGHT_SPEC_MATCH,
                "availability": WEIGHT_AVAILABILITY,
                "proximity": WEIGHT_PROXIMITY,
                "rating": WEIGHT_RATING,
            },
        })

    candidates.sort(
        key=lambda candidate: (
            candidate["capability_tier"] >= 1,
            candidate["is_preferred"],
            -candidate["distance_km"],
        ),
        reverse=True,
    )
    return candidates[:top_n]
