from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import (
    AutomationSchedule,
    AutomationScheduleRun,
    Base,
    ConcurrencyPolicy,
    DataSource,
    DataSourceType,
    Dataset,
    JobStatus,
    Pipeline,
    PipelineRun,
    PipelineStatus,
    PipelineVersion,
    Project,
    ScheduleRunStatus,
    ScheduleTargetType,
    ScheduleTriggerSource,
)
from app.services import scheduler
from app.workers import runner

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(engine)
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    yield
    Base.metadata.drop_all(engine)


MINIMAL_GRAPH = {
    "nodes": [{"id": "n1", "type": "notification", "data": {"node_type": "notification"}}],
    "edges": [],
}


def _seed_pipeline_schedule(db, *, due: bool = True) -> AutomationSchedule:
    project = Project(name="sched-test")
    db.add(project)
    db.flush()
    pipeline = Pipeline(
        project_id=project.id,
        name="pipe",
        status=PipelineStatus.published,
        latest_version=1,
    )
    db.add(pipeline)
    db.flush()
    version = PipelineVersion(
        pipeline_id=pipeline.id,
        project_id=project.id,
        version=1,
        graph_json=json.dumps(MINIMAL_GRAPH),
    )
    db.add(version)
    db.flush()
    now = datetime.now(timezone.utc)
    schedule = AutomationSchedule(
        project_id=project.id,
        name="weekly",
        target_type=ScheduleTargetType.pipeline_run,
        target_config_json=(
            '{"pipeline_id": %d, "pipeline_version_id": %d, "parameters": {}, "fail_policy": "stop"}'
            % (pipeline.id, version.id)
        ),
        cron_expression="0 9 * * 1",
        timezone="UTC",
        is_enabled=True,
        concurrency_policy=ConcurrencyPolicy.skip,
        max_concurrent_runs=1,
        max_retries=1,
        retry_delay_seconds=1,
        next_run_at=now - timedelta(minutes=5) if due else now + timedelta(days=1),
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    return schedule


def test_process_due_schedule_creates_pipeline_run():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        stats = scheduler.scheduler_tick(db, now=datetime.now(timezone.utc))
        assert stats["occurrences_created"] == 1
        run = db.scalar(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id
            )
        )
        assert run is not None
        assert run.status in (ScheduleRunStatus.pending, ScheduleRunStatus.dispatched)
        refreshed = db.get(AutomationSchedule, schedule.id)
        assert refreshed.next_run_at is not None


def test_duplicate_tick_is_idempotent():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        now = datetime.now(timezone.utc)
        first = scheduler.scheduler_tick(db, now=now)
        second = scheduler.scheduler_tick(db, now=now)
        assert first["occurrences_created"] == 1
        assert second["occurrences_created"] == 0
        count = db.scalar(
            select(AutomationScheduleRun.id).where(
                AutomationScheduleRun.schedule_id == schedule.id
            )
        )
        assert count is not None


def test_misfire_coalesces_to_single_occurrence():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        schedule.next_run_at = datetime.now(timezone.utc) - timedelta(hours=6)
        db.commit()
        stats = scheduler.scheduler_tick(db, now=datetime.now(timezone.utc))
        assert stats["occurrences_created"] == 1
        rows = db.scalars(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id
            )
        ).all()
        assert len(rows) == 1


def test_inactive_data_source_fails_occurrence():
    with TestingSessionLocal() as db:
        project = Project(name="import-test")
        db.add(project)
        db.flush()
        source = DataSource(
            project_id=project.id,
            name="pg",
            source_type=DataSourceType.postgres,
            config_json="{}",
            is_active=False,
        )
        dataset = Dataset(project_id=project.id, name="ds")
        db.add_all([source, dataset])
        db.flush()
        schedule = AutomationSchedule(
            project_id=project.id,
            name="import",
            target_type=ScheduleTargetType.data_import,
            target_config_json=(
                '{"data_source_id": %d, "dataset_id": %d, "query_or_table": "public.t"}'
                % (source.id, dataset.id)
            ),
            cron_expression="0 * * * *",
            timezone="UTC",
            is_enabled=True,
            next_run_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        db.add(schedule)
        db.commit()
        scheduler.scheduler_tick(db, now=datetime.now(timezone.utc))
        run = db.scalar(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id
            )
        )
        assert run is not None
        assert run.status == ScheduleRunStatus.failed
        assert "inactive" in (run.error_message or "").lower()


def test_run_now_does_not_change_next_run_at():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        original_next = schedule.next_run_at
        manual = scheduler.create_manual_run(db, schedule, now=datetime.now(timezone.utc))
        db.commit()
        refreshed = db.get(AutomationSchedule, schedule.id)
        assert refreshed.next_run_at == original_next
        assert manual.trigger_source == ScheduleTriggerSource.manual


def test_disable_skips_pending_runs():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        scheduler.scheduler_tick(db, now=datetime.now(timezone.utc))
        schedule.is_enabled = False
        scheduler.disable_schedule_pending_runs(db, schedule.id)
        db.commit()
        pending = db.scalars(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.status == ScheduleRunStatus.pending,
            )
        ).all()
        assert pending == []


def test_retry_creates_new_attempt_after_child_failure():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        now = datetime.now(timezone.utc)
        scheduler.scheduler_tick(db, now=now)
        run = db.scalar(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.attempt == 1,
            )
        )
        assert run is not None and run.target_resource_id is not None
        child = db.get(PipelineRun, run.target_resource_id)
        child.status = JobStatus.failed
        db.commit()
        scheduler.reconcile_active_runs(db, now=now)
        db.commit()
        failed = db.get(AutomationScheduleRun, run.id)
        assert failed.status == ScheduleRunStatus.failed
        retry = db.scalar(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.attempt == 2,
            )
        )
        assert retry is not None
        assert retry.status == ScheduleRunStatus.pending
