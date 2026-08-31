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


def _assert_last_run_at(schedule: AutomationSchedule | None, expected: datetime) -> None:
    assert schedule is not None
    assert schedule.last_run_at is not None
    actual = schedule.last_run_at
    if actual.tzinfo is None:
        actual = actual.replace(tzinfo=timezone.utc)
    assert actual == expected


def test_run_now_does_not_change_next_run_at():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        original_next = schedule.next_run_at
        now = datetime.now(timezone.utc)
        manual = scheduler.create_manual_run(db, schedule, now=now)
        db.commit()
        refreshed = db.get(AutomationSchedule, schedule.id)
        assert refreshed.next_run_at == original_next
        assert manual.trigger_source == ScheduleTriggerSource.manual
        _assert_last_run_at(refreshed, now)


def test_disabled_manual_run_updates_last_run_at_without_enabling():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        schedule.is_enabled = False
        schedule.next_run_at = None
        db.commit()
        now = datetime.now(timezone.utc)
        scheduler.create_manual_run(db, schedule, now=now)
        db.commit()
        refreshed = db.get(AutomationSchedule, schedule.id)
        assert refreshed.is_enabled is False
        assert refreshed.next_run_at is None
        _assert_last_run_at(refreshed, now)


def test_manual_run_updates_last_run_at_after_cron():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        cron_time = datetime.now(timezone.utc)
        scheduler.scheduler_tick(db, now=cron_time)
        refreshed = db.get(AutomationSchedule, schedule.id)
        _assert_last_run_at(refreshed, cron_time)
        manual_time = datetime.now(timezone.utc) + timedelta(seconds=5)
        scheduler.create_manual_run(db, schedule, now=manual_time)
        db.commit()
        refreshed = db.get(AutomationSchedule, schedule.id)
        _assert_last_run_at(refreshed, manual_time)


def test_cron_occurrence_updates_last_run_at():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        now = datetime.now(timezone.utc)
        scheduler.scheduler_tick(db, now=now)
        refreshed = db.get(AutomationSchedule, schedule.id)
        _assert_last_run_at(refreshed, now)


def test_disable_skips_cron_pending_runs():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        now = datetime.now(timezone.utc)
        cron_run = AutomationScheduleRun(
            schedule_id=schedule.id,
            project_id=schedule.project_id,
            scheduled_for=now,
            attempt=1,
            trigger_source=ScheduleTriggerSource.cron,
            status=ScheduleRunStatus.pending,
            target_type=schedule.target_type,
        )
        db.add(cron_run)
        db.commit()
        scheduler.disable_schedule_pending_runs(db, schedule.id)
        db.commit()
        refreshed = db.get(AutomationScheduleRun, cron_run.id)
        assert refreshed is not None
        assert refreshed.status == ScheduleRunStatus.skipped
        assert "disabled" in (refreshed.error_message or "").lower()


def test_disable_does_not_skip_manual_pending_runs():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        now = datetime.now(timezone.utc)
        manual = scheduler.create_manual_run(db, schedule, now=now)
        db.commit()
        scheduler.disable_schedule_pending_runs(db, schedule.id)
        db.commit()
        refreshed = db.get(AutomationScheduleRun, manual.id)
        assert refreshed is not None
        assert refreshed.status == ScheduleRunStatus.pending


def test_disabled_schedule_manual_run_now_dispatches():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        schedule.is_enabled = False
        schedule.next_run_at = None
        db.commit()
        now = datetime.now(timezone.utc)
        manual = scheduler.create_manual_run(db, schedule, now=now)
        db.commit()
        assert manual.status == ScheduleRunStatus.pending
        stats = scheduler.scheduler_tick(db, now=now)
        assert stats["skipped_disabled"] == 0
        assert stats["dispatched"] == 1
        refreshed_run = db.get(AutomationScheduleRun, manual.id)
        assert refreshed_run is not None
        assert refreshed_run.status == ScheduleRunStatus.dispatched
        assert refreshed_run.target_resource_id is not None
        child = db.get(PipelineRun, refreshed_run.target_resource_id)
        assert child is not None
        refreshed_schedule = db.get(AutomationSchedule, schedule.id)
        assert refreshed_schedule.is_enabled is False
        assert refreshed_schedule.next_run_at is None


def test_disabled_schedule_cron_pending_skipped_on_tick():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        now = datetime.now(timezone.utc)
        cron_run = AutomationScheduleRun(
            schedule_id=schedule.id,
            project_id=schedule.project_id,
            scheduled_for=now,
            attempt=1,
            trigger_source=ScheduleTriggerSource.cron,
            status=ScheduleRunStatus.pending,
            target_type=schedule.target_type,
        )
        schedule.is_enabled = False
        db.add(cron_run)
        db.commit()
        stats = scheduler.scheduler_tick(db, now=now)
        assert stats["skipped_disabled"] == 1
        assert stats["dispatched"] == 0
        refreshed = db.get(AutomationScheduleRun, cron_run.id)
        assert refreshed is not None
        assert refreshed.status == ScheduleRunStatus.skipped


