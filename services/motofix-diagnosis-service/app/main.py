# main.py — Fault Diagnosis Service (the web/API layer)
#
# This file exposes the AI features over HTTP. The real AI work lives in diagnosis.py;
# here we just receive requests, check the login token where needed, call the right
# diagnosis.py function, and return the result.
#
# What each endpoint is for:
#   /diagnose          — describe a fault in text → structured diagnosis
#   /diagnose/image    — upload a photo of the fault → diagnosis (+ repair-vs-replace)
#   /diagnose/guided   — step-by-step Q&A for drivers who don't know what's wrong
#   /chat , /chat/image— the MOTOBOT chat assistant (text and photo turns)
#   /transcribe        — turn a voice note into text
#   /parts-price       — price a list of spare parts the driver wants
#   /fuel-advisor      — check a fuel type is safe for a given car
#   /fuel-advisor/stations , /parts-dealers — find real nearby fuel stations / parts shops (OpenStreetMap)
#   /greetings , /service-estimate — small AI helpers for the apps' home/completion screens
#
# NOTE: many AI endpoints have a "fallback" so the feature still works (with a safe
# default) even when the AI provider is unavailable.

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from groq import AsyncGroq
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt

load_dotenv()

import httpx
from math import radians, cos, sin, asin, sqrt
from pydantic import BaseModel
from .diagnosis import chat_diagnose, chat_with_image, diagnose_image, diagnose_text, fuel_advisor, guided_diagnose, price_spare_parts, transcribe_audio, generate_greetings, fallback_greetings, service_estimate, fallback_service_estimate
from .schemas import (
    ChatMessage, ChatRequest, ChatResponse, DiagnosisResult, TextDiagnosisRequest,
    FuelAdvisorRequest, NearbyStationsRequest, GuidedDiagnoseRequest,
    PartPriceRequest, PartPriceResponse,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

groq_client: Optional[AsyncGroq] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global groq_client
    if not SECRET_KEY:
        logger.critical("Missing required SECRET_KEY environment variable for diagnosis-service")
        raise RuntimeError("SECRET_KEY is required for diagnosis-service; set it in the environment before startup.")
    if GROQ_API_KEY:
        groq_client = AsyncGroq(api_key=GROQ_API_KEY)
        logger.info("Fault diagnosis service: Groq client ready (chat / guided / parts / fuel)")
    else:
        logger.warning("GROQ_API_KEY not set — /chat & guided triage will return fallback responses")

    if ANTHROPIC_API_KEY:
        logger.info("Fault diagnosis: Claude (Haiku 4.5) ready for text + image diagnosis")
    else:
        logger.warning("ANTHROPIC_API_KEY not set — /diagnose & /diagnose/image will return fallback responses")

    yield
    logger.info("Fault diagnosis service: shutdown")


app = FastAPI(
    title="MOTOFIX - Fault Diagnosis and Classification Service",
    description=(
        "Classifies driver fault descriptions and uploaded images using NLP and computer vision "
        "via the OpenAI and Google Vision APIs. Powers the AI diagnostic chatbot that guides "
        "drivers through describing their fault before a request is submitted, and determines "
        "the appropriate provider type: mechanic, towing provider, or spare parts dealer."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
_ALLOWED_ORIGINS = [
    "https://customer.motofix.org",
    "https://admin.motofix.org",
    "https://motofix.org",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:8083",
    "http://localhost:8084",
    "http://localhost:8084",
    "http://localhost:8085",
    "http://localhost:8086",
    "http://localhost:8087",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8083",
    "http://127.0.0.1:8084",
    "http://192.168.1.3:8080",
    "http://192.168.1.3:5173",
    "http://192.168.1.3:3000",
    "http://192.168.1.3:8083",
    "http://192.168.1.3:8084",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    # Also allow ANY local-network origin (localhost / 127.0.0.1 / private LAN IPs) on any
    # port. The apps are served on whatever host:port the demo machine happens to use (e.g.
    # http://192.168.1.3:8088), and that IP/port changes between networks — without this,
    # cross-origin calls like the completion-card /service-estimate get CORS-blocked and the
    # AI fix options silently fail to load.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    max_age=3600,
)


# ── Auth ──────────────────────────────────────────────────────────────────────

def _require_token(authorization: str = Header(...)) -> dict:
    try:
        scheme, token = authorization.split(" ", 1)
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid authentication scheme")
    except ValueError:
        raise HTTPException(status_code=401, detail="Malformed Authorization header")
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health():
    return {
        "status": "ok",
        "service": "fault-diagnosis",
        "jwt_secret_configured": bool(os.getenv("SECRET_KEY")),
        "groq_configured": groq_client is not None,
        "claude_configured": bool(ANTHROPIC_API_KEY),
    }


@app.get("/greetings", tags=["greetings"])
async def greetings(role: str = "driver", period: str = "evening"):
    """Rotating, AI-written home-screen headlines for the driver/mechanic apps.
    Public + always succeeds: falls back to a built-in pool when Groq is off or fails,
    so the home screen always has fresh copy."""
    role = "mechanic" if str(role).lower().startswith("mech") else "driver"
    period = str(period).lower()
    if period not in ("latenight", "earlymorning", "morning", "afternoon", "evening"):
        period = "evening"
    if not groq_client:
        return {"messages": fallback_greetings(role, period), "source": "fallback"}
    try:
        return {"messages": await generate_greetings(role, period, groq_client), "source": "ai"}
    except Exception as e:  # pragma: no cover - best effort, never break the home screen
        logger.warning("greetings generation failed: %s", e)
        return {"messages": fallback_greetings(role, period), "source": "fallback"}


class ServiceEstimateRequest(BaseModel):
    issue_type: Optional[str] = None
    description: Optional[str] = None
    distance_km: Optional[float] = None


@app.post("/service-estimate", tags=["estimate"])
async def service_estimate_endpoint(body: ServiceEstimateRequest):
    """For a just-finished job: a tickable list of likely fixes + an AI cost breakdown
    (boda transport + labour + parts). Public + always succeeds (fallback on AI failure)."""
    issue = body.issue_type or ""
    desc = body.description or ""
    dist = float(body.distance_km or 3.0)
    if not groq_client:
        return fallback_service_estimate(issue, dist)
    try:
        return await service_estimate(issue, desc, dist, groq_client)
    except Exception as e:  # pragma: no cover - never block job completion
        logger.warning("service-estimate failed: %s", e)
        return fallback_service_estimate(issue, dist)


@app.post("/diagnose", response_model=DiagnosisResult, tags=["diagnosis"])
async def diagnose(
    body: TextDiagnosisRequest,
    _user: dict = Depends(_require_token),
):
    """
    Classify a plain-text fault description.

    Returns a structured diagnosis including fault category, recommended provider
    type (mechanic / towing provider / spare parts dealer), severity, and
    immediate actions the driver should take.
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="Claude API key not configured on this server")
    return await diagnose_text(body.description)


@app.post("/diagnose/guided", tags=["diagnosis"])
async def diagnose_guided(body: GuidedDiagnoseRequest):
    """
    Step-by-step guided triage for drivers who don't know what's wrong.

    Send the questions asked and answers given so far. Returns either the next
    question (with quick-pick options) or, once enough is known, a final diagnosis.
    """
    if not groq_client:
        raise HTTPException(status_code=503, detail="AI service not configured")
    try:
        answers = [a.model_dump() for a in body.answers]
        return await guided_diagnose(answers, groq_client)
    except json.JSONDecodeError as exc:
        logger.error("Guided diagnose — AI returned invalid JSON: %s", exc)
        raise HTTPException(status_code=500, detail="AI returned an unreadable response. Please try again.")
    except Exception as exc:
        logger.error("Guided diagnose error: %s", exc)
        raise HTTPException(status_code=500, detail="AI diagnosis failed. Please try again.")


@app.post("/diagnose/image", response_model=DiagnosisResult, tags=["diagnosis"])
async def diagnose_image_endpoint(
    file: UploadFile = File(..., description="JPEG or PNG image of the vehicle fault"),
    issue: str | None = Form(None),
    _user: dict = Depends(_require_token),
):
    """
    Classify a fault from an uploaded vehicle image using Claude (Haiku 4.5) vision.

    Claude reads the photo, checks it's relevant to the reported issue, and returns a
    structured diagnosis (incl. repair-vs-replace estimate) in one multimodal call.
    Accepts JPEG/PNG/GIF/WebP images up to 10 MB.
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="Claude API key not configured on this server")

    content_type = file.content_type or "image/jpeg"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Only image files are supported")

    image_bytes = await file.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large — maximum size is 10 MB")

    return await diagnose_image(image_bytes, content_type, issue=issue)


@app.post("/chat/image", response_model=ChatResponse, tags=["chatbot"])
async def chat_image(
    file: UploadFile = File(...),
    messages: str = Form(default="[]"),
    user_text: str = Form(default=""),
    persona: str = Form(default="driver"),
    _user: dict = Depends(_require_token),
):
    """
    Image-aware chat turn. Claude (Haiku 4.5) reads the uploaded photo, describes
    what it sees and asks follow-up questions. Returns a ChatResponse so it slots
    into the same chat flow as /chat.
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="Claude API key not configured on this server")

    content_type = file.content_type or "image/jpeg"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Only image files are supported")

    image_bytes = await file.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large — maximum size is 10 MB")

    try:
        prior = [ChatMessage(**m) for m in json.loads(messages)]
    except Exception:
        prior = []

    return await chat_with_image(image_bytes, content_type, prior, user_text.strip(), persona=persona or "driver")


@app.post("/chat", response_model=ChatResponse, tags=["chatbot"])
async def chat(
    body: ChatRequest,
    _user: dict = Depends(_require_token),
):
    """
    One turn of the interactive AI diagnostic chatbot.

    The client sends the full conversation history (all previous messages plus
    the driver's latest message). The service returns the assistant's reply and,
    once enough information has been gathered, sets diagnosis_ready=true and
    includes the final DiagnosisResult.

    The client is responsible for storing conversation history between turns.
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="Claude API key not configured on this server")
    return await chat_diagnose(body.messages, persona=body.persona or "driver")


@app.post("/transcribe", tags=["chatbot"])
async def transcribe_endpoint(
    file: UploadFile = File(..., description="Audio voice note (webm/ogg/mp3/m4a/wav)"),
    _user: dict = Depends(_require_token),
):
    """Transcribe a driver's voice note to English text via Groq Whisper."""
    if not groq_client:
        raise HTTPException(status_code=503, detail="Transcription not configured on this server")
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")
    if len(audio_bytes) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio too large — maximum size is 25 MB")
    text = await transcribe_audio(audio_bytes, file.filename or "voice.webm", groq_client)
    return {"text": text}


# ── MOTOBOT — spare-parts pricing ──────────────────────────────────────────────

@app.post("/parts-price", response_model=PartPriceResponse, tags=["spare-parts"])
async def spare_parts_price(
    body: PartPriceRequest,
    _user: dict = Depends(_require_token),
):
    """MOTOBOT: return UGX price ranges for the spare parts a driver wants to buy."""
    if not groq_client:
        raise HTTPException(status_code=503, detail="AI service not configured")
    items = [i for i in body.items if i and i.strip()]
    if not items:
        raise HTTPException(status_code=422, detail="No items provided")
    try:
        return await price_spare_parts(items, groq_client)
    except json.JSONDecodeError as exc:
        logger.error("MOTOBOT pricing — invalid JSON: %s", exc)
        raise HTTPException(status_code=500, detail="AI returned an unreadable response. Please try again.")
    except Exception as exc:
        logger.error("MOTOBOT pricing failed: %s", exc)
        raise HTTPException(status_code=500, detail="Pricing failed. Please try again.")


# ── Fuel Advisor ──────────────────────────────────────────────────────────────

@app.post("/fuel-advisor", tags=["fuel"])
async def fuel_advisor_endpoint(
    body: FuelAdvisorRequest,
):
    """AI fuel-engine compatibility check + Uganda pump price estimates."""
    if not groq_client:
        raise HTTPException(status_code=503, detail="AI service not configured")
    try:
        result = await fuel_advisor(body.car_model, body.fuel_type, groq_client)
        return result
    except json.JSONDecodeError as exc:
        logger.error("Fuel advisor — AI returned invalid JSON: %s", exc)
        raise HTTPException(status_code=500, detail="AI returned an unreadable response. Please try again.")
    except Exception as exc:
        logger.error("Fuel advisor error: %s", exc)
        raise HTTPException(status_code=500, detail="AI analysis failed. Please try again.")


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    # Straight-line distance in km between two map points, used to sort the nearest
    # fuel stations / parts shops. (Same standard "haversine" formula as elsewhere.)
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return R * 2 * asin(sqrt(a))


# Public Overpass (OpenStreetMap) mirrors — free, no API key, no billing.
_OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# Some mirrors reject requests without a descriptive User-Agent (HTTP 406).
_OVERPASS_HEADERS = {"User-Agent": "MOTOFIX-RoadsideAssistance/1.0 (fuel-finder)"}

# Bundled real OpenStreetMap snapshot of Ugandan fuel stations — used when the
# live Overpass API is slow/unreachable so the demo still shows REAL stations.
_BUNDLED_STATIONS: list = []
try:
    _bundle_path = os.path.join(os.path.dirname(__file__), "ug_fuel_stations.json")
    with open(_bundle_path, encoding="utf-8") as _bf:
        _BUNDLED_STATIONS = json.load(_bf)
    logger.info("Loaded %d bundled OSM fuel stations", len(_BUNDLED_STATIONS))
except Exception as _exc:  # pragma: no cover
    logger.warning("Could not load bundled fuel stations: %s", _exc)


def _mk_station(body, oid, name, brand, vicinity, lat2, lng2, opening_hours):
    dist = _haversine_km(body.lat, body.lng, lat2, lng2)
    return {
        "place_id": oid,
        "name": name,
        "brand": brand or "",
        "vicinity": vicinity or "Uganda",
        "lat": lat2,
        "lng": lng2,
        "rating": None,
        "user_ratings_total": None,
        "open_now": True if opening_hours == "24/7" else None,
        "opening_hours": opening_hours or None,
        "distance_km": round(dist, 2),
        "maps_url": f"https://www.google.com/maps/search/?api=1&query={lat2},{lng2}",
        "directions_url": (
            f"https://www.google.com/maps/dir/?api=1"
            f"&origin={body.lat},{body.lng}"
            f"&destination={lat2},{lng2}"
            f"&travelmode=driving"
        ),
    }


async def _overpass_fuel(lat: float, lng: float, radius_m: int) -> list:
    """Query OpenStreetMap for amenity=fuel within radius_m metres of (lat,lng)."""
    query = (
        "[out:json][timeout:15];"
        "("
        f'node["amenity"="fuel"](around:{radius_m},{lat},{lng});'
        f'way["amenity"="fuel"](around:{radius_m},{lat},{lng});'
        ");"
        "out center tags;"
    )
    async with httpx.AsyncClient(timeout=5, headers=_OVERPASS_HEADERS) as client:
        for url in _OVERPASS_URLS:
            try:
                resp = await client.post(url, data={"data": query})
                if resp.status_code == 200:
                    return resp.json().get("elements", [])
                logger.warning("Overpass %s -> %s", url, resp.status_code)
            except Exception as exc:
                logger.warning("Overpass %s failed: %s", url, exc)
    return []


def _build_from_elements(body, elements: list) -> list:
    named = [e for e in elements if (e.get("tags") or {}).get("name") or (e.get("tags") or {}).get("brand")]
    elements = named or elements
    stations = []
    seen = set()
    for el in elements:
        tags = el.get("tags") or {}
        if el.get("type") == "node":
            lat2, lng2 = el.get("lat"), el.get("lon")
        else:
            center = el.get("center") or {}
            lat2, lng2 = center.get("lat"), center.get("lon")
        if lat2 is None or lng2 is None:
            continue
        oid = f"{el.get('type')}/{el.get('id')}"
        if oid in seen:
            continue
        seen.add(oid)
        name = tags.get("name") or tags.get("brand") or tags.get("operator") or "Fuel Station"
        brand = tags.get("brand") or tags.get("operator") or ""
        addr_parts = [
            tags.get("addr:street"),
            tags.get("addr:suburb") or tags.get("addr:city") or tags.get("addr:place"),
        ]
        vicinity = ", ".join([p for p in addr_parts if p]) or tags.get("addr:full") or "Uganda"
        stations.append(_mk_station(body, oid, name, brand, vicinity, lat2, lng2, tags.get("opening_hours")))
    return stations


def _build_bundled_near(body) -> list:
    if not _BUNDLED_STATIONS:
        return []
    scored = [(_haversine_km(body.lat, body.lng, r["lat"], r["lng"]), r) for r in _BUNDLED_STATIONS]
    near = [x for x in scored if x[0] <= 30]
    near = near or sorted(scored, key=lambda x: x[0])[:12]
    return [
        _mk_station(body, rec["id"], rec["name"], rec.get("brand", ""),
                    rec.get("vicinity", "") or "Uganda", rec["lat"], rec["lng"], rec.get("opening_hours"))
        for _d, rec in near
    ]


@app.post("/fuel-advisor/stations", tags=["fuel"])
async def nearby_stations_endpoint(
    body: NearbyStationsRequest,
):
    """Real nearby fuel stations from OpenStreetMap.

    Tries the live Overpass API (tightly time-boxed so the request stays snappy);
    if it is slow / unreachable we serve the bundled real OSM snapshot. Either
    way the results are real stations — never empty, never a long hang.
    """
    elements: list = []
    try:
        elements = await asyncio.wait_for(_overpass_fuel(body.lat, body.lng, 15000), timeout=4)
    except asyncio.TimeoutError:
        logger.info("Overpass slow — falling back to bundled OSM snapshot")

    live = _build_from_elements(body, elements)
    # Prefer live when it returned a healthy set; otherwise the comprehensive snapshot.
    stations = live if len(live) >= 4 else (_build_bundled_near(body) or live)

    stations.sort(key=lambda s: s["distance_km"])
    return {"stations": stations[:12]}


# ── MOTOBOT — nearby spare-parts dealers (real OSM + Makerere fallback) ─────────

# Real spare-parts businesses in & around Makerere / central Kampala, with the
# shop photos the user supplied. Returned for the demo region (see endpoint).
_MAKERERE_DEALERS = [
    {"name": "Mandela Auto Spares Ltd",          "lat": 0.3128, "lng": 32.5738, "vicinity": "Ben Kiwanuka Street, Kampala", "category": "car_parts",  "phone": "+256 414 235090", "rating": 4.9, "reviews": 10, "hours": "8:00 AM – 5:00 PM (Mon–Sat)", "photo": "mandela.jpg"},
    {"name": "Genuine Auto Spare Parts Uganda",  "lat": 0.3452, "lng": 32.5575, "vicinity": "Kawaala Road, Kampala",        "category": "car_parts",  "phone": "+256 777 688404", "rating": 3.0, "reviews": 1,  "hours": "8:00 AM – 6:00 PM (Mon–Sat)", "photo": "genuine.jpg"},
    {"name": "JES Autos — Europe Spare Parts",   "lat": 0.3092, "lng": 32.5648, "vicinity": "Namirembe Road, Kampala",      "category": "car_parts",  "phone": "+256 751 118156", "rating": 4.3, "reviews": 18, "hours": "8:00 AM – 7:00 PM (Mon–Sat)", "photo": "jes.jpg"},
    {"name": "Auto Spare Parts — Kiseka Market", "lat": 0.3105, "lng": 32.5715, "vicinity": "Nakivubo Road, Kiseka Market", "category": "car_parts",  "phone": None,              "rating": 3.7, "reviews": 7,  "hours": "8:00 AM – 6:00 PM (Mon–Sat)", "photo": "kiseka.jpg"},
    {"name": "zmk mart Auto Parts",              "lat": 0.3558, "lng": 32.5402, "vicinity": "Nabunya Road, Nansana",        "category": "car_parts",  "phone": "+256 772 502838", "rating": 4.3, "reviews": 7,  "hours": "Open 24 hours",               "photo": "zmk.jpg"},
    {"name": "MK Auto Spare Parts",              "lat": 0.3170, "lng": 32.5820, "vicinity": "Kampala",                      "category": "car_repair", "phone": None,              "rating": 4.2, "reviews": 15, "hours": "8:00 AM – 7:00 PM (Mon–Sat)", "photo": "mk.jpg"},
    {"name": "Shan Auto Parts Ltd",              "lat": 0.3140, "lng": 32.5760, "vicinity": "Kampala (8HW7+P4W)",           "category": "car_parts",  "phone": None,              "rating": 5.0, "reviews": 1,  "hours": "8:00 AM – 6:00 PM (Mon–Sat)", "photo": None},
    {"name": "Simple J Auto Spare Parts",        "lat": 0.3385, "lng": 32.5765, "vicinity": "Mulago, Kampala",              "category": "car_parts",  "phone": None,              "rating": 4.1, "reviews": 12, "hours": "8:00 AM – 6:00 PM (Mon–Sat)", "photo": None},
]

_SHOP_TO_CAT = {"car_parts": "car_parts", "car_repair": "car_repair", "tyres": "tyres", "motorcycle_repair": "motorcycle_repair"}
_CAT_DEFAULT_NAME = {
    "car_parts": "Auto Spare Parts", "car_repair": "Car Repair Garage",
    "tyres": "Tyre & Battery Shop", "motorcycle_repair": "Boda Mechanics",
}


async def _overpass_dealers(lat: float, lng: float, radius_m: int) -> list:
    """Query OpenStreetMap for car-parts / repair / tyre shops near (lat,lng)."""
    query = (
        "[out:json][timeout:15];"
        "("
        f'node["shop"="car_parts"](around:{radius_m},{lat},{lng});'
        f'way["shop"="car_parts"](around:{radius_m},{lat},{lng});'
        f'node["shop"="car_repair"](around:{radius_m},{lat},{lng});'
        f'way["shop"="car_repair"](around:{radius_m},{lat},{lng});'
        f'node["shop"="tyres"](around:{radius_m},{lat},{lng});'
        f'node["shop"="motorcycle_repair"](around:{radius_m},{lat},{lng});'
        ");"
        "out center tags;"
    )
    async with httpx.AsyncClient(timeout=5, headers=_OVERPASS_HEADERS) as client:
        for url in _OVERPASS_URLS:
            try:
                resp = await client.post(url, data={"data": query})
                if resp.status_code == 200:
                    return resp.json().get("elements", [])
            except Exception as exc:
                logger.warning("Overpass dealers %s failed: %s", url, exc)
    return []


def _build_dealers(lat: float, lng: float, elements: list) -> list:
    out, seen = [], set()
    for el in elements:
        tags = el.get("tags") or {}
        if el.get("type") == "node":
            la, lo = el.get("lat"), el.get("lon")
        else:
            c = el.get("center") or {}
            la, lo = c.get("lat"), c.get("lon")
        if la is None or lo is None:
            continue
        oid = f"{el.get('type')}/{el.get('id')}"
        if oid in seen:
            continue
        seen.add(oid)
        cat = _SHOP_TO_CAT.get(tags.get("shop") or "", "car_parts")
        name = tags.get("name") or tags.get("operator") or _CAT_DEFAULT_NAME.get(cat, "Auto Spares")
        addr = ", ".join([p for p in [tags.get("addr:street"), tags.get("addr:suburb") or tags.get("addr:city")] if p]) or "Kampala"
        out.append({
            "place_id": oid, "name": name, "vicinity": addr,
            "lat": la, "lng": lo,
            "distance_km": round(_haversine_km(lat, lng, la, lo), 2),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "category": cat,
            "rating": None, "reviews": None,
            "hours": tags.get("opening_hours"), "photo": None,
        })
    out.sort(key=lambda d: d["distance_km"])
    return out


def _makerere_fallback(lat: float, lng: float) -> list:
    res = [{
        "place_id": f"mak-{i}", "name": d["name"], "vicinity": d["vicinity"],
        "lat": d["lat"], "lng": d["lng"],
        "distance_km": round(_haversine_km(lat, lng, d["lat"], d["lng"]), 2),
        "phone": d.get("phone"), "category": d["category"],
        "rating": d.get("rating"), "reviews": d.get("reviews"),
        "hours": d.get("hours"), "photo": d.get("photo"),
    } for i, d in enumerate(_MAKERERE_DEALERS)]
    res.sort(key=lambda x: x["distance_km"])
    return res


@app.post("/parts-dealers", tags=["spare-parts"])
async def parts_dealers(
    body: NearbyStationsRequest,
    _user: dict = Depends(_require_token),
):
    """Real spare-parts/repair dealers near the driver (OpenStreetMap), with a
    Makerere-area fallback when OSM has nothing close (for the demo)."""
    # Demo region: when the driver is in/around Makerere, return the curated set
    # of real businesses (with real shop photos) rather than querying OSM.
    if _haversine_km(body.lat, body.lng, 0.3296, 32.5670) <= 10:
        return {"dealers": _makerere_fallback(body.lat, body.lng)[:8], "source": "makerere"}

    elements: list = []
    try:
        elements = await asyncio.wait_for(_overpass_dealers(body.lat, body.lng, 12000), timeout=4)
    except asyncio.TimeoutError:
        logger.info("Overpass dealers slow — using Makerere fallback")

    dealers = _build_dealers(body.lat, body.lng, elements)
    source = "osm"
    if len(dealers) < 3:
        dealers = _makerere_fallback(body.lat, body.lng)
        source = "fallback"
    return {"dealers": dealers[:8], "source": source}
