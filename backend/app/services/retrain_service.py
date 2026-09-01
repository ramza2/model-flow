"""Full retraining helpers — copy configuration from a succeeded job onto a new dataset version."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import JobStatus, TrainingJob
from app.schemas.v1 import JobCreate, JobRetrainRequest, RetrainRequest
from app.services.target_columns import effective_target_columns_from_job
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


def build_job_create_from_source(
    source: TrainingJob,
    *,
    name: str | None = None,
    default_name_suffix: str = "clone",
    overrides: dict[str, Any] | None = None,
) -> JobCreate:
    """Copy a succeeded job's saved configuration into a JobCreate payload."""

    default_name = f"{source.name} ({default_name_suffix})"
    target_columns = effective_target_columns_from_job(source)
    values: dict[str, Any] = {
        "name": name or default_name,
        "dataset_id": source.dataset_id,
        "dataset_version_id": source.dataset_version_id,
        "split_id": source.split_id,
        "description": source.description,
        "target_column": target_columns[0],
        "target_columns": target_columns,
        "problem_type": source.problem_type,
        "algorithm": source.algorithm,
        "hyperparameters": _loads(source.hyperparameters_json, {}),
        "preprocessing": _loads(source.preprocessing_json, {}),
        "feature_columns": _loads(source.feature_columns_json, []),
        "metrics_config": _loads(source.metrics_config_json, []),
        "resources": _loads(source.resource_json, {}),
        "random_seed": source.random_seed,
        "train_ratio": source.train_ratio,
        "val_ratio": source.val_ratio,
        "test_ratio": source.test_ratio,
        "max_retries": source.max_retries,
    }
    values.update(overrides or {})
    return JobCreate.model_validate(values)


def build_retrain_job_create(source: TrainingJob, body: JobRetrainRequest) -> JobCreate:
    """Build a fresh JobCreate from a succeeded source job and retrain request.

    Runtime fields are not copied. The source job's saved split is never reused
    unless the caller explicitly provides a split for the target dataset version.
    """

    validate_retrain_source(source)
    target_columns = effective_target_columns_from_job(source)
    return JobCreate(
        name=body.name.strip(),
        description=body.description if body.description is not None else source.description,
        dataset_id=source.dataset_id,
        dataset_version_id=body.dataset_version_id,
        split_id=body.split_id,
        target_column=target_columns[0],
        target_columns=target_columns,
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


def prepare_legacy_retrain_job(
    db: Session,
    project_id: int,
    source: TrainingJob,
    body: RetrainRequest,
) -> ValidatedTrainingConfig:
    """Validate and build a legacy retrain job, preserving RetrainRequest overrides."""

    validate_retrain_source(source)

    overrides = dict(body.overrides)
    if body.dataset_version_id is not None:
        overrides["dataset_version_id"] = body.dataset_version_id

    if "dataset_id" in overrides:
        override_dataset_id = int(overrides["dataset_id"])
        if override_dataset_id != source.dataset_id:
            raise RetrainConfigError(
                400,
                "Retrain cannot target a different logical dataset.",
                "Use the same dataset as the source job or upload a new version instead.",
            )

    retrain_name = body.name or f"{source.name} (retrain)"
    target_version_id = overrides.get("dataset_version_id", source.dataset_version_id)
    if target_version_id is None:
        raise RetrainConfigError(
            422,
            "dataset_version_id is required when the source job has no dataset version.",
            "Provide dataset_version_id in the request body or overrides.",
        )

    if (
        target_version_id != source.dataset_version_id
        and "split_id" not in body.overrides
    ):
        overrides["split_id"] = None

    job_body = build_job_create_from_source(
        source,
        name=retrain_name,
        default_name_suffix="retrain",
        overrides=overrides,
    )
    return validate_training_config(db, project_id, job_body)


def prepare_retrain_job(
    db: Session,
    project_id: int,
    source: TrainingJob,
    body: JobRetrainRequest,
) -> ValidatedTrainingConfig:
    """Validate source job and target dataset version for a full retrain."""

    retrain_body = build_retrain_job_create(source, body)
    return validate_training_config(db, project_id, retrain_body)
