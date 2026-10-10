import math
import os
from typing import Iterable, List, Optional


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

AREA_DEFAULT_RADIUS_KM = float(os.getenv("AREA_DEFAULT_RADIUS_KM", "4.5"))

AREA_CATALOG = [
    {
        "id": "ntinda",
        "name": "Ntinda",
        "center_lat": 0.358,
        "center_lng": 32.611,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["najjera", "nakawa", "wandegeya", "kira"],
    },
    {
        "id": "maganjo",
        "name": "Maganjo",
        "center_lat": 0.392,
        "center_lng": 32.706,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["kira", "nakawa", "bukoto"],
    },
    {
        "id": "makerere",
        "name": "Makerere",
        "center_lat": 0.334,
        "center_lng": 32.568,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["wandegeya", "nakawa", "mengo"],
    },
    {
        "id": "wandegeya",
        "name": "Wandegeya",
        "center_lat": 0.347,
        "center_lng": 32.571,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["makerere", "ntinda", "nakawa", "mengo"],
    },
    {
        "id": "kampala_central",
        "name": "Kampala Central",
        "center_lat": 0.313,
        "center_lng": 32.582,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["kololo", "nakawa", "mengo", "rubaga"],
    },
    {
        "id": "najjera",
        "name": "Najjera",
        "center_lat": 0.366,
        "center_lng": 32.628,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["ntinda", "kira", "nakawa"],
    },
    {
        "id": "kira",
        "name": "Kira",
        "center_lat": 0.323,
        "center_lng": 32.674,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["maganjo", "najjera", "ntinda", "nakawa"],
    },
    {
        "id": "bukoto",
        "name": "Bukoto",
        "center_lat": 0.315,
        "center_lng": 32.609,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["kololo", "nakawa", "kampala_central", "maganjo"],
    },
    {
        "id": "kololo",
        "name": "Kololo",
        "center_lat": 0.316,
        "center_lng": 32.604,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["bukoto", "kampala_central", "mengo"],
    },
    {
        "id": "nakawa",
        "name": "Nakawa",
        "center_lat": 0.331,
        "center_lng": 32.616,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["ntinda", "wandegeya", "kampala_central", "industrial_area"],
    },
    {
        "id": "industrial_area",
        "name": "Industrial Area",
        "center_lat": 0.321,
        "center_lng": 32.592,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["nakawa", "kampala_central", "rubaga"],
    },
    {
        "id": "kawempe",
        "name": "Kawempe",
        "center_lat": 0.354,
        "center_lng": 32.553,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["bwaise", "rubaga", "wandegeya"],
    },
    {
        "id": "bwaise",
        "name": "Bwaise",
        "center_lat": 0.346,
        "center_lng": 32.548,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["kawempe", "rubaga", "wandegeya"],
    },
    {
        "id": "natete",
        "name": "Natete",
        "center_lat": 0.323,
        "center_lng": 32.608,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["bukoto", "nakawa", "rubaga"],
    },
    {
        "id": "mengo",
        "name": "Mengo",
        "center_lat": 0.301,
        "center_lng": 32.571,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["kampala_central", "wandegeya", "makerere", "rubaga"],
    },
    {
        "id": "rubaga",
        "name": "Rubaga",
        "center_lat": 0.314,
        "center_lng": 32.548,
        "radius_km": AREA_DEFAULT_RADIUS_KM,
        "neighbors": ["mengo", "kampala_central", "kawempe", "bwaise"],
    },
]

AREA_INDEX = {area["id"]: area for area in AREA_CATALOG}
AREA_NAMES = {area["id"]: area["name"] for area in AREA_CATALOG}
AREA_IDS = {area["id"] for area in AREA_CATALOG}

# Verification-service launch area IDs mapped to the matching service's broader
# launch regions. These are service-area memberships, not mechanic GPS coordinates.
SERVICE_AREA_MATCH_AREAS = {
    15: ("ntinda",),
    19: ("nakawa",),
    11: ("nakawa",),
    16: ("ntinda",),
    20: ("ntinda",),
    22: ("nakawa", "kampala_central"),
    54: ("kawempe",),
    38: ("kawempe",),
    57: ("bwaise",),
    56: ("bwaise",),
    52: ("bwaise",),
    75: ("makerere", "wandegeya"),
    80: ("wandegeya",),
    60: ("makerere",),
    44: ("makerere",),
    61: ("mengo",),
    47: ("mengo", "kampala_central"),
    51: ("bwaise", "kawempe"),
}


def normalize_service_area_ids(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (str, int)):
        raw_values = [value]
    else:
        raw_values = list(value)

    ids: List[str] = []
    for raw in raw_values:
        if raw is None:
            continue
        if isinstance(raw, int):
            ids.extend(SERVICE_AREA_MATCH_AREAS.get(raw, ()))
            continue
        parts = str(raw).strip().replace(" ", "_")
        if not parts:
            continue
        if parts.isdigit():
            ids.extend(SERVICE_AREA_MATCH_AREAS.get(int(parts), ()))
            continue
        cleaned = parts.lower()
        if cleaned in AREA_IDS:
            ids.append(cleaned)
        else:
            # allow common legacy aliases like "Kampala Central" or "Wandegeya"
            alias_map = {area["name"].lower().replace(" ", "_"): area["id"] for area in AREA_CATALOG}
            canonical = alias_map.get(cleaned)
            if canonical:
                ids.append(canonical)
    return list(dict.fromkeys(ids))


def area_neighbors(area_id: str) -> List[str]:
    area = AREA_INDEX.get(area_id)
    if not area:
        return []
    return list(dict.fromkeys((area.get("neighbors") or []) + [area_id]))


def resolve_area(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    if lat is None or lng is None:
        return None
    best_area_id = None
    best_distance_km = None
    for area in AREA_CATALOG:
        distance_km = haversine_km(lat, lng, float(area["center_lat"]), float(area["center_lng"]))
        if distance_km <= float(area["radius_km"]):
            if best_distance_km is None or distance_km < best_distance_km:
                best_area_id = area["id"]
                best_distance_km = distance_km
    return best_area_id


def service_area_matches(mechanic: dict, area_id: Optional[str], include_neighbors: bool = False) -> bool:
    if not area_id:
        return True
    area_ids = {area_id}
    if include_neighbors:
        area_ids.update(area_neighbors(area_id))
    mechanic_areas = set(normalize_service_area_ids(
        mechanic.get("service_area_ids")
        or mechanic.get("service_areas")
        or mechanic.get("areas")
        or mechanic.get("area_ids")
        or []
    ))
    return bool(mechanic_areas & area_ids)
