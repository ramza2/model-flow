"""Phase 5.1 continued / incremental training helpers.

Distinct from full retrain (`retrain_source_job_id`):
continued training freezes fitted preprocessing and updates the estimator via
``partial_fit`` on a newer compatible DatasetVersion of the same Dataset.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import DatasetVersion, JobStatus, TrainingJob
from app.schemas.v1 import JobContinueRequest, JobCreate
from app.services.algorithm_catalog import get_algorithm
from app.services.retrain_service import build_job_create_from_source
from app.services.target_columns import effective_target_columns_from_job
from app.services.training_validation import ValidatedTrainingConfig, validate_training_config


class ContinuedTrainingError(Exception):
    def __init__(self, status_code: int, detail: str, hint: str | None = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.hint = hint


@dataclass
class ValidatedContinuedJob:
    body: JobCreate
    version: DatasetVersion
    source: TrainingJob


def _loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def validate_continued_source(source: TrainingJob) -> None:
    if source.status != JobStatus.succeeded:
        raise ContinuedTrainingError(
            409,
            "Only succeeded training jobs can be continued.",
            "Wait for the source job to finish successfully or choose another job.",
        )
    if not source.model_uri:
        raise ContinuedTrainingError(
            409,
            "The source training job has no model artifact.",
            "Only jobs with a logged model URI can continue training.",
        )
    if not source.mlflow_run_id:
        raise ContinuedTrainingError(
            409,
            "The source training job has no MLflow run.",
            "Only jobs with an MLflow run can continue training.",
        )
    if source.dataset_version_id is None:
        raise ContinuedTrainingError(
            422,
            "The source training job has no immutable DatasetVersion lineage.",
            "Use Full Retrain for jobs without a DatasetVersion.",
        )

    targets = effective_target_columns_from_job(source)
    if len(targets) != 1:
        raise ContinuedTrainingError(
            422,
            "Continued training supports single-output models only.",
            "Use Full Retrain for multi-output models.",
        )

    spec = get_algorithm(source.algorithm)
    if spec is None or not spec.supports_continued_training:
        raise ContinuedTrainingError(
            422,
            f"Algorithm '{source.algorithm}' does not support continued training.",
            "Use Full Retrain instead, or train with an SGD algorithm that supports partial_fit.",
        )
    if spec.continued_training_strategy != "partial_fit":
        raise ContinuedTrainingError(
            422,
            f"Algorithm '{source.algorithm}' continued-training strategy is unsupported.",
            "Use Full Retrain instead.",
        )


def validate_continued_dataset_version(
    db: Session,
    *,
    source: TrainingJob,
    dataset_version_id: int,
) -> DatasetVersion:
    if source.dataset_version_id is None:
        raise ContinuedTrainingError(
            422,
            "The source training job has no immutable DatasetVersion lineage.",
            "Use Full Retrain instead.",
        )
    source_version = db.get(DatasetVersion, source.dataset_version_id)
    if source_version is None:
        raise ContinuedTrainingError(
            404,
            "Source DatasetVersion was not found.",
            "Use Full Retrain if you need a different dataset/schema.",
        )
    target = db.get(DatasetVersion, dataset_version_id)
    if target is None or target.project_id != source.project_id:
        raise ContinuedTrainingError(
            404,
            "Target DatasetVersion was not found.",
            "Use Full Retrain if you need a different dataset/schema.",
        )
    if target.dataset_id != source.dataset_id:
        raise ContinuedTrainingError(
            422,
            "Continued training requires a newer version of the same Dataset.",
            "Use full retraining if you need a different dataset/schema.",
        )
    if int(target.version) == int(source_version.version):
        raise ContinuedTrainingError(
            422,
            "Continued training requires a newer DatasetVersion than the source job.",
            "Select a newer DatasetVersion, or use Full Retrain.",
        )
    if int(target.version) < int(source_version.version):
        raise ContinuedTrainingError(
            422,
            "Continued training cannot use an older DatasetVersion.",
            "Select a newer DatasetVersion, or use Full Retrain.",
        )
    return target


def validate_continued_feature_contract(
    *,
    source: TrainingJob,
    target_version: DatasetVersion,
) -> None:
    source_features = [str(c) for c in _loads(source.feature_columns_json, [])]
    if not source_features:
        return
    columns = _loads(target_version.columns_json, [])
    column_names = {str(c) for c in columns} if isinstance(columns, list) else set()
    missing = [name for name in source_features if name not in column_names]
    if missing:
        raise ContinuedTrainingError(
            422,
            "Target DatasetVersion is missing required source features: "
            + ", ".join(missing[:10]),
            "Use full retraining if you need a different dataset/schema.",
        )
    targets = effective_target_columns_from_job(source)
    for target_name in targets:
        if target_name not in column_names:
            raise ContinuedTrainingError(
                422,
                f"Target DatasetVersion is missing target column '{target_name}'.",
                "Use full retraining if you need a different dataset/schema.",
            )


def build_continued_job_create(
    source: TrainingJob,
    body: JobContinueRequest,
    *,
    target_version: DatasetVersion,
) -> JobCreate:
    """Copy source configuration; never allow algorithm/preprocessing overrides."""

    return build_job_create_from_source(
        source,
        name=body.name,
        default_name_suffix="continued",
        overrides={
            "dataset_id": source.dataset_id,
            "dataset_version_id": target_version.id,
            "split_id": body.split_id,
            "description": (
                body.description if body.description is not None else source.description
            ),
            # Explicitly re-assert frozen config from source.
            "algorithm": source.algorithm,
            "problem_type": source.problem_type,
            "hyperparameters": _loads(source.hyperparameters_json, {}),
            "preprocessing": _loads(source.preprocessing_json, {}),
            "feature_columns": _loads(source.feature_columns_json, []),
            "random_seed": source.random_seed,
        },
    )


def prepare_continued_job(
    db: Session,
    project_id: int,
    source: TrainingJob,
    body: JobContinueRequest,
) -> ValidatedContinuedJob:
    if source.project_id != project_id:
        raise ContinuedTrainingError(404, "Training job was not found.")
    validate_continued_source(source)
    target_version = validate_continued_dataset_version(
        db, source=source, dataset_version_id=body.dataset_version_id
    )
    validate_continued_feature_contract(source=source, target_version=target_version)
    create_body = build_continued_job_create(
        source, body, target_version=target_version
    )
    # Reuse standard training validation (split ownership, ratios, etc.).
    validated: ValidatedTrainingConfig = validate_training_config(
        db, project_id, create_body
    )
    return ValidatedContinuedJob(
        body=validated.body,
        version=validated.version,
        source=source,
    )
