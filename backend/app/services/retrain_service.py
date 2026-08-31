"""Full retraining helpers — copy configuration from a succeeded job onto a new dataset version."""

from __future__ import annotations

import json
from typing import Any

from app.db.models import JobStatus, TrainingJob
from app.schemas.v1 import JobCreate, JobRetrainRequest


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
