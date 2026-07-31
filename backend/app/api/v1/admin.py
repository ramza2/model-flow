from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, dumps, friendly, loads
from app.core.config import settings
from app.core.deps import AuthContext, require_system_admin
from app.db.models import (
    BatchInferenceJob,
    DataImportJob,
    DriftRun,
    JobStatus,
    PipelineRun,
    SystemSetting,
    TrainingJob,
    WorkerHeartbeat,
)
from app.db.session import get_db
from app.schemas.v1 import RetentionPolicyUpdate, SettingsUpdate
from app.services import mlflow_service, storage

router = APIRouter(prefix="/admin", tags=["admin"])
_EDITABLE_SETTINGS = {
    "allow_train_on_quality_fail",
    "store_inference_payloads",
    "max_upload_bytes",
    "rate_limit_per_minute",
    "worker_max_concurrent_jobs",
}
_RETENTION_MAP = {
    "training_logs_days": "retention_training_logs_days",
    "inference_stats_days": "retention_inference_stats_days",
    "audit_logs_days": "retention_audit_logs_days",
    "batch_results_days": "retention_batch_results_days",
    "archived_models_days": "retention_archived_models_days",
}


def _setting_upsert(db: Session, key: str, value, user_id: int) -> None:
    row = db.get(SystemSetting, key)
    if row is None:
        row = SystemSetting(key=key)
        db.add(row)
    row.value_json = dumps(value)
    row.updated_by = user_id


@router.get("/status")
def system_status(
    _: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    database_status = "ok"
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        database_status = "error"
    minio_status = "ok"
    storage_estimates = None
    try:
        client = storage.s3_client()
        buckets = [
            settings.minio_datasets_bucket,
            settings.minio_mlflow_bucket,
            settings.minio_batch_bucket,
            settings.minio_artifacts_bucket,
        ]
        storage_estimates = {}
        for bucket in buckets:
            total_bytes = 0
            object_count = 0
            paginator = client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket):
                objects = page.get("Contents", [])
                object_count += len(objects)
                total_bytes += sum(int(item.get("Size", 0)) for item in objects)
            storage_estimates[bucket] = {
                "object_count": object_count,
                "bytes": total_bytes,
            }
    except Exception:
        minio_status = "error"
    mlflow_status = "ok"
    try:
        mlflow_service.client().search_experiments(max_results=1)
    except Exception:
        mlflow_status = "error"
    queue_models = {
        "training": TrainingJob,
        "data_import": DataImportJob,
        "pipeline": PipelineRun,
        "batch_inference": BatchInferenceJob,
        "drift": DriftRun,
    }
    queue_depths = {}
    for name, model in queue_models.items():
        queue_depths[name] = {
            status.value: db.scalar(
                select(func.count()).select_from(model).where(model.status == status)
            )
            or 0
            for status in (JobStatus.pending, JobStatus.running, JobStatus.failed)
        }
    now = datetime.now(timezone.utc)
    workers = []
    for heartbeat in db.scalars(
        select(WorkerHeartbeat).order_by(WorkerHeartbeat.worker_id)
    ).all():
        seen = heartbeat.last_seen_at
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        age = max(0.0, (now - seen).total_seconds())
        workers.append(
            {
                "worker_id": heartbeat.worker_id,
                "last_seen_at": heartbeat.last_seen_at,
                "age_seconds": age,
                "healthy": age <= settings.worker_heartbeat_max_age_seconds,
                "status": loads(heartbeat.status_json, {}),
            }
        )
    return {
        "api": "ok",
        "version": settings.app_version,
        "git_sha": settings.git_sha,
        "database": database_status,
        "minio": minio_status,
        "mlflow": mlflow_status,
        "workers": workers,
        "healthy_worker_count": sum(worker["healthy"] for worker in workers),
        "queue_depths": queue_depths,
        "storage": storage_estimates,
    }


@router.get("/settings")
def get_system_settings(
    _: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    stored = {
        row.key: loads(row.value_json, None)
        for row in db.scalars(
            select(SystemSetting).where(SystemSetting.key.in_(_EDITABLE_SETTINGS))
        ).all()
    }
    return {
        key: stored.get(key, getattr(settings, key))
        for key in sorted(_EDITABLE_SETTINGS)
    }


@router.put("/settings")
def put_system_settings(
    body: SettingsUpdate,
    auth: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    unknown = sorted(set(body.values) - _EDITABLE_SETTINGS)
    if unknown:
        raise friendly(400, f"Unsupported system settings: {', '.join(unknown)}.")
    for key, value in body.values.items():
        expected = type(getattr(settings, key))
        if type(value) is not expected:
            raise friendly(422, f"Setting '{key}' must be {expected.__name__}.")
        _setting_upsert(db, key, value, auth.user.id)
        setattr(settings, key, value)
    audit_event(db, auth, "system_settings.update", "system_setting", after=body.values)
    db.commit()
    return get_system_settings(auth, db)


@router.get("/retention")
def get_retention_policy(
    _: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    keys = list(_RETENTION_MAP.values())
    stored = {
        row.key: loads(row.value_json, None)
        for row in db.scalars(
            select(SystemSetting).where(SystemSetting.key.in_(keys))
        ).all()
    }
    return {
        public: stored.get(internal, getattr(settings, internal))
        for public, internal in _RETENTION_MAP.items()
    }


@router.put("/retention")
def put_retention_policy(
    body: RetentionPolicyUpdate,
    auth: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    values = body.model_dump()
    for public, value in values.items():
        internal = _RETENTION_MAP[public]
        _setting_upsert(db, internal, value, auth.user.id)
        setattr(settings, internal, value)
    audit_event(db, auth, "retention_policy.update", "system_setting", after=values)
    db.commit()
    return values
