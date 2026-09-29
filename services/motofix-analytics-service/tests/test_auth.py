import os
import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException

os.environ.setdefault("ADMIN_JWT_SECRET", "testsecret123")

from app.main import app
from app.db import get_auth_db, get_db
from app.deps import verify_admin_token
from app.routers import admin as admin_router
from app.routers.admin import _normalise_payment_status, _payment_status_filter_values

client = TestClient(app)


@pytest.fixture(autouse=True)
def setup_env(monkeypatch):
    monkeypatch.setenv("ADMIN_JWT_SECRET", "testsecret123")
    monkeypatch.delenv("ALLOW_LEGACY_ADMIN_PASSWORD_LOGIN", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    # Keep the login path locked to the hashed-password flow in tests.
    yield


def test_legacy_password_login_is_disabled():
    resp = client.post("/api/login", json={"password": "test-admin-pass"})
    assert resp.status_code == 410
    assert "disabled" in resp.json()["detail"].lower()


def test_admin_token_issuance_is_owned_by_auth_service():
    resp = client.post(
        "/api/login/admin",
        json={"email": "admin@example.com", "password": "not-a-password"},
    )
    assert resp.status_code == 410
    assert "auth-service" in resp.json()["detail"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("successful", "success"),
        ("cash", "cash"),
        ("processing", "initiated"),
        ("declined", "failed"),
        ("expired", "failed"),
        ("canceled", "cancelled"),
        ("new_gateway_value", "unknown"),
        (None, "pending"),
    ],
)
def test_payment_statuses_are_normalized_at_the_api_boundary(raw, expected):
    assert _normalise_payment_status(raw) == expected


def test_unknown_payment_status_cannot_be_used_as_a_filter():
    with pytest.raises(HTTPException) as exc_info:
        _payment_status_filter_values("new_gateway_value")
    assert exc_info.value.status_code == 422


def test_analytics_has_no_provider_write_routes():
    provider_routes = [
        route for route in admin_router.router.routes
        if route.path.startswith(("/admin/mechanics", "/admin/towing-providers"))
    ]
    assert provider_routes
    assert all(not (route.methods & {"POST", "PATCH", "DELETE"}) for route in provider_routes)


def test_dashboard_stats_returns_503_when_database_query_fails():
    class BrokenDatabase:
        async def fetchval(self, *_args, **_kwargs):
            raise RuntimeError("database unavailable")

    async def database_dependency():
        yield BrokenDatabase()

    app.dependency_overrides[get_db] = database_dependency
    app.dependency_overrides[get_auth_db] = database_dependency
    app.dependency_overrides[verify_admin_token] = lambda: {"role": "admin"}
    try:
        response = client.get("/admin/stats", headers={"Authorization": "Bearer test-token"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 503
    assert "temporarily unavailable" in response.json()["detail"]


def test_legacy_subscription_routes_are_disabled_by_default():
    resp = client.get("/subscriptions/me")
    assert resp.status_code == 404
    assert resp.json().get("detail") in (None, "Not Found")