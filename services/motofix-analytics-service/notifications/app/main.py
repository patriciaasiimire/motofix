# notifications/app/main.py — Notifications & Alerts Service (entry point)
#
# A small standalone service that sends alerts out to people: SMS and WhatsApp (via
# Africa's Talking) and push notifications (via Firebase/FCM) to the mobile apps.
# Other services call its endpoints (e.g. "new job available") to reach mechanics
# and customers. The actual sending logic lives in routers/notifications.py.

from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
load_dotenv()
from .routers import notifications

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    # Pre-warm the DB pool and create notifications table on startup
    from .routers.notifications import get_db_pool
    await get_db_pool()
    yield

app = FastAPI(
    title="MOTOFIX - Notifications and Alerts Service",
    description="SMS + WhatsApp + FCM push alerts for mechanics and customers",
    version="2.0.0",
    lifespan=lifespan,
)

# ────────────────────────────── CORS ──────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://driver.motofix.org",
        "https://provider.motofix.org",
        "https://control.motofix.org",
        "https://customer.motofix.org",
        "https://admin.motofix.org",
        "https://motofix-driver-assist.onrender.com",
        "https://motofixug.onrender.com",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8080",
        "http://localhost:8081",
        "http://localhost:8082",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8081",
        "http://127.0.0.1:8082",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(notifications.router)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "motofix-notifications",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }