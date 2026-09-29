# app/routers/auth.py

from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["auth"])


class LoginIn(BaseModel):
    username: Optional[str] = "admin"
    password: str


class AdminLoginIn(BaseModel):
    email: str
    password: str


def _auth_service_only() -> None:
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Analytics admin login is disabled. Authentication is owned by auth-service; use POST /auth/login/admin.",
    )


@router.post("/login")
def legacy_login(_payload: LoginIn):
    _auth_service_only()


@router.post("/login/admin")
def legacy_admin_login(_payload: AdminLoginIn):
    _auth_service_only()