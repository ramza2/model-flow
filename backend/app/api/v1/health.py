from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.common import friendly
from app.core.config import settings
from app.db.session import get_db

router = APIRouter(tags=["health"])


@router.get("/health")
def health():
    return {"status": "ok", "service": "backend", "version": settings.app_version}


@router.get("/ready")
def ready(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise friendly(
            503,
            "Database readiness check failed.",
            "Retry after the database recovers.",
        ) from exc
    return {"status": "ready", "database": "ok"}
