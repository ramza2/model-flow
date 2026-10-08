"""Phase 8-B worker identity, heartbeat status, and healthcheck isolation."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.db.models import Base, WorkerHeartbeat
from app.workers import healthcheck, identity, runner


@pytest.fixture
def sqlite_sessions(monkeypatch):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(
        bind=engine, autocommit=False, autoflush=False
    )
    Base.metadata.create_all(engine)
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr(healthcheck, "SessionLocal", TestingSessionLocal)
    yield TestingSessionLocal
    Base.metadata.drop_all(engine)


def test_worker_id_explicit_override(monkeypatch):
    monkeypatch.setattr(settings, "worker_id", "replica-alpha")
    assert identity.resolve_worker_id() == "replica-alpha"


def test_worker_id_hostname_fallback(monkeypatch):
    monkeypatch.setattr(settings, "worker_id", "")
    monkeypatch.setattr(identity.socket, "gethostname", lambda: "compose-worker-7f2a")
    assert identity.resolve_worker_id() == "compose-worker-7f2a"


def test_worker_id_blank_override_falls_back_to_hostname(monkeypatch):
    monkeypatch.setattr(settings, "worker_id", "   ")
    monkeypatch.setattr(identity.socket, "gethostname", lambda: "host-b")
    assert identity.resolve_worker_id() == "host-b"


def test_heartbeat_status_includes_profile_and_capabilities(
    monkeypatch, sqlite_sessions
):
    monkeypatch.setattr(settings, "worker_id", "hb-worker-1")
    monkeypatch.setattr(settings, "worker_profile", "general")
    monkeypatch.setattr(settings, "worker_max_concurrent_jobs", 3)
    monkeypatch.setattr(settings, "git_sha", "abc1234")

    runner.beat()

    with sqlite_sessions() as db:
        row = db.get(WorkerHeartbeat, "hb-worker-1")
        assert row is not None
        payload = json.loads(row.status_json)
    assert payload["worker_id"] == "hb-worker-1"
    assert payload["profile"] == "general"
    assert payload["capabilities"] == ["cpu"]
    assert payload["max_concurrent_jobs"] == 3
    assert payload["git_sha"] == "abc1234"
    assert "secret" not in json.dumps(payload).lower()
    assert "token" not in json.dumps(payload).lower()
    assert "password" not in json.dumps(payload).lower()


def test_healthcheck_requires_own_worker_heartbeat(monkeypatch, sqlite_sessions):
    monkeypatch.setattr(settings, "worker_id", "self-worker")
    monkeypatch.setattr(settings, "worker_heartbeat_max_age_seconds", 30)
    now = datetime.now(timezone.utc)
    with sqlite_sessions() as db:
        db.add(
            WorkerHeartbeat(
                worker_id="other-worker",
                last_seen_at=now,
                status_json="{}",
            )
        )
        db.commit()

    assert healthcheck.main() == 1

    runner.beat()
    assert healthcheck.main() == 0


def test_healthcheck_rejects_stale_own_heartbeat(monkeypatch, sqlite_sessions):
    monkeypatch.setattr(settings, "worker_id", "stale-worker")
    monkeypatch.setattr(settings, "worker_heartbeat_max_age_seconds", 30)
    stale = datetime.now(timezone.utc) - timedelta(seconds=120)
    with sqlite_sessions() as db:
        db.add(
            WorkerHeartbeat(
                worker_id="stale-worker",
                last_seen_at=stale,
                status_json="{}",
            )
        )
        db.commit()

    assert healthcheck.main() == 1


def test_gpu_worker_does_not_claim_general_jobs(monkeypatch, sqlite_sessions):
    from app.db.models import Dataset, DatasetVersion, JobStatus, Project, TrainingJob

    monkeypatch.setattr(settings, "worker_id", "gpu-1")
    monkeypatch.setattr(settings, "worker_profile", "gpu")
    with sqlite_sessions() as db:
        project = Project(name="gpu-claim")
        db.add(project)
        db.flush()
        dataset = Dataset(
            project_id=project.id,
            name="iris",
            object_key="iris.csv",
            latest_version=1,
        )
        db.add(dataset)
        db.flush()
        version = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project.id,
            version=1,
            object_key="iris.csv",
            original_filename="iris.csv",
            format="csv",
        )
        db.add(version)
        db.flush()
        db.add(
            TrainingJob(
                project_id=project.id,
                dataset_id=dataset.id,
                dataset_version_id=version.id,
                name="pending-train",
                target_column="target",
                status=JobStatus.pending,
            )
        )
        db.commit()

    assert runner.claim_next_job() is None


def _seed_queued_preparation_run(db):
    from app.db.models import (
        DatasetPreparation,
        DatasetPreparationRun,
        DatasetPreparationRunStatus,
        DatasetPreparationVersion,
        Project,
    )

    project = Project(name="prep-claim")
    db.add(project)
    db.flush()
    prep = DatasetPreparation(project_id=project.id, name="prep")
    db.add(prep)
    db.flush()
    version = DatasetPreparationVersion(
        preparation_id=prep.id,
        project_id=project.id,
        version=1,
    )
    db.add(version)
    db.flush()
    run = DatasetPreparationRun(
        project_id=project.id,
        preparation_id=prep.id,
        preparation_version_id=version.id,
        status=DatasetPreparationRunStatus.queued,
    )
    db.add(run)
    db.commit()
    return run.id


def test_general_worker_claims_queued_preparation_run(monkeypatch, sqlite_sessions):
    from app.db.models import DatasetPreparationRunStatus

    monkeypatch.setattr(settings, "worker_id", "general-prep")
    monkeypatch.setattr(settings, "worker_profile", "general")
    with sqlite_sessions() as db:
        run_id = _seed_queued_preparation_run(db)

    claimed = runner.claim_next_preparation_run()
    assert claimed is not None
    assert claimed.id == run_id
    assert claimed.status == DatasetPreparationRunStatus.running


def test_gpu_worker_does_not_claim_queued_preparation_run(monkeypatch, sqlite_sessions):
    from app.db.models import DatasetPreparationRun, DatasetPreparationRunStatus

    monkeypatch.setattr(settings, "worker_id", "gpu-prep")
    monkeypatch.setattr(settings, "worker_profile", "gpu")
    with sqlite_sessions() as db:
        run_id = _seed_queued_preparation_run(db)

    assert runner.claim_next_preparation_run() is None

    with sqlite_sessions() as db:
        live = db.get(DatasetPreparationRun, run_id)
        assert live is not None
        assert live.status == DatasetPreparationRunStatus.queued


def test_special_claim_paths_call_profile_allows_claim():
    """Non-_claim_next entry points must fail-closed on profile before DB work."""

    import inspect

    preparation_src = inspect.getsource(runner.claim_next_preparation_run)
    pipeline_src = inspect.getsource(runner.claim_pipeline_runs)
    claim_next_src = inspect.getsource(runner._claim_next)

    assert "_profile_allows_claim" in preparation_src
    assert "dataset_preparation" in preparation_src
    assert "_profile_allows_claim" in pipeline_src
    assert "_profile_allows_claim" in claim_next_src
