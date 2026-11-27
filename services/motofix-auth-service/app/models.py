# app/models.py
# Defines every database TABLE this service owns, described as Python classes.
# (This style — one class per table — is called an "ORM model", using SQLAlchemy.)
#
# These classes are the single source of truth for the table layout, and Alembic
# reads them to build/upgrade the real database (the "migrations").
# IMPORTANT: the live app does NOT query through these classes at runtime — it runs
# raw SQL directly via asyncpg in main.py. So treat this file as the blueprint of
# what columns exist, not as how data is fetched.
#
# Quick tour of the tables: users (drivers), mechanics, towing_providers, admins,
# system_logs (audit trail), otp_store (one-time codes), token_blacklist (logged-out tokens).

from sqlalchemy import (
    Column, Integer, String, Boolean, Float,
    Text, DateTime, ForeignKey, func
)
from .database import Base


# ── Users (drivers / customers) ───────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id           = Column(Integer, primary_key=True, index=True)
    phone        = Column(String, unique=True, index=True, nullable=False)
    full_name    = Column(String, nullable=True)
    role         = Column(String, nullable=False, default="customer")
    number_plate = Column(String, nullable=True)
    national_id_number = Column(String, nullable=True)
    fcm_token    = Column(Text, nullable=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())


# ── Mechanics ─────────────────────────────────────────────────────────────────

class Mechanic(Base):
    __tablename__ = "mechanics"

    id            = Column(Integer, primary_key=True, index=True)
    full_name     = Column(String, nullable=False)
    phone         = Column(String, unique=True, index=True, nullable=False)
    location      = Column(String, nullable=True)
    latitude      = Column(Float, nullable=True)
    longitude     = Column(Float, nullable=True)
    specialty     = Column(String, nullable=True)
    provider_type = Column(String, nullable=False, default="mechanic")  # mechanic | towing_provider
    rating        = Column(Float, nullable=False, default=0.0)
    total_ratings = Column(Integer, nullable=False, default=0)
    is_available  = Column(Boolean, nullable=False, default=True)
    vehicle_type  = Column(String, nullable=False, default="boda")
    password_hash = Column(String, nullable=True)
    is_verified   = Column(Boolean, nullable=False, default=False)
    jobs_completed = Column(Integer, nullable=False, default=0)


# ── Towing Providers ──────────────────────────────────────────────────────────

class TowingProvider(Base):
    __tablename__ = "towing_providers"

    id               = Column(Integer, primary_key=True, index=True)
    full_name        = Column(String, nullable=False)
    phone            = Column(String, unique=True, index=True, nullable=False)
    location         = Column(String, nullable=True)
    latitude         = Column(Float, nullable=True)
    longitude        = Column(Float, nullable=True)
    vehicle_capacity = Column(Integer, nullable=True)
    rating           = Column(Float, nullable=False, default=0.0)
    total_ratings    = Column(Integer, nullable=False, default=0)
    is_available     = Column(Boolean, nullable=False, default=True)
    password_hash    = Column(String, nullable=True)
    is_verified      = Column(Boolean, nullable=False, default=False)
    jobs_completed   = Column(Integer, nullable=False, default=0)


# ── Admins ────────────────────────────────────────────────────────────────────

class Admin(Base):
    __tablename__ = "admins"

    id            = Column(Integer, primary_key=True, index=True)
    full_name     = Column(String, nullable=False)
    email         = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role          = Column(String, nullable=False, default="admin")
    created_at    = Column(DateTime(timezone=True), server_default=func.now())


# ── System Logs ───────────────────────────────────────────────────────────────

class SystemLog(Base):
    __tablename__ = "system_logs"

    id          = Column(Integer, primary_key=True, index=True)
    event_type  = Column(String(100), nullable=False)
    user_id     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    mechanic_id = Column(Integer, ForeignKey("mechanics.id", ondelete="SET NULL"), nullable=True)
    request_id  = Column(Integer, nullable=True)   # cross-service ref — no FK
    description = Column(Text, nullable=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())


# ── OTP Store ─────────────────────────────────────────────────────────────────

class OTPStore(Base):
    __tablename__ = "otp_store"

    id         = Column(Integer, primary_key=True, index=True)
    phone      = Column(String, index=True, nullable=False)
    otp_code   = Column(String(6), nullable=False)
    attempts   = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)


# ── Token Blacklist ───────────────────────────────────────────────────────────

class TokenBlacklist(Base):
    __tablename__ = "token_blacklist"

    id         = Column(Integer, primary_key=True, index=True)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
