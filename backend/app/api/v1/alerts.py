from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, enum_value, friendly, get_owned
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import Alert, AlertSeverity
from app.db.session import get_db

router = APIRouter(tags=["alerts"])


def _out(row: Alert) -> dict:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "alert_type": row.alert_type,
        "severity": enum_value(row.severity),
        "title": row.title,
        "message": row.message,
        "resource_type": row.resource_type,
        "resource_id": row.resource_id,
        "link_path": row.link_path,
        "assignee_id": row.assignee_id,
        "is_read": row.is_read,
        "is_resolved": row.is_resolved,
        "created_at": row.created_at,
        "resolved_at": row.resolved_at,
    }


@router.get("/projects/{project_id}/alerts")
def list_alerts(
    project_id: int,
    severity: AlertSeverity | None = None,
    is_read: bool | None = None,
    is_resolved: bool | None = None,
    alert_type: str | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    statement = select(Alert).where(Alert.project_id == project_id)
    if severity is not None:
        statement = statement.where(Alert.severity == severity)
    if is_read is not None:
        statement = statement.where(Alert.is_read == is_read)
    if is_resolved is not None:
        statement = statement.where(Alert.is_resolved == is_resolved)
    if alert_type is not None:
        statement = statement.where(Alert.alert_type == alert_type)
    rows = db.scalars(
        statement.order_by(Alert.id.desc()).offset(skip).limit(limit)
    ).all()
    return [_out(row) for row in rows]


@router.post("/projects/{project_id}/alerts/{alert_id}/read")
def mark_alert_read(
    project_id: int,
    alert_id: int,
    access=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = get_owned(db, Alert, alert_id, project_id, "Alert")
    row.is_read = True
    audit_event(db, auth, "alert.read", "alert", row.id)
    db.commit()
    return _out(row)


@router.post("/projects/{project_id}/alerts/{alert_id}/resolve")
def resolve_alert(
    project_id: int,
    alert_id: int,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = get_owned(db, Alert, alert_id, project_id, "Alert")
    if row.is_resolved:
        raise friendly(409, "Alert is already resolved.")
    row.is_resolved = True
    row.is_read = True
    row.resolved_at = datetime.now(timezone.utc)
    audit_event(db, auth, "alert.resolve", "alert", row.id)
    db.commit()
    return _out(row)
