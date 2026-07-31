from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.auth import bootstrap_admin
from app.api.v1.router import router as v1_router
from app.core.config import settings, validate_security_settings
from app.services import storage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s level=%(levelname)s logger=%(name)s message=%(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_security_settings()
    logger.info(
        "startup_begin version=%s git_sha=%s", settings.app_version, settings.git_sha
    )
    storage.ensure_buckets()
    bootstrap_admin()
    logger.info("startup_complete")
    yield
    logger.info("shutdown_complete")


app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_rate_windows: dict[str, deque[float]] = defaultdict(deque)
_rate_lock = threading.Lock()


@app.middleware("http")
async def api_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    request.state.request_id = request_id
    client = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not client:
        client = request.client.host if request.client else "unknown"
    if request.url.path.startswith("/api/v1") and request.url.path not in {
        "/api/v1/health",
        "/api/v1/ready",
    }:
        now = time.monotonic()
        key = client
        with _rate_lock:
            window = _rate_windows[key]
            while window and now - window[0] >= 60:
                window.popleft()
            if len(window) >= settings.rate_limit_per_minute:
                response = JSONResponse(
                    status_code=429,
                    content={
                        "detail": "Rate limit exceeded.",
                        "hint": "Wait before retrying this request.",
                    },
                )
                response.headers["Retry-After"] = "60"
                response.headers["X-Request-ID"] = request_id
                return response
            window.append(now)
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    logger.info(
        "request method=%s path=%s status=%s duration_ms=%.2f request_id=%s",
        request.method,
        request.url.path,
        response.status_code,
        (time.perf_counter() - started) * 1000,
        request_id,
    )
    return response


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    if not request.url.path.startswith("/api/v1"):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=exc.headers,
        )
    if isinstance(exc.detail, dict):
        content = {
            "detail": str(exc.detail.get("detail", "Request failed.")),
            "hint": exc.detail.get("hint"),
        }
    else:
        content = {"detail": str(exc.detail), "hint": None}
    return JSONResponse(
        status_code=exc.status_code, content=content, headers=exc.headers
    )


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    errors = exc.errors()
    first = errors[0] if errors else {}
    location = ".".join(str(value) for value in first.get("loc", []) if value != "body")
    message = first.get("msg", "Invalid request.")
    detail = f"{location}: {message}" if location else str(message)
    return JSONResponse(
        status_code=422,
        content={"detail": detail, "hint": "Correct the request and try again."},
    )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    logger.exception(
        "unhandled_exception path=%s request_id=%s",
        request.url.path,
        getattr(request.state, "request_id", None),
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Something went wrong while processing your request.",
            "hint": "Retry the request or contact an administrator with the request ID.",
        },
    )


app.include_router(v1_router, prefix="/api/v1")


@app.get("/api/health", include_in_schema=False)
def compose_health():
    return {"status": "ok", "service": "backend", "version": settings.app_version}


@app.get("/")
def root():
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "docs": "/docs",
        "api": "/api/v1",
    }
