from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dumps,
    friendly,
    get_owned,
    loads,
    schedule_out,
    schedule_run_out,
)
from app.core.deps import require_project_perm
from app.core.rbac import Permission, role_has
from app.db.models import (
    AutomationSchedule,
    AutomationScheduleRun,
    ConcurrencyPolicy,
    DataSource,
    Dataset,
    Endpoint,
    ModelVersion,
    Pipeline,
    PipelineStatus,
    ProjectRole,
    ScheduleTargetType,
)
from app.db.session import get_db
from app.schemas.v1 import (
    ScheduleBatchTarget,
    ScheduleCreate,
    ScheduleDataImportTarget,
    SchedulePipelineTarget,
    ScheduleUpdate,
)
from app.services import cron_schedule, job_factories, scheduler

router = APIRouter(tags=["schedules"])


def _require_target_perm(role: ProjectRole, target_type: ScheduleTargetType) -> None:
    if target_type == ScheduleTargetType.data_import and not role_has(role, Permission.DATA_WRITE):
        raise friendly(403, "DATA_WRITE permission is required for data import schedules.")
    if target_type == ScheduleTargetType.batch_inference and not role_has(role, Permission.DEPLOY_WRITE):
        raise friendly(403, "DEPLOY_WRITE permission is required for batch prediction schedules.")
    if target_type == ScheduleTargetType.pipeline_run and not role_has(role, Permission.PIPELINE_WRITE):
        raise friendly(403, "PIPELINE_WRITE permission is required for pipeline schedules.")


def _validate_cron_timezone(cron_expression: str, timezone_name: str) -> tuple[str, str]:
    try:
        cron = cron_schedule.validate_cron(cron_expression)
        tz = cron_schedule.validate_timezone(timezone_name)
    except cron_schedule.CronValidationError as exc:
        raise friendly(400, str(exc)) from exc
    except cron_schedule.TimezoneValidationError as exc:
        raise friendly(400, str(exc)) from exc
    return cron, tz


def _resolve_data_import_config(
    db: Session,
    *,
    project_id: int,
    raw: dict[str, Any],
    created_by: int | None,
) -> dict[str, Any]:
    body = ScheduleDataImportTarget.model_validate(raw)
    get_owned(db, DataSource, body.data_source_id, project_id, "Data source")
    dataset = job_factories.resolve_dataset(
        db,
        project_id=project_id,
        dataset_id=body.dataset_id,
        dataset_name=body.dataset_name,
        created_by=created_by,
    )
    return {
        "data_source_id": body.data_source_id,
        "dataset_id": dataset.id,
        "query_or_table": body.query_or_table,
    }


def _resolve_batch_config(
    db: Session,
    *,
    project_id: int,
    raw: dict[str, Any],
) -> dict[str, Any]:
    body = ScheduleBatchTarget.model_validate(raw)
    get_owned(db, Dataset, body.dataset_id, project_id, "Dataset")
    if body.endpoint_id is not None:
        get_owned(db, Endpoint, body.endpoint_id, project_id, "Endpoint")
    if body.model_version_id is not None:
        get_owned(db, ModelVersion, body.model_version_id, project_id, "Model version")
    if body.dataset_version_strategy == "fixed":
        job_factories.resolve_dataset_version_for_batch(
            db,
            project_id=project_id,
            dataset_id=body.dataset_id,
            strategy="fixed",
            fixed_version_id=body.dataset_version_id,
        )
    return {
        "dataset_id": body.dataset_id,
        "dataset_version_strategy": body.dataset_version_strategy,
        "dataset_version_id": body.dataset_version_id,
        "endpoint_id": body.endpoint_id,
        "model_version_id": body.model_version_id,
        "result_format": body.result_format,
    }


