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


def _dtype_category(dtype_name: str | None) -> str:
    """Coarse dtype category for continued-training compatibility checks."""
    value = str(dtype_name or "").lower()
    if not value:
        return "unknown"
    if value in {"bool", "boolean"} or value.startswith("bool"):
        return "bool"
    if "datetime" in value or value in {"date", "timestamp"}:
        return "datetime"
    if value in {
        "object",
        "string",
        "str",
        "text",
        "category",
        "categorical",
    } or value.startswith("string"):
        return "string"
    if any(
        token in value
        for token in (
            "int",
            "float",
            "double",
            "number",
            "numeric",
            "decimal",
            "uint",
            "complex",
        )
    ):
        return "numeric"
    return "other"


def _dtypes_compatible(source_dtype: str | None, target_dtype: str | None) -> bool:
    source_cat = _dtype_category(source_dtype)
    target_cat = _dtype_category(target_dtype)
    if source_cat == "unknown" or target_cat == "unknown":
        # Missing metadata: do not invent compatibility; fail closed only on
        # known category mismatches when both sides are present.
        return True
    if source_cat == "numeric" and target_cat == "numeric":
        return True
    return source_cat == target_cat


def effective_source_feature_columns(
    source: TrainingJob,
    source_version: DatasetVersion,
) -> tuple[list[str], bool]:
    """Return (ordered feature names, explicit_selection).

    Empty ``feature_columns_json`` means implicit selection of all non-target
    columns from the source DatasetVersion (preserving column order).
    """
    explicit = [str(c) for c in _loads(source.feature_columns_json, [])]
    if explicit:
        return explicit, True
    columns = _loads(source_version.columns_json, [])
    if not isinstance(columns, list):
        columns = []
    targets = set(effective_target_columns_from_job(source))
    implied = [str(c) for c in columns if str(c) not in targets]
    return implied, False


def validate_continued_feature_contract(
    *,
    source: TrainingJob,
    source_version: DatasetVersion,
    target_version: DatasetVersion,
) -> None:
    expected_features, explicit = effective_source_feature_columns(
        source, source_version
    )
    if not expected_features:
        raise ContinuedTrainingError(
            422,
            "Source training job has no resolvable feature columns.",
            "Use Full Retrain if you need a different dataset/schema.",
        )

    target_columns = _loads(target_version.columns_json, [])
    if not isinstance(target_columns, list):
        target_columns = []
    target_column_names = [str(c) for c in target_columns]
    target_name_set = set(target_column_names)

    missing = [name for name in expected_features if name not in target_name_set]
    if missing:
        raise ContinuedTrainingError(
            422,
            "Target DatasetVersion is missing required source features: "
            + ", ".join(missing[:10]),
            "Use full retraining if you need a different dataset/schema.",
        )

    targets = effective_target_columns_from_job(source)
    for target_name in targets:
        if target_name not in target_name_set:
            raise ContinuedTrainingError(
                422,
                f"Target DatasetVersion is missing target column '{target_name}'.",
                "Use full retraining if you need a different dataset/schema.",
            )

    # Preserve source feature order: selected target columns must appear in the
    # same relative order as the source contract.
    positions = {name: index for index, name in enumerate(target_column_names)}
    ordered_positions = [positions[name] for name in expected_features]
    if ordered_positions != sorted(ordered_positions):
        raise ContinuedTrainingError(
            422,
            "Target DatasetVersion feature order is incompatible with the source contract.",
            "Use full retraining if you need a different dataset/schema.",
        )

    if not explicit:
        # Implicit selection: any new non-target column would change the training
        # contract under empty feature_columns semantics — reject.
        target_non_targets = [
            name for name in target_column_names if name not in set(targets)
        ]
        if target_non_targets != expected_features:
            raise ContinuedTrainingError(
                422,
                "Dataset feature schema changed. "
                "Use Full Retrain to adopt new features.",
                "Use Full Retrain if you need a different dataset/schema.",
            )

    source_dtypes = _loads(source_version.dtypes_json, {})
    target_dtypes = _loads(target_version.dtypes_json, {})
    if not isinstance(source_dtypes, dict):
        source_dtypes = {}
    if not isinstance(target_dtypes, dict):
        target_dtypes = {}

    for column in [*expected_features, *targets]:
        source_dtype = source_dtypes.get(column)
        target_dtype = target_dtypes.get(column)
        if source_dtype is None or target_dtype is None:
            continue
        if not _dtypes_compatible(str(source_dtype), str(target_dtype)):
            raise ContinuedTrainingError(
                422,
                f"Column '{column}' dtype changed from {source_dtype} to {target_dtype}. "
                "Use Full Retrain if you need a different dataset/schema.",
                "Use Full Retrain if you need a different dataset/schema.",
            )


def build_continued_job_create(
    source: TrainingJob,
    body: JobContinueRequest,
    *,
    target_version: DatasetVersion,
    expected_features: list[str],
) -> JobCreate:
    """Copy source configuration; never allow algorithm/preprocessing overrides.

    ``expected_features`` is the resolved source feature contract. Even when the
    source stored an empty feature_columns list (implicit all non-targets), the
    continued child freezes that concrete ordered feature list so the update
    DatasetVersion cannot silently expand the contract.
    """

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
            "feature_columns": list(expected_features),
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
    source_version = db.get(DatasetVersion, source.dataset_version_id)
    if source_version is None:
        raise ContinuedTrainingError(
            404,
            "Source DatasetVersion was not found.",
            "Use Full Retrain if you need a different dataset/schema.",
        )
    validate_continued_feature_contract(
        source=source,
        source_version=source_version,
        target_version=target_version,
    )
    expected_features, _ = effective_source_feature_columns(source, source_version)
    create_body = build_continued_job_create(
        source,
        body,
        target_version=target_version,
        expected_features=expected_features,
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
