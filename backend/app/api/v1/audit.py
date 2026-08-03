from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.v1.common import friendly, loads
from app.core.deps import AuthContext, require_project_perm, require_system_admin
from app.core.rbac import Permission
from app.db.models import (
    Alert,
    AuditLog,
    BatchInferenceJob,
    DataImportJob,
    DataSource,
    Dataset,
    DatasetSplit,
    DatasetVersion,
    DriftRun,
    Endpoint,
    ModelVersion,
    Pipeline,
    PipelineRun,
    PipelineVersion,
    ProjectMembership,
    QualityCheck,
    QualityRule,
    RetrainTrigger,
    TrainingJob,
)
from app.db.session import get_db

router = APIRouter(tags=["audit"])


def _out(row: AuditLog) -> dict[str, Any]:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "user_email": row.user_email,
        "action": row.action,
        "resource_type": row.resource_type,
        "resource_id": row.resource_id,
        "success": row.success,
        "ip_address": row.ip_address,
        "request_id": row.request_id,
        "before": loads(row.before_summary, None),
        "after": loads(row.after_summary, None),
        "failure_reason": row.failure_reason,
        "created_at": row.created_at,
    }


def _filtered(
    statement,
    *,
    action: str | None,
    resource_type: str | None,
    resource_id: str | None,
    user_id: int | None,
    date_from: datetime | None,
    date_to: datetime | None,
):
    if action:
        statement = statement.where(AuditLog.action == action)
    if resource_type:
        statement = statement.where(AuditLog.resource_type == resource_type)
    if resource_id:
        statement = statement.where(AuditLog.resource_id == resource_id)
    if user_id is not None:
        statement = statement.where(AuditLog.user_id == user_id)
    if date_from:
        statement = statement.where(AuditLog.created_at >= date_from)
    if date_to:
        statement = statement.where(AuditLog.created_at <= date_to)
    return statement


def _project_scope(db: Session, project_id: int):
    model_types = {
        "project_membership": ProjectMembership,
        "data_source": DataSource,
        "data_import_job": DataImportJob,
        "dataset": Dataset,
        "dataset_version": DatasetVersion,
        "quality_rule": QualityRule,
        "quality_check": QualityCheck,
        "dataset_split": DatasetSplit,
        "training_job": TrainingJob,
        "pipeline": Pipeline,
        "pipeline_version": PipelineVersion,
        "pipeline_run": PipelineRun,
        "model_version": ModelVersion,
        "endpoint": Endpoint,
        "batch_inference_job": BatchInferenceJob,
        "drift_run": DriftRun,
        "retrain_trigger": RetrainTrigger,
        "alert": Alert,
    }
    clauses = [
        (AuditLog.resource_type == "project")
        & (AuditLog.resource_id == str(project_id))
    ]
    for resource_type, model in model_types.items():
        ids = [
            str(value)
            for value in db.scalars(
                select(model.id).where(model.project_id == project_id)
            ).all()
        ]
        if ids:
            clauses.append(
                (AuditLog.resource_type == resource_type)
                & AuditLog.resource_id.in_(ids)
            )
    return or_(*clauses)


@router.get("/admin/audit")
def search_system_audit(
    action: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    user_id: int | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    statement = _filtered(
        select(AuditLog),
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        user_id=user_id,
        date_from=date_from,
        date_to=date_to,
    )
    rows = db.scalars(
        statement.order_by(AuditLog.id.desc()).offset(skip).limit(limit)
    ).all()
    return [_out(row) for row in rows]


@router.get("/admin/audit/{audit_id}")
def get_system_audit(
    audit_id: int,
    _: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    row = db.get(AuditLog, audit_id)
    if not row:
        raise friendly(404, f"Audit event {audit_id} was not found.")
    return _out(row)


@router.get("/projects/{project_id}/audit")
def search_project_audit(
    project_id: int,
    action: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    user_id: int | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.AUDIT_READ)),
    db: Session = Depends(get_db),
):
    statement = _filtered(
        select(AuditLog).where(_project_scope(db, project_id)),
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        user_id=user_id,
        date_from=date_from,
        date_to=date_to,
    )
    rows = db.scalars(
        statement.order_by(AuditLog.id.desc()).offset(skip).limit(limit)
    ).all()
    return [_out(row) for row in rows]


@router.get("/projects/{project_id}/audit/{audit_id}")
def get_project_audit(
    project_id: int,
    audit_id: int,
    _=Depends(require_project_perm(Permission.AUDIT_READ)),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(AuditLog).where(AuditLog.id == audit_id, _project_scope(db, project_id))
    )
    if not row:
        raise friendly(404, f"Audit event {audit_id} was not found in this project.")
    return _out(row)
