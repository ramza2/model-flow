"""Full retraining helpers — copy configuration from a succeeded job onto a new dataset version."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import JobStatus, TrainingJob
from app.schemas.v1 import JobCreate, JobRetrainRequest, RetrainRequest
from app.services.training_validation import ValidatedTrainingConfig, validate_training_config


class RetrainConfigError(Exception):
    def __init__(self, status_code: int, detail: str, hint: str | None = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.hint = hint


def _loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def validate_retrain_source(source: TrainingJob) -> None:
    if source.status != JobStatus.succeeded:
        raise RetrainConfigError(
            409,
            "Only succeeded training jobs can be retrained.",
            "Wait for the source job to finish successfully or choose another job.",
        )


def build_retrain_job_create(source: TrainingJob, body: JobRetrainRequest) -> JobCreate:
    """Build a fresh JobCreate from a succeeded source job and retrain request.

    Runtime fields are not copied. The source job's saved split is never reused
    unless the caller explicitly provides a split for the target dataset version.
    """

    validate_retrain_source(source)
    return JobCreate(
        name=body.name.strip(),
        description=body.description if body.description is not None else source.description,
        dataset_id=source.dataset_id,
        dataset_version_id=body.dataset_version_id,
        split_id=body.split_id,
        target_column=source.target_column,
        problem_type=source.problem_type,
        algorithm=source.algorithm,
        hyperparameters=_loads(source.hyperparameters_json, {}),
        preprocessing=_loads(source.preprocessing_json, {}),
        feature_columns=_loads(source.feature_columns_json, []),
        metrics_config=_loads(source.metrics_config_json, []),
        resources=_loads(source.resource_json, {}),
        random_seed=source.random_seed,
        train_ratio=source.train_ratio,
        val_ratio=source.val_ratio,
        test_ratio=source.test_ratio,
        max_retries=source.max_retries,
    )


def legacy_request_to_job_retrain(source: TrainingJob, body: RetrainRequest) -> JobRetrainRequest:
    """Map the deprecated RetrainRequest payload onto JobRetrainRequest."""

    overrides = dict(body.overrides)
    dataset_version_id = body.dataset_version_id
    if dataset_version_id is None:
        raw = overrides.get("dataset_version_id")
        if raw is not None:
            dataset_version_id = int(raw)
    if dataset_version_id is None:
        dataset_version_id = source.dataset_version_id
    if dataset_version_id is None:
        raise RetrainConfigError(
            422,
            "dataset_version_id is required when the source job has no dataset version.",
            "Provide dataset_version_id in the request body or overrides.",
        )

    split_id = overrides.get("split_id")
    if split_id is not None:
        split_id = int(split_id)

    return JobRetrainRequest(
        dataset_version_id=dataset_version_id,
        split_id=split_id,
        name=body.name or f"{source.name} (retrain)",
        description=source.description or "",
    )


def prepare_retrain_job(
    db: Session,
    project_id: int,
    source: TrainingJob,
    body: JobRetrainRequest,
) -> ValidatedTrainingConfig:
    """Validate source job and target dataset version for a full retrain."""

    retrain_body = build_retrain_job_create(source, body)
    return validate_training_config(db, project_id, retrain_body)
