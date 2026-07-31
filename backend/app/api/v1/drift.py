from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, drift_out, dumps, friendly, get_owned
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import DatasetVersion, DriftRun, Endpoint, JobStatus
from app.db.session import get_db
from app.schemas.v1 import DriftCreate

router = APIRouter(tags=["drift"])


@router.post("/projects/{project_id}/drift-runs", status_code=202)
def create_drift_run(
    project_id: int,
    body: DriftCreate,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    if body.reference_version_id == body.current_version_id:
        raise friendly(400, "Reference and current dataset versions must be different.")
    get_owned(
        db, DatasetVersion, body.reference_version_id, project_id, "Dataset version"
    )
    get_owned(
        db, DatasetVersion, body.current_version_id, project_id, "Dataset version"
    )
    if body.endpoint_id is not None:
        get_owned(db, Endpoint, body.endpoint_id, project_id, "Endpoint")
    row = DriftRun(
        project_id=project_id,
        reference_version_id=body.reference_version_id,
        current_version_id=body.current_version_id,
        endpoint_id=body.endpoint_id,
        status=JobStatus.pending,
        thresholds_json=dumps(body.thresholds),
        created_by=auth.user.id,
    )
    db.add(row)
    db.flush()
    audit_event(db, auth, "drift_run.create", "drift_run", row.id)
    db.commit()
    db.refresh(row)
    return drift_out(row)


@router.get("/projects/{project_id}/drift-runs")
def list_drift_runs(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(DriftRun)
        .where(DriftRun.project_id == project_id)
        .order_by(DriftRun.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [drift_out(row) for row in rows]


@router.get("/projects/{project_id}/drift-runs/{run_id}")
def get_drift_run(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    return drift_out(get_owned(db, DriftRun, run_id, project_id, "Drift run"))
