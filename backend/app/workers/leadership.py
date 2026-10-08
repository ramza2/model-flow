"""PostgreSQL advisory-lock coordination for scheduler/maintenance (Phase 8-B).

Only the worker that acquires the session-level advisory lock runs
``scheduler_tick``, stale-training recovery, and cancel-honor work. Other
replicas skip that section and continue normal job claims.

SQLite / non-PostgreSQL dialects return leadership locally without claiming a
distributed guarantee — PostgreSQL is authoritative for multi-replica safety.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Stable fixed int64 key — do not use Python hash().
# ASCII mnemonic: "MFLOW_S8" packed into a signed 64-bit integer.
SCHEDULER_MAINTENANCE_LOCK_KEY = 0x4D464C4F575F5338


def dialect_supports_advisory_lock(db: Session) -> bool:
    bind = db.get_bind()
    return str(getattr(getattr(bind, "dialect", None), "name", "")).lower() == (
        "postgresql"
    )


def try_acquire_scheduler_leadership(db: Session) -> bool:
    """Try to acquire the scheduler/maintenance leadership lock.

    Returns True when this session should run leader work. Lock acquisition
    failure is not an error — the caller continues job claiming.
    """

    if not dialect_supports_advisory_lock(db):
        return True
    try:
        acquired = db.execute(
            text("SELECT pg_try_advisory_lock(:key)"),
            {"key": SCHEDULER_MAINTENANCE_LOCK_KEY},
        ).scalar()
        return bool(acquired)
    except Exception:
        logger.exception("scheduler leadership acquire failed; skipping leader work")
        return False


def release_scheduler_leadership(db: Session) -> None:
    """Release the session-level advisory lock. Safe to call when not held."""

    if not dialect_supports_advisory_lock(db):
        return
    try:
        db.execute(
            text("SELECT pg_advisory_unlock(:key)"),
            {"key": SCHEDULER_MAINTENANCE_LOCK_KEY},
        )
    except Exception:
        logger.exception("scheduler leadership release failed")
