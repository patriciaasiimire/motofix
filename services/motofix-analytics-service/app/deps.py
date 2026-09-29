# app/deps.py
# The "admins only" gatekeeper for this service. Add verify_admin_token as a
# dependency on any endpoint and it will reject anyone whose token is missing,
# invalid, or not an admin — so reporting data is never exposed to regular users.

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt
import os
import logging

logger = logging.getLogger(__name__)
security = HTTPBearer()


def _require_secret() -> str:
    secret = os.getenv("ADMIN_JWT_SECRET") or os.getenv("SECRET_KEY")
    if not secret:
        logger.critical("Missing required admin JWT secret for analytics-service")
        raise RuntimeError(
            "Missing required admin JWT secret. Set ADMIN_JWT_SECRET in the environment before starting analytics-service."
        )
    return secret


SECRET_KEY = _require_secret()
ALGORITHM = "HS256"


def verify_admin_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    # Read the token from the request, confirm it's genuine, and require role == "admin".
    # Returns the token contents on success; otherwise raises 401 (bad token) or 403 (not admin).
    if not SECRET_KEY:
        raise HTTPException(status_code=503, detail="Admin JWT secret is not configured")
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Not authorized")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    return payload