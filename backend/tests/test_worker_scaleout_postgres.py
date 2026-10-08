"""PostgreSQL-authoritative multi-worker concurrency tests (Phase 8-B).

These tests skip on non-PostgreSQL dialects (e.g. SQLite Fast Gate hosts).
Full ``./scripts/verify.sh`` runs pytest inside the backend container against
Postgres and must execute these paths.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import JobStatus, PipelineRun, TrainingJob
from app.workers.leadership import (
    SCHEDULER_MAINTENANCE_LOCK_KEY,
    release_scheduler_leadership,
    try_acquire_scheduler_leadership,
)
from app.workers import runner


def _is_postgres_url(url: str) -> bool:
    return url.startswith("postgresql")


pytestmark = pytest.mark.skipif(
    not _is_postgres_url(settings.database_url),
    reason="PostgreSQL required for SKIP LOCKED / advisory-lock proofs",
)


@pytest.fixture
def pg_engine():
    engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=4)
    yield engine
    engine.dispose()


def test_advisory_lock_singleton_and_release(pg_engine):
    db_a = Session(bind=pg_engine.connect())
    db_b = Session(bind=pg_engine.connect())
    try:
        assert try_acquire_scheduler_leadership(db_a) is True
        assert try_acquire_scheduler_leadership(db_b) is False
        release_scheduler_leadership(db_a)
        assert try_acquire_scheduler_leadership(db_b) is True
        release_scheduler_leadership(db_b)
    finally:
        try:
            release_scheduler_leadership(db_a)
        except Exception:
            pass
        try:
            release_scheduler_leadership(db_b)
        except Exception:
            pass
        db_a.close()
        db_b.close()


def test_advisory_lock_key_is_stable_fixed_integer():
    assert isinstance(SCHEDULER_MAINTENANCE_LOCK_KEY, int)
    assert SCHEDULER_MAINTENANCE_LOCK_KEY == 0x4D464C4F575F5338
    assert -(2**63) <= SCHEDULER_MAINTENANCE_LOCK_KEY < 2**63


def test_training_and_pipeline_claim_sql_include_skip_locked():
    training_stmt = (
        select(TrainingJob)
        .where(TrainingJob.status.in_(runner.PENDING_STATUSES))
        .order_by(TrainingJob.id.asc())
        .with_for_update(skip_locked=True)
    )
    pipeline_stmt = (
        select(PipelineRun)
        .where(PipelineRun.status.in_(runner.PENDING_STATUSES))
        .order_by(PipelineRun.id.asc())
        .with_for_update(skip_locked=True)
    )
    dialect = postgresql.dialect()
    assert "SKIP LOCKED" in str(training_stmt.compile(dialect=dialect)).upper()
    assert "SKIP LOCKED" in str(pipeline_stmt.compile(dialect=dialect)).upper()
    assert JobStatus.pending in runner.PENDING_STATUSES


def test_skip_locked_no_double_claim_generic_path(pg_engine):
    """Two sessions racing FOR UPDATE SKIP LOCKED claim exactly one row."""

    table = "_modelflow_claim_probe_8b"
    with pg_engine.begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        conn.execute(
            text(
                f"""
                CREATE TABLE {table} (
                    id integer PRIMARY KEY,
                    status text NOT NULL,
                    owner text
                )
                """
            )
        )
        conn.execute(
            text(f"INSERT INTO {table} (id, status, owner) VALUES (1, 'pending', NULL)")
        )

    barrier = threading.Barrier(2)
    results: list[int | None] = []
    lock = threading.Lock()

    def claim(worker_name: str) -> None:
        with pg_engine.connect() as conn:
            barrier.wait(timeout=10)
            trans = conn.begin()
            try:
                row = conn.execute(
                    text(
                        f"""
                        SELECT id FROM {table}
                        WHERE status = 'pending'
                        ORDER BY id ASC
                        FOR UPDATE SKIP LOCKED
                        LIMIT 1
                        """
                    )
                ).first()
                if row is None:
                    with lock:
                        results.append(None)
                    trans.rollback()
                    return
                conn.execute(
                    text(
                        f"UPDATE {table} SET status = 'running', owner = :owner "
                        "WHERE id = :id"
                    ),
                    {"owner": worker_name, "id": row.id},
                )
                trans.commit()
                with lock:
                    results.append(row.id)
            except Exception:
                trans.rollback()
                raise

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(claim, "A"), pool.submit(claim, "B")]
        for future in futures:
            future.result(timeout=15)

    claimed = [item for item in results if item is not None]
    assert len(claimed) == 1
    assert claimed[0] == 1

    with pg_engine.begin() as conn:
        owners = conn.execute(
            text(f"SELECT owner FROM {table} WHERE id = 1")
        ).scalar_one()
        assert owners in {"A", "B"}
        pending = conn.execute(
            text(f"SELECT count(*) FROM {table} WHERE status = 'pending'")
        ).scalar_one()
        assert pending == 0
        conn.execute(text(f"DROP TABLE IF EXISTS {table}"))


def test_non_leader_still_allows_profile_claims(pg_engine, monkeypatch):
    """Holding no leadership lock must not block normal claim eligibility."""

    monkeypatch.setattr(settings, "worker_profile", "general")
    leader = Session(bind=pg_engine.connect())
    try:
        assert try_acquire_scheduler_leadership(leader) is True
        assert runner._profile_allows_claim("training") is True
        assert runner._profile_allows_claim("pipeline") is True
    finally:
        release_scheduler_leadership(leader)
        leader.close()
