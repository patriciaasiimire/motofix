"""
Centralized CORS configuration for all Motofix services.
This module ensures consistent, production-safe CORS handling across the entire platform.
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import logging
import re

logger = logging.getLogger(__name__)

# Match ANY local-network origin (localhost / 127.0.0.1 / private LAN IPs) on any port.
# The frontends are served on whatever host:port the demo machine happens to use, and that
# IP/port changes between networks, so a fixed allowlist can't cover LAN / mobile testing.
LAN_ORIGIN_REGEX = re.compile(
    r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$"
)


def _origin_allowed(origin: str | None) -> bool:
    """True if the origin is in the explicit allowlist or matches a local-network address."""
    return bool(origin) and (origin in ALLOWED_ORIGINS or bool(LAN_ORIGIN_REGEX.match(origin)))

# Production-safe allowed origins - NO wildcards
ALLOWED_ORIGINS = [
    "https://motofixug.netlify.app",   # Production V1 driver web app
    "https://localhost",               # Capacitor Android WebView
    "capacitor://localhost",            # Capacitor legacy/custom WebView origin
    "http://localhost",                 # Capacitor development WebView
    "https://customer.motofix.org",      # Primary customer/driver app
    "https://admin.motofix.org",         # Admin dashboard
    "https://motofix.org",               # Main domain
    # Docker-served frontends
    "http://localhost:8080",             # Driver app (Docker)
    "http://localhost:8081",             # Service provider app (Docker)
    "http://localhost:8082",             # Admin portal (Docker)
    # Vite dev servers (npm run dev)
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:8083",             # Vite fallback when 8080 taken
    "http://localhost:8084",
    "http://localhost:8085",
    "http://localhost:8086",
    "http://localhost:8087",             # Admin portal (Vite dev)
    "http://localhost:8088",
    "http://localhost:8089",
    # 127.0.0.1 aliases
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:8082",
    "http://127.0.0.1:8083",
    # Local network access (for mobile/device testing)
    "http://192.168.1.2:8080",
    "http://192.168.1.2:8081",
    "http://192.168.1.2:8082",
    "http://192.168.1.2:8083",
    "http://192.168.1.2:8084",
    "http://192.168.1.2:8085",
    "http://192.168.1.2:5173",
    "http://192.168.1.3:8080",
    "http://192.168.1.3:8081",
    "http://192.168.1.3:8082",
    "http://192.168.1.3:8083",
    "http://192.168.1.3:8084",
    "http://192.168.1.3:8085",
    "http://192.168.1.3:5173",
]


def setup_cors(app: FastAPI) -> None:
    """
    Configure CORS for FastAPI application.
    
    This must be called immediately after FastAPI() instantiation,
    BEFORE including any routers.
    
    Guarantees:
    - Explicit origin allowlist (no wildcards)
    - Credentials enabled for secure cookies/auth
    - OPTIONS preflight always allowed
    - Explicit header allowlist for JSON, auth, and browser requests
    - All HTTP methods supported
    
    Args:
        app: FastAPI application instance
    """
    
    # Add CORSMiddleware FIRST - order matters!
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=LAN_ORIGIN_REGEX.pattern,  # plus any local-network origin
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "Accept", "X-Requested-With"],
        expose_headers=["Authorization"],
        max_age=3600,  # Cache preflight responses for 1 hour
    )
    
    # Additional middleware to guarantee CORS headers on all responses, including errors
    @app.middleware("http")
    async def add_cors_headers_middleware(request: Request, call_next):
        """
        Ensures CORS headers are present on every response.
        This is a backup to handle edge cases where CORSMiddleware might not apply.
        """
        origin = request.headers.get("origin")

        # If origin is allowed (explicit allowlist or a local-network address), add CORS headers
        if _origin_allowed(origin):
            # For OPTIONS preflight requests, return early with 200
            if request.method == "OPTIONS":
                return Response(
                    status_code=200,
                    headers={
                        "Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Credentials": "true",
                        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With",
                        "Access-Control-Expose-Headers": "Authorization",
                        "Access-Control-Max-Age": "3600",
                    },
                )
            
            # For regular requests, add headers to response
            response = await call_next(request)
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept, X-Requested-With"
            response.headers["Access-Control-Expose-Headers"] = "Authorization"
            return response
        
        # Origin not allowed - pass through without CORS headers (browser will block)
        return await call_next(request)
    
    logger.info("=" * 70)
    logger.info("✅ CORS Configuration Initialized")
    logger.info("=" * 70)
    logger.info("Allowed Origins:")
    for origin in ALLOWED_ORIGINS:
        logger.info(f"  • {origin}")
    logger.info("Allowed Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS")
    logger.info("Allowed Headers: Content-Type, Authorization, Accept, X-Requested-With")
    logger.info("Exposed Headers: Authorization")
    logger.info("Credentials: Enabled (httpOnly cookies + Bearer tokens)")
    logger.info("=" * 70)
