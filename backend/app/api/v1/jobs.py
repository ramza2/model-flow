from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dumps,
    friendly,
    get_owned,
    job_out,
    loads,
)
from app.core.deps import get_auth, require_project_perm
from app.core.rbac import Permission
from app.db.models import DatasetVersion, JobStatus, TrainingJob
from app.db.session import get_db
from app.schemas.v1 import JobCloneRequest, JobCreate, JobRetrainRequest
from app.services.algorithm_catalog import list_algorithms
from app.services.retrain_service import RetrainConfigError, build_retrain_job_create
from app.services.training_validation import (
    TrainingConfigError,
    resolve_problem_type_for_version,
    validate_training_config,
)

router = APIRouter(tags=["training-jobs"])


class ResolveProblemTypeRequest(BaseModel):
    dataset_id: int
    dataset_version_id: int | None = None
    target_column: str = Field(min_length=1, max_length=200)
    problem_type: str = "auto"


def _raise_config_error(exc: TrainingConfigError) -> None:
    raise friendly(exc.status_code, exc.detail, exc.hint) from exc


def _raise_retrain_error(exc: RetrainConfigError) -> None:
    raise friendly(exc.status_code, exc.detail, exc.hint) from exc


def _new_job(
    body: JobCreate, project_id: int, user_id: int, version: DatasetVersion | None
) -> TrainingJob:
    return TrainingJob(
        project_id=project_id,
        dataset_id=body.dataset_id,
        dataset_version_id=version.id if version else None,
        split_id=body.split_id,
        name=body.name.strip(),
        description=body.description,
        target_column=body.target_column,
        problem_type=body.problem_type,
        algorithm=body.algorithm,
        hyperparameters_json=dumps(body.hyperparameters),
        preprocessing_json=dumps(body.preprocessing),
        feature_columns_json=dumps(body.feature_columns),
        metrics_config_json=dumps(body.metrics_config),
        resource_json=dumps(body.resources),
        random_seed=body.random_seed,
        train_ratio=body.train_ratio,
        val_ratio=body.val_ratio,
        test_ratio=body.test_ratio,
        max_retries=body.max_retries,
        status=JobStatus.pending,
        logs="Queued for training.\n",
        created_by=user_id,
    )


def _body_from_job(
    job: TrainingJob, *, name: str | None = None, overrides: dict | None = None
) -> JobCreate:
    values = {
        "name": name or f"{job.name} (clone)",
        "dataset_id": job.dataset_id,
        "dataset_version_id": job.dataset_version_id,
        "split_id": job.split_id,
        "description": job.description,
        "target_column": job.target_column,
        "problem_type": job.problem_type,
        "algorithm": job.algorithm,
        "hyperparameters": loads(job.hyperparameters_json, {}),
        "preprocessing": loads(job.preprocessing_json, {}),
        "feature_columns": loads(job.feature_columns_json, []),
        "metrics_config": loads(job.metrics_config_json, []),
        "resources": loads(job.resource_json, {}),
        "random_seed": job.random_seed,
        "train_ratio": job.train_ratio,
        "val_ratio": job.val_ratio,
        "test_ratio": job.test_ratio,
        "max_retries": job.max_retries,
    }
    values.update(overrides or {})
    return JobCreate.model_validate(values)


@router.get("/training/algorithms")
def get_algorithm_catalog(
    problem_type: str | None = Query(default=None),
    _auth=Depends(get_auth),
):
    """Shared algorithm catalog used by Job Create UI and validation."""
    return {"algorithms": list_algorithms(problem_type)}


@router.get("/projects/{project_id}/training/algorithms")
def get_project_algorithm_catalog(
    project_id: int,
    problem_type: str | None = Query(default=None),
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
):
    return {"algorithms": list_algorithms(problem_type)}


@router.post("/projects/{project_id}/training/resolve-problem-type")
def resolve_problem_type(
    project_id: int,
    body: ResolveProblemTypeRequest,
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
    db: Session = Depends(get_db),
):
    try:
        return resolve_problem_type_for_version(
            db,
            project_id,
            dataset_id=body.dataset_id,
            dataset_version_id=body.dataset_version_id,
            target_column=body.target_column,
            problem_type=body.problem_type,
        )
    except TrainingConfigError as exc:
        _raise_config_error(exc)


@router.get("/projects/{project_id}/jobs")
def list_jobs(
    project_id: int,
    status: JobStatus | None = None,
    retrain_source_job_id: int | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
    db: Session = Depends(get_db),
):
    statement = select(TrainingJob).where(TrainingJob.project_id == project_id)
    if status is not None:
        statement = statement.where(TrainingJob.status == status)
    if retrain_source_job_id is not None:
        get_owned(db, TrainingJob, retrain_source_job_id, project_id, "Training job")
        statement = statement.where(
            TrainingJob.retrain_source_job_id == retrain_source_job_id
        )
    rows = db.scalars(
        statement.order_by(TrainingJob.id.desc()).offset(skip).limit(limit)
    ).all()
    return [job_out(row) for row in rows]


@router.post("/projects/{project_id}/jobs", status_code=201)
def create_job(
    project_id: int,
    body: JobCreate,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    try:
        validated = validate_training_config(db, project_id, body)
    except TrainingConfigError as exc:
        _raise_config_error(exc)
    job = _new_job(validated.body, project_id, auth.user.id, validated.version)
    db.add(job)
    db.flush()
    audit_event(db, auth, "training_job.create", "training_job", job.id)
    db.commit()
    db.refresh(job)
    return job_out(job)


@router.get("/projects/{project_id}/jobs/{job_id}")
def get_job(
    project_id: int,
    job_id: int,
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
    db: Session = Depends(get_db),
):
    return job_out(get_owned(db, TrainingJob, job_id, project_id, "Training job"))


@router.post("/projects/{project_id}/jobs/{job_id}/cancel")
def cancel_job(
    project_id: int,
    job_id: int,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    job = get_owned(db, TrainingJob, job_id, project_id, "Training job")
    if job.status in {JobStatus.pending, JobStatus.queued}:
        job.status = JobStatus.cancelled
        job.finished_at = datetime.now(timezone.utc)
    elif job.status == JobStatus.running:
        job.status = JobStatus.cancel_requested
    else:
        raise friendly(409, f"A {job.status.value} job cannot be cancelled.")
    job.logs = (job.logs or "") + "Cancellation requested.\n"
    audit_event(db, auth, "training_job.cancel", "training_job", job.id)
    db.commit()
    return job_out(job)


@router.post("/projects/{project_id}/jobs/{job_id}/retry", status_code=201)
def retry_job(
    project_id: int,
    job_id: int,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, TrainingJob, job_id, project_id, "Training job")
    if source.status not in {JobStatus.failed, JobStatus.cancelled}:
        raise friendly(409, "Only failed or cancelled jobs can be retried.")
    if source.retry_count >= source.max_retries:
        raise friendly(409, "This job has reached its retry limit.")
    body = _body_from_job(
        source, name=f"{source.name} (retry {source.retry_count + 1})"
    )
    try:
        validated = validate_training_config(db, project_id, body)
    except TrainingConfigError as exc:
        _raise_config_error(exc)
    job = _new_job(validated.body, project_id, auth.user.id, validated.version)
    job.parent_job_id = source.id
    job.retry_count = source.retry_count + 1
    db.add(job)
    db.flush()
    audit_event(
        db,
        auth,
        "training_job.retry",
        "training_job",
        job.id,
        after={"parent_job_id": source.id},
    )
    db.commit()
    db.refresh(job)
    return job_out(job)


@router.post("/projects/{project_id}/jobs/{job_id}/clone", status_code=201)
def clone_job(
    project_id: int,
    job_id: int,
    body: JobCloneRequest | None = None,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    body = body or JobCloneRequest()
    source = get_owned(db, TrainingJob, job_id, project_id, "Training job")
    try:
        job_body = _body_from_job(source, name=body.name, overrides=body.overrides)
    except Exception as exc:
        raise friendly(
            422,
            "Job overrides are invalid.",
            "Use supported job fields and valid value types.",
        ) from exc
    try:
        validated = validate_training_config(db, project_id, job_body)
    except TrainingConfigError as exc:
        _raise_config_error(exc)
    job = _new_job(validated.body, project_id, auth.user.id, validated.version)
    job.parent_job_id = source.id
    db.add(job)
    db.flush()
    audit_event(
        db,
        auth,
        "training_job.clone",
        "training_job",
        job.id,
        after={"parent_job_id": source.id},
    )
    db.commit()
    db.refresh(job)
    return job_out(job)


@router.post("/projects/{project_id}/jobs/{job_id}/retrain", status_code=201)
def retrain_job(
    project_id: int,
    job_id: int,
    body: JobRetrainRequest,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, TrainingJob, job_id, project_id, "Training job")
    try:
        retrain_body = build_retrain_job_create(source, body)
    except RetrainConfigError as exc:
        _raise_retrain_error(exc)
    try:
        validated = validate_training_config(db, project_id, retrain_body)
    except TrainingConfigError as exc:
        _raise_config_error(exc)
    job = _new_job(validated.body, project_id, auth.user.id, validated.version)
    job.retrain_source_job_id = source.id
    db.add(job)
    db.flush()
    audit_event(
        db,
        auth,
        "training_job.retrain",
        "training_job",
        job.id,
        after={
            "retrain_source_job_id": source.id,
            "dataset_version_id": body.dataset_version_id,
            "split_id": body.split_id,
        },
    )
    db.commit()
    db.refresh(job)
    return job_out(job)
