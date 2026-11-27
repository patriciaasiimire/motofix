import pytest
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)
OTP_PATHS = (
    "/auth/register/driver",
    "/auth/resend-otp",
    "/auth/verify-otp",
)
ALLOWED_TEST_ORIGINS = (
    "https://motofixug.netlify.app",
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
)


@pytest.mark.parametrize("origin", ALLOWED_TEST_ORIGINS)
@pytest.mark.parametrize("path", OTP_PATHS)
def test_otp_preflight_allows_web_and_capacitor_origins(origin: str, path: str):
    response = client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization,x-requested-with",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-credentials"] == "true"
    assert response.headers["access-control-expose-headers"] == "Authorization"
    allowed_headers = response.headers["access-control-allow-headers"].lower()
    assert "content-type" in allowed_headers
    assert "authorization" in allowed_headers
    assert "x-requested-with" in allowed_headers