def _resolve_pipeline_config(
    db: Session,
    *,
    project_id: int,
    raw: dict[str, Any],
    refresh_pinned_version: bool = False,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = SchedulePipelineTarget.model_validate(raw)
    pipeline = get_owned(db, Pipeline, body.pipeline_id, project_id, "Pipeline")
    if pipeline.status != PipelineStatus.published:
        raise friendly(400, "Pipeline must be published before it can be scheduled.")
    version_id = body.pipeline_version_id
    if version_id is None and existing and not refresh_pinned_version:
        version_id = existing.get("pipeline_version_id")
    _, version = job_factories.resolve_published_pipeline_version(
        db,
        project_id=project_id,
        pipeline_id=pipeline.id,
        pipeline_version_id=version_id,
    )
    return {
        "pipeline_id": pipeline.id,
        "pipeline_version_id": version.id,
        "parameters": body.parameters,
        "fail_policy": body.fail_policy,
    }


def _resolve_target_config(
    db: Session,
    *,
    project_id: int,
    target_type: ScheduleTargetType,
    raw: dict[str, Any],
    created_by: int | None,
    refresh_pinned_version: bool = False,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if target_type == ScheduleTargetType.data_import:
        return _resolve_data_import_config(db, project_id=project_id, raw=raw, created_by=created_by)
    if target_type == ScheduleTargetType.batch_inference:
        return _resolve_batch_config(db, project_id=project_id, raw=raw)
    if target_type == ScheduleTargetType.pipeline_run:
        return _resolve_pipeline_config(
            db,
            project_id=project_id,
            raw=raw,
            refresh_pinned_version=refresh_pinned_version,
            existing=existing,
        )
    raise friendly(400, "Unsupported schedule target type.")


@router.get("/projects/{project_id}/schedules")
def list_schedules(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.SCHEDULE_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(AutomationSchedule)
        .where(AutomationSchedule.project_id == project_id)
        .order_by(AutomationSchedule.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [schedule_out(row) for row in rows]


@router.post("/projects/{project_id}/schedules", status_code=201)
def create_schedule(
    project_id: int,
    body: ScheduleCreate,
    access=Depends(require_project_perm(Permission.SCHEDULE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, role = access
    cron, tz = _validate_cron_timezone(body.cron_expression, body.timezone)
    target_type = ScheduleTargetType(body.target_type)
    _require_target_perm(role, target_type)
    config = _resolve_target_config(
        db,
        project_id=project_id,
        target_type=target_type,
        raw=body.target_config,
        created_by=auth.user.id,
    )
    now = datetime.now(timezone.utc)
    schedule = AutomationSchedule(
        project_id=project_id,
        name=body.name.strip(),
        description=body.description or "",
        target_type=target_type,
        target_config_json=dumps(config),
        cron_expression=cron,
        timezone=tz,
        is_enabled=body.is_enabled,
        concurrency_policy=ConcurrencyPolicy(body.concurrency_policy),
        max_concurrent_runs=body.max_concurrent_runs,
        max_retries=body.max_retries,
        retry_delay_seconds=body.retry_delay_seconds,
        next_run_at=(
            scheduler.compute_initial_next_run(cron, tz, after_utc=now)
            if body.is_enabled
            else None
        ),
        created_by=auth.user.id,
    )
    db.add(schedule)
    db.flush()
    audit_event(
        db,
        auth,
        "schedule.create",
        "automation_schedule",
        schedule.id,
        after=schedule_out(schedule),
    )
    db.commit()
    db.refresh(schedule)
    return schedule_out(schedule)


@router.get("/projects/{project_id}/schedules/{schedule_id}")
def get_schedule(
    project_id: int,
    schedule_id: int,
    _=Depends(require_project_perm(Permission.SCHEDULE_READ)),
    db: Session = Depends(get_db),
):
    return schedule_out(
        get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    )


@router.patch("/projects/{project_id}/schedules/{schedule_id}")
def update_schedule(
    project_id: int,
    schedule_id: int,
    body: ScheduleUpdate,
    access=Depends(require_project_perm(Permission.SCHEDULE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, role = access
    schedule = get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    before = schedule_out(schedule)
    _require_target_perm(role, schedule.target_type)
    existing_config = loads(schedule.target_config_json, {})
    if body.name is not None:
        schedule.name = body.name.strip()
    if body.description is not None:
        schedule.description = body.description
    if body.target_config is not None:
        schedule.target_config_json = dumps(
            _resolve_target_config(
                db,
                project_id=project_id,
                target_type=schedule.target_type,
                raw=body.target_config,
                created_by=auth.user.id,
                refresh_pinned_version=body.refresh_pinned_version,
                existing=existing_config,
            )
        )
    elif body.refresh_pinned_version and schedule.target_type == ScheduleTargetType.pipeline_run:
        schedule.target_config_json = dumps(
            _resolve_pipeline_config(
                db,
                project_id=project_id,
                raw=existing_config,
                refresh_pinned_version=True,
                existing=existing_config,
            )
        )
    cron_changed = False
    if body.cron_expression is not None or body.timezone is not None:
        cron, tz = _validate_cron_timezone(
            body.cron_expression or schedule.cron_expression,
            body.timezone or schedule.timezone,
        )
        schedule.cron_expression = cron
        schedule.timezone = tz
        cron_changed = True
    if body.concurrency_policy is not None:
        schedule.concurrency_policy = ConcurrencyPolicy(body.concurrency_policy)
    if body.max_concurrent_runs is not None:
        schedule.max_concurrent_runs = body.max_concurrent_runs
    if body.max_retries is not None:
        schedule.max_retries = body.max_retries
    if body.retry_delay_seconds is not None:
        schedule.retry_delay_seconds = body.retry_delay_seconds
    if body.is_enabled is not None:
        schedule.is_enabled = body.is_enabled
        if not body.is_enabled:
            scheduler.disable_schedule_pending_runs(db, schedule.id)
            schedule.next_run_at = None
    if cron_changed or (body.is_enabled is True and schedule.is_enabled):
        schedule.next_run_at = scheduler.compute_initial_next_run(
            schedule.cron_expression,
            schedule.timezone,
            after_utc=datetime.now(timezone.utc),
        )
    audit_event(
        db,
        auth,
        "schedule.update",
        "automation_schedule",
        schedule.id,
        before=before,
        after=schedule_out(schedule),
    )
    db.commit()
    db.refresh(schedule)
    return schedule_out(schedule)


@router.delete("/projects/{project_id}/schedules/{schedule_id}", status_code=204)
def delete_schedule(
    project_id: int,
    schedule_id: int,
    access=Depends(require_project_perm(Permission.SCHEDULE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, role = access
    schedule = get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    _require_target_perm(role, schedule.target_type)
    has_history = db.scalar(
        select(AutomationScheduleRun.id)
        .where(AutomationScheduleRun.schedule_id == schedule.id)
        .limit(1)
    )
    if has_history is not None:
        raise friendly(
            409,
            "Schedule has run history and cannot be deleted.",
            "Disable the schedule instead.",
        )
    before = schedule_out(schedule)
    db.delete(schedule)
    audit_event(
        db,
        auth,
        "schedule.delete",
        "automation_schedule",
        schedule_id,
        before=before,
    )
    db.commit()


@router.post("/projects/{project_id}/schedules/{schedule_id}/enable")
def enable_schedule(
    project_id: int,
    schedule_id: int,
    access=Depends(require_project_perm(Permission.SCHEDULE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, role = access
    schedule = get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    _require_target_perm(role, schedule.target_type)
    schedule.is_enabled = True
    schedule.next_run_at = scheduler.compute_initial_next_run(
        schedule.cron_expression,
        schedule.timezone,
        after_utc=datetime.now(timezone.utc),
    )
    audit_event(db, auth, "schedule.enable", "automation_schedule", schedule.id)
    db.commit()
    db.refresh(schedule)
    return schedule_out(schedule)


@router.post("/projects/{project_id}/schedules/{schedule_id}/disable")
def disable_schedule(
    project_id: int,
    schedule_id: int,
    access=Depends(require_project_perm(Permission.SCHEDULE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, role = access
    schedule = get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    _require_target_perm(role, schedule.target_type)
    schedule.is_enabled = False
    schedule.next_run_at = None
    scheduler.disable_schedule_pending_runs(db, schedule.id)
    audit_event(db, auth, "schedule.disable", "automation_schedule", schedule.id)
    db.commit()
    db.refresh(schedule)
    return schedule_out(schedule)


@router.post("/projects/{project_id}/schedules/{schedule_id}/run-now", status_code=202)
def run_schedule_now(
    project_id: int,
    schedule_id: int,
    access=Depends(require_project_perm(Permission.SCHEDULE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, role = access
    schedule = get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    _require_target_perm(role, schedule.target_type)
    try:
        run = scheduler.create_manual_run(db, schedule)
    except ValueError as exc:
        raise friendly(409, str(exc)) from exc
    audit_event(
        db,
        auth,
        "schedule.run_now",
        "automation_schedule",
        schedule.id,
        after={"schedule_run_id": run.id},
    )
    db.commit()
    db.refresh(run)
    return schedule_run_out(run)


@router.get("/projects/{project_id}/schedules/{schedule_id}/runs")
def list_schedule_runs(
    project_id: int,
    schedule_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.SCHEDULE_READ)),
    db: Session = Depends(get_db),
):
    get_owned(db, AutomationSchedule, schedule_id, project_id, "Schedule")
    rows = db.scalars(
        select(AutomationScheduleRun)
        .where(
            AutomationScheduleRun.schedule_id == schedule_id,
            AutomationScheduleRun.project_id == project_id,
        )
        .order_by(AutomationScheduleRun.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [schedule_run_out(row) for row in rows]


@router.get("/projects/{project_id}/schedule-runs/{run_id}")
def get_schedule_run(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.SCHEDULE_READ)),
    db: Session = Depends(get_db),
):
    return schedule_run_out(
        get_owned(db, AutomationScheduleRun, run_id, project_id, "Schedule run")
    )
