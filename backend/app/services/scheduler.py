"""DB-backed automation scheduler executed by the ModelFlow worker."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import (
    AutomationSchedule,
    AutomationScheduleRun,
    BatchInferenceJob,
    ConcurrencyPolicy,
    DataImportJob,
    JobStatus,
    PipelineRun,
    ScheduleRunStatus,
    ScheduleTargetType,
    ScheduleTriggerSource,
)
from app.services import cron_schedule, job_factories

logger = logging.getLogger(__name__)

ACTIVE_RUN_STATUSES = (
    ScheduleRunStatus.pending,
    ScheduleRunStatus.dispatched,
    ScheduleRunStatus.running,
)
TERMINAL_CHILD_STATUSES = (
    JobStatus.succeeded,
    JobStatus.failed,
    JobStatus.cancelled,
)
ACTIVE_CHILD_STATUSES = (
    JobStatus.pending,
    JobStatus.queued,
    JobStatus.running,
    JobStatus.cancel_requested,
)


def _utc_now(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def _touch_last_run_at(schedule: AutomationSchedule, *, at: datetime) -> None:
    """Record the most recent schedule occurrence time (cron, manual, or retry)."""

    schedule.last_run_at = at


def _loads_config(schedule: AutomationSchedule) -> dict:
    try:
        value = json.loads(schedule.target_config_json or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def compute_initial_next_run(
    cron_expression: str,
    timezone_name: str,
    *,
    after_utc: datetime | None = None,
) -> datetime:
    return cron_schedule.advance_next_run(
        cron_expression,
        timezone_name,
        after_utc=_utc_now(after_utc),
    )


def _count_active_runs(db: Session, schedule_id: int) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(AutomationScheduleRun)
            .where(
                AutomationScheduleRun.schedule_id == schedule_id,
                AutomationScheduleRun.status.in_(
                    (
                        ScheduleRunStatus.dispatched,
                        ScheduleRunStatus.running,
                    )
                ),
            )
        )
        or 0
    )


def _load_child_status(
    db: Session,
    target_type: ScheduleTargetType,
    resource_id: int | None,
) -> JobStatus | None:
    if resource_id is None:
        return None
    if target_type == ScheduleTargetType.data_import:
        row = db.get(DataImportJob, resource_id)
    elif target_type == ScheduleTargetType.batch_inference:
        row = db.get(BatchInferenceJob, resource_id)
    elif target_type == ScheduleTargetType.pipeline_run:
        row = db.get(PipelineRun, resource_id)
    else:
        return None
    return row.status if row is not None else None


def _dispatch_child_job(
    db: Session,
    schedule: AutomationSchedule,
    config: dict,
) -> int:
    created_by = schedule.created_by
    if schedule.target_type == ScheduleTargetType.data_import:
        job = job_factories.create_data_import_job(
            db,
            project_id=schedule.project_id,
            data_source_id=int(config["data_source_id"]),
            dataset_id=int(config["dataset_id"]),
            query_or_table=str(config["query_or_table"]),
            created_by=created_by,
        )
        return job.id
    if schedule.target_type == ScheduleTargetType.batch_inference:
        version = job_factories.resolve_dataset_version_for_batch(
            db,
            project_id=schedule.project_id,
            dataset_id=int(config["dataset_id"]),
            strategy=str(config.get("dataset_version_strategy", "latest")),
            fixed_version_id=config.get("dataset_version_id"),
        )
        job = job_factories.create_batch_inference_job(
            db,
            project_id=schedule.project_id,
            dataset_version_id=version.id,
            endpoint_id=config.get("endpoint_id"),
            model_version_id=config.get("model_version_id"),
            result_format=str(config.get("result_format", "csv")),
            created_by=created_by,
        )
        return job.id
    if schedule.target_type == ScheduleTargetType.pipeline_run:
        # Dispatch uses the already-validated pinned pipeline_version_id.
        # Do not require pipeline.status == published: editing a new draft
        # version must not block schedules that still pin a prior version.
        run = job_factories.create_pipeline_run(
            db,
            project_id=schedule.project_id,
            pipeline_id=int(config["pipeline_id"]),
            pipeline_version_id=int(config["pipeline_version_id"]),
            parameters=config.get("parameters") or {},
            fail_policy=str(config.get("fail_policy", "stop")),
            created_by=created_by,
            require_published=False,
        )
        return run.id
    raise ValueError(f"Unsupported schedule target type '{schedule.target_type.value}'.")


def _schedule_retry(
    db: Session,
    schedule: AutomationSchedule,
    failed_run: AutomationScheduleRun,
    *,
    now: datetime,
) -> None:
    if failed_run.attempt > schedule.max_retries:
        return
    next_attempt = failed_run.attempt + 1
    existing = db.scalar(
        select(AutomationScheduleRun.id).where(
            AutomationScheduleRun.schedule_id == schedule.id,
            AutomationScheduleRun.scheduled_for == failed_run.scheduled_for,
            AutomationScheduleRun.attempt == next_attempt,
            AutomationScheduleRun.trigger_source == failed_run.trigger_source,
        )
    )
    if existing is not None:
        return
    try:
        with db.begin_nested():
            retry = AutomationScheduleRun(
                schedule_id=schedule.id,
                project_id=schedule.project_id,
                scheduled_for=failed_run.scheduled_for,
                attempt=next_attempt,
                trigger_source=failed_run.trigger_source,
                status=ScheduleRunStatus.pending,
                target_type=schedule.target_type,
                ready_at=now + timedelta(seconds=schedule.retry_delay_seconds),
            )
            db.add(retry)
            db.flush()
            _touch_last_run_at(schedule, at=now)
    except IntegrityError:
        # Concurrent worker inserted the same retry occurrence.
        logger.info(
            "Retry occurrence already exists schedule_id=%s scheduled_for=%s attempt=%s",
            schedule.id,
            failed_run.scheduled_for,
            next_attempt,
        )


def _finalize_run_failure(
    db: Session,
    schedule: AutomationSchedule,
    run: AutomationScheduleRun,
    message: str,
    *,
    now: datetime,
) -> None:
    run.status = ScheduleRunStatus.failed
    run.error_message = message
    run.finished_at = now
    _schedule_retry(db, schedule, run, now=now)


def _reconcile_run(
    db: Session,
    schedule: AutomationSchedule,
    run: AutomationScheduleRun,
    *,
    now: datetime,
) -> None:
    child_status = _load_child_status(db, run.target_type, run.target_resource_id)
    if child_status is None:
        _finalize_run_failure(db, schedule, run, "Child job no longer exists.", now=now)
        return
    if child_status in ACTIVE_CHILD_STATUSES:
        if child_status == JobStatus.running:
            run.status = ScheduleRunStatus.running
        else:
            run.status = ScheduleRunStatus.dispatched
        return
    if child_status == JobStatus.succeeded:
        run.status = ScheduleRunStatus.succeeded
        run.error_message = None
        run.finished_at = now
        return
    if child_status in (JobStatus.failed, JobStatus.cancelled):
        message = f"Child job finished with status '{child_status.value}'."
        _finalize_run_failure(db, schedule, run, message, now=now)


def reconcile_active_runs(db: Session, *, now: datetime | None = None) -> int:
    """Claim dispatched/running ScheduleRuns with SKIP LOCKED, then reconcile.

    Row locking prevents two workers from finalizing the same failed child and
    racing to insert the same retry attempt. UniqueConstraint still backs
    idempotency when a race slips through; IntegrityError is isolated via
    savepoint so one conflict cannot abort the whole scheduler tick.
    """

    now = _utc_now(now)
    rows = db.scalars(
        select(AutomationScheduleRun)
        .where(
            AutomationScheduleRun.status.in_(
                (ScheduleRunStatus.dispatched, ScheduleRunStatus.running)
            )
        )
        .order_by(AutomationScheduleRun.id.asc())
        .with_for_update(skip_locked=True)
    ).all()
    reconciled = 0
    for run in rows:
        schedule = db.get(AutomationSchedule, run.schedule_id)
        if schedule is None:
            continue
        try:
            with db.begin_nested():
                _reconcile_run(db, schedule, run, now=now)
                db.flush()
            reconciled += 1
        except IntegrityError:
            logger.info(
                "Reconcile conflict for schedule_run_id=%s (likely concurrent retry insert)",
                run.id,
            )
        except Exception:
            logger.exception("Reconcile failed for schedule_run_id=%s", run.id)
    return reconciled


def skip_pending_runs_for_disabled_schedules(db: Session, *, now: datetime | None = None) -> int:
    now = _utc_now(now)
    rows = db.scalars(
        select(AutomationScheduleRun)
        .join(AutomationSchedule)
        .where(
            AutomationScheduleRun.status == ScheduleRunStatus.pending,
            AutomationScheduleRun.trigger_source == ScheduleTriggerSource.cron,
            AutomationSchedule.is_enabled.is_(False),
        )
    ).all()
    for run in rows:
        run.status = ScheduleRunStatus.skipped
        run.error_message = "Schedule is disabled (cron occurrence)."
        run.finished_at = now
    db.flush()
    return len(rows)


def _create_occurrence(
    db: Session,
    schedule: AutomationSchedule,
    *,
    scheduled_for: datetime,
    attempt: int,
    trigger_source: ScheduleTriggerSource,
    ready_at: datetime | None = None,
) -> AutomationScheduleRun | None:
    existing = db.scalar(
        select(AutomationScheduleRun.id).where(
            AutomationScheduleRun.schedule_id == schedule.id,
            AutomationScheduleRun.scheduled_for == scheduled_for,
            AutomationScheduleRun.attempt == attempt,
            AutomationScheduleRun.trigger_source == trigger_source,
        )
    )
    if existing is not None:
        return None
    run = AutomationScheduleRun(
        schedule_id=schedule.id,
        project_id=schedule.project_id,
        scheduled_for=scheduled_for,
        attempt=attempt,
        trigger_source=trigger_source,
        status=ScheduleRunStatus.pending,
        target_type=schedule.target_type,
        ready_at=ready_at,
    )
    db.add(run)
    db.flush()
    return run


def process_due_schedules(db: Session, *, now: datetime | None = None) -> int:
    """Claim due enabled schedules and create at most one coalesced occurrence each."""

    now = _utc_now(now)
    created = 0
    schedules = db.scalars(
        select(AutomationSchedule)
        .where(
            AutomationSchedule.is_enabled.is_(True),
            AutomationSchedule.next_run_at.is_not(None),
            AutomationSchedule.next_run_at <= now,
        )
        .order_by(AutomationSchedule.next_run_at.asc())
        .with_for_update(skip_locked=True)
    ).all()
    for schedule in schedules:
        scheduled_for = schedule.next_run_at
        if scheduled_for is None:
            continue
        run = _create_occurrence(
            db,
            schedule,
            scheduled_for=scheduled_for,
            attempt=1,
            trigger_source=ScheduleTriggerSource.cron,
        )
        _touch_last_run_at(schedule, at=now)
        schedule.next_run_at = cron_schedule.advance_next_run(
            schedule.cron_expression,
            schedule.timezone,
            after_utc=now,
        )
        if run is not None:
            created += 1
    db.flush()
    return created


def dispatch_pending_runs(db: Session, *, now: datetime | None = None) -> int:
    now = _utc_now(now)
    dispatched = 0
    runs = db.scalars(
        select(AutomationScheduleRun)
        .join(AutomationSchedule)
        .where(
            AutomationScheduleRun.status == ScheduleRunStatus.pending,
            or_(
                AutomationSchedule.is_enabled.is_(True),
                and_(
                    AutomationSchedule.is_enabled.is_(False),
                    AutomationScheduleRun.trigger_source == ScheduleTriggerSource.manual,
                ),
            ),
            AutomationScheduleRun.ready_at.is_(None)
            | (AutomationScheduleRun.ready_at <= now),
        )
        .order_by(AutomationScheduleRun.id.asc())
        .with_for_update(skip_locked=True)
    ).all()
    for run in runs:
        schedule = db.get(AutomationSchedule, run.schedule_id)
        if schedule is None:
            continue
        active = _count_active_runs(db, schedule.id)
        if active >= schedule.max_concurrent_runs:
            if schedule.concurrency_policy == ConcurrencyPolicy.skip:
                run.status = ScheduleRunStatus.skipped
                run.error_message = "Concurrency limit reached (skip policy)."
                run.finished_at = now
            continue
        config = _loads_config(schedule)
        try:
            resource_id = _dispatch_child_job(db, schedule, config)
        except Exception as exc:
            _finalize_run_failure(db, schedule, run, str(exc), now=now)
            continue
        run.target_resource_id = resource_id
        run.status = ScheduleRunStatus.dispatched
        run.started_at = now
        run.error_message = None
        dispatched += 1
    db.flush()
    return dispatched


def create_manual_run(
    db: Session,
    schedule: AutomationSchedule,
    *,
    now: datetime | None = None,
) -> AutomationScheduleRun:
    now = _utc_now(now)
    active = _count_active_runs(db, schedule.id)
    pending = int(
        db.scalar(
            select(func.count())
            .select_from(AutomationScheduleRun)
            .where(
                AutomationScheduleRun.schedule_id == schedule.id,
                AutomationScheduleRun.status == ScheduleRunStatus.pending,
            )
        )
        or 0
    )
    if active + pending >= schedule.max_concurrent_runs:
        if schedule.concurrency_policy == ConcurrencyPolicy.skip:
            run = AutomationScheduleRun(
                schedule_id=schedule.id,
                project_id=schedule.project_id,
                scheduled_for=now,
                attempt=1,
                trigger_source=ScheduleTriggerSource.manual,
                status=ScheduleRunStatus.skipped,
                target_type=schedule.target_type,
                error_message="Concurrency limit reached (skip policy).",
                finished_at=now,
            )
            db.add(run)
            db.flush()
            _touch_last_run_at(schedule, at=now)
            return run
    run = AutomationScheduleRun(
        schedule_id=schedule.id,
        project_id=schedule.project_id,
        scheduled_for=now,
        attempt=1,
        trigger_source=ScheduleTriggerSource.manual,
        status=ScheduleRunStatus.pending,
        target_type=schedule.target_type,
        ready_at=now,
    )
    db.add(run)
    try:
        db.flush()
    except IntegrityError as exc:
        raise ValueError("A manual run for this schedule already exists at this time.") from exc
    _touch_last_run_at(schedule, at=now)
    return run


def scheduler_tick(db: Session, *, now: datetime | None = None) -> dict[str, int]:
    now = _utc_now(now)
    stats = {
        "skipped_disabled": skip_pending_runs_for_disabled_schedules(db, now=now),
        "reconciled": reconcile_active_runs(db, now=now),
        "occurrences_created": process_due_schedules(db, now=now),
        "dispatched": dispatch_pending_runs(db, now=now),
    }
    db.commit()
    return stats


def disable_schedule_pending_runs(db: Session, schedule_id: int, *, now: datetime | None = None) -> int:
    now = _utc_now(now)
    rows = db.scalars(
        select(AutomationScheduleRun).where(
            AutomationScheduleRun.schedule_id == schedule_id,
            AutomationScheduleRun.status == ScheduleRunStatus.pending,
            AutomationScheduleRun.trigger_source == ScheduleTriggerSource.cron,
        )
    ).all()
    for run in rows:
        run.status = ScheduleRunStatus.skipped
        run.error_message = "Schedule was disabled (cron occurrence)."
        run.finished_at = now
    db.flush()
    return len(rows)
