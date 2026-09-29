import os

os.environ.setdefault("SECRET_KEY", "matching-test-secret")

from fastapi.testclient import TestClient

import app.main as matching_main
from app.scoring import MAX_DISTANCE_KM, rank_mechanics, rank_launch_fallback


class FakeResponse:
    def __init__(self, mechanics):
        self._mechanics = mechanics

    def raise_for_status(self):
        return None

    def json(self):
        return self._mechanics


class FakeAsyncClient:
    def __init__(self, mechanics):
        self._mechanics = mechanics

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, *_args, **_kwargs):
        return FakeResponse(self._mechanics)


def _mechanic(mechanic_id=1, **overrides):
    return {
        "id": mechanic_id,
        "full_name": f"Mechanic {mechanic_id}",
        "phone": "+256700000000",
        "provider_type": "mechanic",
        "is_verified": True,
        "is_available": True,
        "latitude": 0.01,
        "longitude": 0,
        "service_area_ids": ["ntinda"],
        **overrides,
    }


def _post_match(monkeypatch, mechanics, launch_mode, lat=0.358, lon=32.611, service_type="breakdown rescue"):
    if monkeypatch is not None:
        monkeypatch.setattr(matching_main, "LAUNCH_MODE", launch_mode)
        monkeypatch.setattr(matching_main, "DATABASE_URL", None)
        monkeypatch.setattr(
            matching_main.httpx,
            "AsyncClient",
            lambda: FakeAsyncClient(mechanics),
        )
    matching_main.app.dependency_overrides[matching_main._require_token] = lambda: {"role": "driver"}
    try:
        with TestClient(matching_main.app) as client:
            return client.post(
                "/match",
                headers={"Authorization": "Bearer test-token"},
                json={
                    "request_id": 42,
                    "latitude": lat,
                    "longitude": lon,
                    "service_type": service_type,
                    "top_n": 5,
                },
            )
    finally:
        matching_main.app.dependency_overrides.pop(matching_main._require_token, None)


def test_launch_mode_returns_nearest_verified_available_generalist(monkeypatch):
    response = _post_match(monkeypatch, [_mechanic()], launch_mode=True)

    assert response.status_code == 200
    candidate = response.json()["candidates"][0]
    assert candidate["mechanic_id"] == 1
    assert candidate["rationale"].startswith("Launch fallback: nearest available")
    assert candidate["score_breakdown"]["spec_match"] == 0


def test_normal_mode_keeps_404_when_no_capable_match(monkeypatch):
    response = _post_match(monkeypatch, [_mechanic()], launch_mode=False)

    assert response.status_code == 404


def test_launch_fallback_never_returns_unverified_unavailable_or_distant_mechanics(monkeypatch):
    candidates = [
        _mechanic(1, is_verified=False),
        _mechanic(2, is_available=False),
        _mechanic(3, latitude=(MAX_DISTANCE_KM + 2) / 111.0, service_area_ids=["kira"]),
    ]
    response = _post_match(monkeypatch, candidates, launch_mode=True)

    assert response.status_code == 404


def test_assist_and_tow_types_rank_the_right_provider():
    mechanic = _mechanic(1, latitude=0.005)
    tow_provider = _mechanic(2, provider_type="towing_provider", specialty="Towing", latitude=0.01)

    assist = rank_mechanics([tow_provider, mechanic], 0.358, 32.611, "Roadside assist", area_id="ntinda")
    tow = rank_mechanics([mechanic, tow_provider], 0.358, 32.611, "Tow / recovery", area_id="ntinda")

    assert [candidate["mechanic_id"] for candidate in assist] == [1]
    assert [candidate["mechanic_id"] for candidate in tow] == [2]


def test_launch_fallback_prefers_capable_provider_before_nearer_alternate():
    mechanic = _mechanic(1, latitude=0.02)
    tow_provider = _mechanic(2, provider_type="towing_provider", specialty="Towing", latitude=0.001)

    fallback = rank_launch_fallback([tow_provider, mechanic], 0.358, 32.611, service_type="Roadside assist", area_id="ntinda")

    assert fallback[0]["mechanic_id"] == 1
    assert fallback[1]["mechanic_id"] == 2


def test_preferred_mechanic_is_boosted_only_when_eligible():
    first = _mechanic(1, latitude=0.01)
    preferred = _mechanic(2, latitude=0.02)
    ranked = rank_mechanics(
        [first, preferred], 0.358, 32.611, "Roadside assist", preferred_mechanic_id=2, area_id="ntinda"
    )
    assert ranked[0]["mechanic_id"] == 2

    unavailable_preferred = {**preferred, "is_available": False}
    fallback = rank_mechanics(
        [unavailable_preferred, first], 0.358, 32.611, "Roadside assist", preferred_mechanic_id=2, area_id="ntinda"
    )
    assert [candidate["mechanic_id"] for candidate in fallback] == [1]


def test_area_match_uses_service_areas_when_no_pin():
    match_lat = 0.358
    match_lon = 32.611
    in_area = _mechanic(1, latitude=None, longitude=None, service_area_ids=["ntinda"])
    other = _mechanic(2, latitude=None, longitude=None, service_area_ids=["kira"])

    ranked = rank_mechanics(
        [other, in_area],
        match_lat,
        match_lon,
        "Roadside assist",
        area_id="ntinda",
    )

    assert [candidate["mechanic_id"] for candidate in ranked] == [1]
    assert ranked[0]["distance_km"] < MAX_DISTANCE_KM


def test_area_filter_rejects_away_mechanics_even_if_verified_and_available(monkeypatch):
    response = _post_match(
        monkeypatch,
        [
            _mechanic(1, service_area_ids=["kira"]),
            _mechanic(2, service_area_ids=["ntinda"]),
        ],
        False,
        lat=0.358,
        lon=32.611,
        service_type="Roadside assist",
    )

    assert response.status_code == 200
    ids = [candidate["mechanic_id"] for candidate in response.json()["candidates"]]
    assert ids == [2]


def test_driver_outside_all_areas_returns_clear_error(monkeypatch):
    response = _post_match(monkeypatch, [
        _mechanic(1, service_area_ids=["ntinda"]),
    ], launch_mode=False)

    # This request is intentionally far from the Kampala catalog and should fail closed.
    matching_main.app.dependency_overrides[matching_main._require_token] = lambda: {"role": "driver"}
    try:
        with TestClient(matching_main.app) as client:
            payload = client.post(
                "/match",
                headers={"Authorization": "Bearer test-token"},
                json={
                    "request_id": 42,
                    "latitude": 1.0,
                    "longitude": 32.0,
                    "service_type": "breakdown rescue",
                    "top_n": 5,
                },
            )
        assert payload.status_code == 404
        assert "covered area" in payload.json()["detail"].lower()
    finally:
        matching_main.app.dependency_overrides.pop(matching_main._require_token, None)


def test_neighbor_expand_uses_adjacent_areas_only_when_primary_area_empty(monkeypatch):
    mech = _mechanic(3, service_area_ids=["kawempe"], latitude=None, longitude=None)
    response = _post_match(monkeypatch, [mech], launch_mode=False)

    assert response.status_code == 404