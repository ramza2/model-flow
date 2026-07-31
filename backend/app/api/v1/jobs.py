from __future__ import annotations

from fastapi import APIRouter, Depends, Query
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
from app.core.config import settings
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import (
    Dataset,
    DatasetSplit,
    DatasetVersion,
    JobStatus,
    QualityCheck,
    QualityResult,
    QualityRule,
    TrainingJob,
)
from app.db.session import get_db
from app.schemas.v1 import JobCloneRequest, JobCreate

router = APIRouter(tags=["training-jobs"])


def _validate_job_source(
    db: Session, project_id: int, body: JobCreate
) -> tuple[Dataset, DatasetVersion | None]:
    dataset = get_owned(db, Dataset, body.dataset_id, project_id, "Dataset")
    version = None
    if body.dataset_version_id is not None:
        version = get_owned(
            db,
            DatasetVersion,
            body.dataset_version_id,
            project_id,
            "Dataset version",
        )
        if version.dataset_id != dataset.id:
            raise friendly(
                400, "Dataset version does not belong to the selected dataset."
            )
    elif dataset.latest_version:
        version = db.scalar(
            select(DatasetVersion).where(
                DatasetVersion.dataset_id == dataset.id,
                DatasetVersion.version == dataset.latest_version,
            )
        )
    columns = loads(version.columns_json if version else dataset.columns_json, [])
    if body.target_column not in columns:
        raise friendly(
            400,
            f"Target column '{body.target_column}' is not in the dataset.",
            f"Available columns: {', '.join(columns)}",
        )
    if body.split_id is not None:
        split = get_owned(db, DatasetSplit, body.split_id, project_id, "Dataset split")
        if not version or split.dataset_version_id != version.id:
            raise friendly(
                400, "Dataset split does not belong to the selected version."
            )
    if version and not settings.allow_train_on_quality_fail:
        latest_check = db.scalar(
            select(QualityCheck)
            .where(QualityCheck.dataset_version_id == version.id)
            .order_by(QualityCheck.id.desc())
        )
        blocking_rules = db.scalar(
            select(QualityRule.id).where(
                QualityRule.project_id == project_id,
                QualityRule.block_training_on_fail.is_(True),
            )
        )
        if (
            latest_check
            and latest_check.result == QualityResult.FAIL
            and blocking_rules
        ):
            raise friendly(
                409,
                "Training is blocked by the latest quality check.",
                "Resolve the failing quality rules or ask an administrator to override the policy.",
            )
    return dataset, version


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


@router.get("/projects/{project_id}/jobs")
def list_jobs(
    project_id: int,
    status: JobStatus | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
    db: Session = Depends(get_db),
):
    statement = select(TrainingJob).where(TrainingJob.project_id == project_id)
    if status is not None:
        statement = statement.where(TrainingJob.status == status)
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
    _, version = _validate_job_source(db, project_id, body)
    job = _new_job(body, project_id, auth.user.id, version)
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
    _, version = _validate_job_source(db, project_id, body)
    job = _new_job(body, project_id, auth.user.id, version)
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
    _, version = _validate_job_source(db, project_id, job_body)
    job = _new_job(job_body, project_id, auth.user.id, version)
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