def test_disabled_schedule_manual_retry_dispatches():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        schedule.is_enabled = False
        schedule.next_run_at = None
        db.commit()
        now = datetime.now(timezone.utc)
        manual = scheduler.create_manual_run(db, schedule, now=now)
        db.commit()
        scheduler.dispatch_pending_runs(db, now=now)
        db.commit()
        run = db.get(AutomationScheduleRun, manual.id)
        assert run is not None and run.target_resource_id is not None
        child = db.get(PipelineRun, run.target_resource_id)
        child.status = JobStatus.failed
        db.commit()
        scheduler.reconcile_active_runs(db, now=now)
        db.commit()
        retry = db.scalar(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.attempt == 2,
                AutomationScheduleRun.trigger_source == ScheduleTriggerSource.manual,
            )
        )
        assert retry is not None
        assert retry.status == ScheduleRunStatus.pending
        stats = scheduler.scheduler_tick(db, now=now + timedelta(seconds=2))
        assert stats["dispatched"] == 1
        refreshed_retry = db.get(AutomationScheduleRun, retry.id)
        assert refreshed_retry is not None
        assert refreshed_retry.status == ScheduleRunStatus.dispatched
        assert refreshed_retry.target_resource_id is not None
        assert db.get(AutomationSchedule, schedule.id).is_enabled is False


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


def test_pinned_pipeline_version_dispatches_after_pipeline_returns_to_draft():
    """Pinned v1 must still run when a later edit puts the pipeline back in draft."""

    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=True)
        pinned_version_id = json.loads(schedule.target_config_json)["pipeline_version_id"]
        pipeline = db.get(Pipeline, json.loads(schedule.target_config_json)["pipeline_id"])
        assert pipeline is not None
        # Simulate saving a new draft version after the schedule pinned published v1.
        draft = PipelineVersion(
            pipeline_id=pipeline.id,
            project_id=pipeline.project_id,
            version=2,
            graph_json=json.dumps(MINIMAL_GRAPH),
        )
        db.add(draft)
        pipeline.status = PipelineStatus.draft
        pipeline.latest_version = 2
        db.commit()

        stats = scheduler.scheduler_tick(db, now=datetime.now(timezone.utc))
        assert stats["occurrences_created"] == 1
        assert stats["dispatched"] == 1
        run = db.scalar(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id
            )
        )
        assert run is not None
        assert run.status == ScheduleRunStatus.dispatched
        assert run.target_resource_id is not None
        child = db.get(PipelineRun, run.target_resource_id)
        assert child is not None
        assert child.pipeline_version_id == pinned_version_id


def test_retry_creation_is_idempotent_across_reconcile_calls():
    """Reconciling the same failed run twice must not create duplicate retries.

    Note: SQLite test sessions do not fully exercise PostgreSQL SKIP LOCKED
    multi-worker contention; this verifies the idempotent pre-check /
    UniqueConstraint path that backs multi-worker safety.
    """

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
        scheduler.reconcile_active_runs(db, now=now)
        db.commit()

        retries = db.scalars(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.attempt == 2,
            )
        ).all()
        assert len(retries) == 1


def test_schedule_retry_skips_when_attempt_already_exists():
    with TestingSessionLocal() as db:
        schedule = _seed_pipeline_schedule(db, due=False)
        now = datetime.now(timezone.utc)
        scheduled_for = now - timedelta(minutes=1)
        failed = AutomationScheduleRun(
            schedule_id=schedule.id,
            project_id=schedule.project_id,
            scheduled_for=scheduled_for,
            attempt=1,
            trigger_source=ScheduleTriggerSource.cron,
            status=ScheduleRunStatus.failed,
            target_type=schedule.target_type,
            finished_at=now,
        )
        existing_retry = AutomationScheduleRun(
            schedule_id=schedule.id,
            project_id=schedule.project_id,
            scheduled_for=scheduled_for,
            attempt=2,
            trigger_source=ScheduleTriggerSource.cron,
            status=ScheduleRunStatus.pending,
            target_type=schedule.target_type,
            ready_at=now,
        )
        db.add_all([failed, existing_retry])
        db.commit()
        schedule.max_retries = 1
        db.commit()

        scheduler._schedule_retry(db, schedule, failed, now=now)
        db.commit()
        retries = db.scalars(
            select(AutomationScheduleRun).where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.attempt == 2,
            )
        ).all()
        assert len(retries) == 1
