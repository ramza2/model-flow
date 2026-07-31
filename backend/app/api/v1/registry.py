from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dumps,
    friendly,
    get_owned,
    loads,
    model_version_out,
)
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import JobStatus, ModelLifecycle, ModelVersion, TrainingJob
from app.db.session import get_db
from app.schemas.v1 import ApprovalRequest, ModelRegisterRequest, RollbackRequest
from app.services import mlflow_service

router = APIRouter(tags=["model-registry"])


@router.get("/projects/{project_id}/models")
def list_model_versions(
    project_id: int,
    lifecycle: ModelLifecycle | None = None,
    name: str | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.REGISTRY_READ)),
    db: Session = Depends(get_db),
):
    statement = select(ModelVersion).where(ModelVersion.project_id == project_id)
    if lifecycle is not None:
        statement = statement.where(ModelVersion.lifecycle == lifecycle)
    if name:
        statement = statement.where(ModelVersion.name == name)
    rows = db.scalars(
        statement.order_by(ModelVersion.id.desc()).offset(skip).limit(limit)
    ).all()
    return [model_version_out(row) for row in rows]


@router.post("/projects/{project_id}/models/register", status_code=201)
def register_model(
    project_id: int,
    body: ModelRegisterRequest,
    access=Depends(require_project_perm(Permission.REGISTRY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    job = None
    run_id = body.run_id
    model_uri = None
    dataset_version_id = None
    metrics: dict = {}
    if body.training_job_id is not None:
        job = get_owned(
            db, TrainingJob, body.training_job_id, project_id, "Training job"
        )
        if (
            job.status != JobStatus.succeeded
            or not job.mlflow_run_id
            or not job.model_uri
        ):
            raise friendly(
                409,
                "Only a succeeded training job with an MLflow model can be registered.",
            )
        if run_id and run_id != job.mlflow_run_id:
            raise friendly(400, "run_id does not match the selected training job.")
        run_id = job.mlflow_run_id
        model_uri = job.model_uri
        dataset_version_id = job.dataset_version_id
        metrics = loads(job.metrics_json, {})
    try:
        run = mlflow_service.get_run(str(run_id))
        experiment_id = mlflow_service.ensure_experiment(f"project-{project_id}")
    except Exception as exc:
        raise friendly(404, f"MLflow run '{run_id}' was not found.") from exc
    if str(run.get("experiment_id")) != str(experiment_id):
        raise friendly(400, "The MLflow run does not belong to this project.")
    mlflow_name = (
        body.name
        if body.name.startswith(f"project-{project_id}-")
        else f"project-{project_id}-{body.name}"
    )
    try:
        registered = mlflow_service.register_model(
            str(run_id), mlflow_name, body.artifact_path
        )
    except Exception as exc:
        raise friendly(
            502,
            "MLflow could not register this model.",
            "Confirm the run logged the requested model artifact.",
        ) from exc
    version = str(registered["version"])
    existing = db.scalar(
        select(ModelVersion).where(
            ModelVersion.project_id == project_id,
            ModelVersion.name == body.name,
            ModelVersion.version == version,
        )
    )
    if existing:
        raise friendly(409, "This model version is already registered in ModelFlow.")
    row = ModelVersion(
        project_id=project_id,
        name=body.name,
        version=version,
        lifecycle=ModelLifecycle.CANDIDATE,
        mlflow_model_name=mlflow_name,
        mlflow_version=version,
        mlflow_run_id=str(run_id),
        model_uri=f"models:/{mlflow_name}/{version}" if registered else model_uri,
        metrics_json=dumps(metrics or run.get("metrics", {})),
        metadata_json=dumps(body.metadata),
        dataset_version_id=dataset_version_id,
        training_job_id=job.id if job else None,
        gate_results_json=dumps(body.gate_results),
        gates_passed=body.gates_passed,
        created_by=auth.user.id,
    )
    db.add(row)
    db.flush()
    audit_event(db, auth, "model.register", "model_version", row.id)
    db.commit()
    db.refresh(row)
    return model_version_out(row)


@router.get("/projects/{project_id}/models/{model_version_id}")
def get_model_version(
    project_id: int,
    model_version_id: int,
    _=Depends(require_project_perm(Permission.REGISTRY_READ)),
    db: Session = Depends(get_db),
):
    return model_version_out(
        get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    )


@router.post("/projects/{project_id}/models/{model_version_id}/request-approval")
def request_approval(
    project_id: int,
    model_version_id: int,
    body: ApprovalRequest | None = None,
    access=Depends(require_project_perm(Permission.REGISTRY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    body = body or ApprovalRequest()
    row = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if row.lifecycle not in {
        ModelLifecycle.CANDIDATE,
        ModelLifecycle.VALIDATING,
        ModelLifecycle.REJECTED,
    }:
        raise friendly(409, f"A {row.lifecycle.value} model cannot request approval.")
    row.lifecycle = ModelLifecycle.PENDING_APPROVAL
    row.approval_comment = body.comment
    audit_event(db, auth, "model.request_approval", "model_version", row.id)
    db.commit()
    return model_version_out(row)


@router.post("/projects/{project_id}/models/{model_version_id}/approve")
def approve_model(
    project_id: int,
    model_version_id: int,
    body: ApprovalRequest | None = None,
    access=Depends(require_project_perm(Permission.REGISTRY_APPROVE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    body = body or ApprovalRequest()
    row = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if row.lifecycle != ModelLifecycle.PENDING_APPROVAL:
        raise friendly(409, "Only a model pending approval can be approved.")
    if not row.gates_passed:
        raise friendly(
            409,
            "Model approval gates have not passed.",
            "Review gate_results and rerun validation before approval.",
        )
    row.lifecycle = ModelLifecycle.APPROVED
    row.approval_comment = body.comment
    row.approved_by = auth.user.id
    row.approved_at = datetime.now(timezone.utc)
    audit_event(db, auth, "model.approve", "model_version", row.id)
    db.commit()
    return model_version_out(row)


@router.post("/projects/{project_id}/models/{model_version_id}/reject")
def reject_model(
    project_id: int,
    model_version_id: int,
    body: ApprovalRequest | None = None,
    access=Depends(require_project_perm(Permission.REGISTRY_APPROVE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    body = body or ApprovalRequest()
    row = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if row.lifecycle != ModelLifecycle.PENDING_APPROVAL:
        raise friendly(409, "Only a model pending approval can be rejected.")
    row.lifecycle = ModelLifecycle.REJECTED
    row.approval_comment = body.comment
    row.approved_by = auth.user.id
    row.approved_at = datetime.now(timezone.utc)
    audit_event(db, auth, "model.reject", "model_version", row.id)
    db.commit()
    return model_version_out(row)


@router.post("/projects/{project_id}/models/{model_version_id}/promote-production")
def promote_production(
    project_id: int,
    model_version_id: int,
    access=Depends(require_project_perm(Permission.REGISTRY_APPROVE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if row.lifecycle != ModelLifecycle.APPROVED:
        raise friendly(409, "Only an approved model can be promoted to production.")
    current_rows = db.scalars(
        select(ModelVersion).where(
            ModelVersion.project_id == project_id,
            ModelVersion.name == row.name,
            ModelVersion.lifecycle == ModelLifecycle.PRODUCTION,
        )
    ).all()
    for current in current_rows:
        current.lifecycle = ModelLifecycle.APPROVED
    row.lifecycle = ModelLifecycle.PRODUCTION
    audit_event(db, auth, "model.promote_production", "model_version", row.id)
    db.commit()
    return model_version_out(row)


@router.post("/projects/{project_id}/models/{model_version_id}/rollback")
def rollback_model(
    project_id: int,
    model_version_id: int,
    body: RollbackRequest | None = None,
    access=Depends(require_project_perm(Permission.REGISTRY_APPROVE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    body = body or RollbackRequest()
    current = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if current.lifecycle != ModelLifecycle.PRODUCTION:
        raise friendly(409, "Rollback must start from the current production model.")
    if body.model_version_id is not None:
        target = get_owned(
            db, ModelVersion, body.model_version_id, project_id, "Model version"
        )
    else:
        target = db.scalar(
            select(ModelVersion)
            .where(
                ModelVersion.project_id == project_id,
                ModelVersion.name == current.name,
                ModelVersion.lifecycle == ModelLifecycle.APPROVED,
                ModelVersion.id != current.id,
            )
            .order_by(ModelVersion.id.desc())
        )
    if (
        not target
        or target.name != current.name
        or target.lifecycle != ModelLifecycle.APPROVED
    ):
        raise friendly(409, "No approved rollback target is available.")
    current.lifecycle = ModelLifecycle.APPROVED
    target.lifecycle = ModelLifecycle.PRODUCTION
    audit_event(
        db,
        auth,
        "model.rollback",
        "model_version",
        target.id,
        after={"replaced_model_version_id": current.id},
    )
    db.commit()
    return model_version_out(target)


@router.post("/projects/{project_id}/models/{model_version_id}/archive")
def archive_model(
    project_id: int,
    model_version_id: int,
    access=Depends(require_project_perm(Permission.REGISTRY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if row.lifecycle == ModelLifecycle.PRODUCTION:
        raise friendly(
            409, "A production model must be replaced before it can be archived."
        )
    row.lifecycle = ModelLifecycle.ARCHIVED
    audit_event(db, auth, "model.archive", "model_version", row.id)
    db.commit()
    return model_version_out(row)
