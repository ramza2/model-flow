from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v1.common import endpoint_out, get_owned
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import (
    Dataset,
    DatasetVersion,
    DriftRun,
    Endpoint,
    InferenceStat,
    ModelVersion,
    QualityCheck,
    QualityResult,
)
from app.db.session import get_db

router = APIRouter(tags=["monitoring"])


def _service_metrics(
    db: Session,
    project_id: int,
    endpoint_id: int | None,
    since: datetime,
) -> dict:
    statement = select(InferenceStat).where(
        InferenceStat.project_id == project_id,
        InferenceStat.created_at >= since,
    )
    if endpoint_id is not None:
        statement = statement.where(InferenceStat.endpoint_id == endpoint_id)
    rows = db.scalars(statement.order_by(InferenceStat.created_at)).all()
    total = len(rows)
    successes = sum(1 for row in rows if row.success)
    latencies = sorted(float(row.latency_ms or 0) for row in rows)
    p95 = (
        latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))]
        if latencies
        else None
    )
    buckets: dict[str, dict] = defaultdict(
        lambda: {"requests": 0, "successes": 0, "errors": 0, "latency_sum_ms": 0.0}
    )
    error_classes = Counter()
    for row in rows:
        created = row.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        key = (
            created.astimezone(timezone.utc)
            .replace(minute=0, second=0, microsecond=0)
            .isoformat()
        )
        bucket = buckets[key]
        bucket["requests"] += 1
        bucket["successes"] += int(row.success)
        bucket["errors"] += int(not row.success)
        bucket["latency_sum_ms"] += float(row.latency_ms or 0)
        if row.error_class:
            error_classes[row.error_class] += 1
    series = []
    for timestamp, bucket in sorted(buckets.items()):
        requests = bucket["requests"]
        series.append(
            {
                "timestamp": timestamp,
                "requests": requests,
                "successes": bucket["successes"],
                "errors": bucket["errors"],
                "average_latency_ms": bucket["latency_sum_ms"] / requests
                if requests
                else None,
            }
        )
    return {
        "window_start": since,
        "request_count": total,
        "success_count": successes,
        "error_count": total - successes,
        "success_rate": successes / total if total else None,
        "average_latency_ms": sum(latencies) / total if total else None,
        "p95_latency_ms": p95,
        "error_classes": dict(error_classes),
        "series": series,
    }


@router.get("/projects/{project_id}/monitoring/service")
def service_metrics(
    project_id: int,
    endpoint_id: int | None = None,
    hours: int = Query(default=24, ge=1, le=24 * 90),
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    if endpoint_id is not None:
        get_owned(db, Endpoint, endpoint_id, project_id, "Endpoint")
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    metrics = _service_metrics(db, project_id, endpoint_id, since)
    metrics["endpoint_id"] = endpoint_id
    if endpoint_id is None:
        endpoints = db.scalars(
            select(Endpoint)
            .where(Endpoint.project_id == project_id)
            .order_by(Endpoint.id)
        ).all()
        metrics["endpoints"] = [endpoint_out(row) for row in endpoints]
    return metrics


@router.get("/projects/{project_id}/monitoring/data")
def data_monitoring_summary(
    project_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    datasets = (
        db.scalar(
            select(func.count())
            .select_from(Dataset)
            .where(Dataset.project_id == project_id)
        )
        or 0
    )
    versions = (
        db.scalar(
            select(func.count())
            .select_from(DatasetVersion)
            .where(DatasetVersion.project_id == project_id)
        )
        or 0
    )
    checks = (
        db.scalar(
            select(func.count())
            .select_from(QualityCheck)
            .where(QualityCheck.project_id == project_id)
        )
        or 0
    )
    failed_checks = (
        db.scalar(
            select(func.count())
            .select_from(QualityCheck)
            .where(
                QualityCheck.project_id == project_id,
                QualityCheck.result == QualityResult.FAIL,
            )
        )
        or 0
    )
    latest_check = db.scalar(
        select(QualityCheck)
        .where(QualityCheck.project_id == project_id)
        .order_by(QualityCheck.id.desc())
    )
    return {
        "dataset_count": datasets,
        "dataset_version_count": versions,
        "quality_check_count": checks,
        "failed_quality_check_count": failed_checks,
        "latest_quality_status": latest_check.result.value if latest_check else None,
        "latest_quality_checked_at": latest_check.created_at if latest_check else None,
    }


@router.get("/projects/{project_id}/monitoring/models")
def model_monitoring_summary(
    project_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    models = db.scalars(
        select(ModelVersion).where(ModelVersion.project_id == project_id)
    ).all()
    endpoints = db.scalars(
        select(Endpoint).where(Endpoint.project_id == project_id)
    ).all()
    latest_drift = db.scalar(
        select(DriftRun)
        .where(DriftRun.project_id == project_id)
        .order_by(DriftRun.id.desc())
    )
    lifecycle_counts = Counter(
        model.lifecycle.value
        if hasattr(model.lifecycle, "value")
        else str(model.lifecycle)
        for model in models
    )
    return {
        "model_version_count": len(models),
        "lifecycle_counts": dict(lifecycle_counts),
        "endpoint_count": len(endpoints),
        "ready_endpoint_count": sum(
            endpoint.status == "ready" for endpoint in endpoints
        ),
        "total_requests": sum(endpoint.request_count or 0 for endpoint in endpoints),
        "total_errors": sum(endpoint.error_count or 0 for endpoint in endpoints),
        "latest_drift_status": latest_drift.overall_status if latest_drift else None,
        "latest_drift_run_id": latest_drift.id if latest_drift else None,
        "latest_drift_finished_at": latest_drift.finished_at if latest_drift else None,
    }
