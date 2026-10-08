"""Scheduler/maintenance leadership helpers (non-Postgres unit path)."""

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.workers import leadership


def test_sqlite_leadership_is_local_only_not_distributed():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    with engine.connect() as conn:
        db = Session(bind=conn)
        assert leadership.dialect_supports_advisory_lock(db) is False
        assert leadership.try_acquire_scheduler_leadership(db) is True
        leadership.release_scheduler_leadership(db)
        db.close()
