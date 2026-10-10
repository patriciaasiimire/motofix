# app/utils.py

from datetime import datetime, timedelta
import os
import logging

from jose import jwt
from dotenv import load_dotenv

load_dotenv()


def create_jwt(data: dict, role: str = "customer") -> str:
    """
    Create a signed JWT.
    Expiry:
      - role == "admin"  → ADMIN_TOKEN_EXPIRE_HOURS  (default 8 h)
      - all other roles  → ACCESS_TOKEN_EXPIRE_HOURS (default 10 years)

    OTP is for login after explicit logout, a new install, or cleared app data,
    not periodic re-authentication.
    """
    if role == "admin":
        hours = int(os.getenv("ADMIN_TOKEN_EXPIRE_HOURS", 8))
    else:
        hours = int(os.getenv("ACCESS_TOKEN_EXPIRE_HOURS", 87600))

    to_encode = data.copy()
    now = datetime.utcnow()
    to_encode.update({
        "iat": now,
        "exp": now + timedelta(hours=hours),
    })

    secret    = os.getenv("SECRET_KEY")
    algorithm = os.getenv("ALGORITHM", "HS256")
    return jwt.encode(to_encode, secret, algorithm=algorithm)
