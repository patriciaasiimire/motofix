"""
Centralized CORS configuration for all Motofix services.
This module ensures consistent, production-safe CORS handling across the entire platform.
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import logging

logger = logging.getLogger(__name__)

# Production-safe allowed origins - NO wildcards
ALLOWED_ORIGINS = [
    "https://driver.motofix.org",
    "https://provider.motofix.org",
    "https://control.motofix.org",
    "https://customer.motofix.org",      # Primary customer/driver app
    "https://admin.motofix.org",         # Admin dashboard
    "https://motofix.org",               # Main domain
    "http://localhost:3000",             # Local development
    "http://localhost:5173",             # Vite dev server
    "http://127.0.0.1:3000",             # Localhost alias
    "http://127.0.0.1:5173",             # Localhost alias
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
    - Explicit header allowlist (Content-Type, Authorization)
    - All HTTP methods supported
    
    Args:
        app: FastAPI application instance
    """
    
    # Add CORSMiddleware FIRST - order matters!
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
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
        
        # If origin is allowed, add CORS headers
        if origin in ALLOWED_ORIGINS:
            # For OPTIONS preflight requests, return early with 200
            if request.method == "OPTIONS":
                return Response(
                    status_code=200,
                    headers={
                        "Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Credentials": "true",
                        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                        "Access-Control-Max-Age": "3600",
                    },
                )
            
            # For regular requests, add headers to response
            response = await call_next(request)
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
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
    logger.info("Allowed Headers: Content-Type, Authorization")
    logger.info("Credentials: Enabled (httpOnly cookies + Bearer tokens)")
    logger.info("=" * 70)
