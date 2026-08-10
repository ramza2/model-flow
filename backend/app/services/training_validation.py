from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import (
    Dataset,
    DatasetSplit,
    DatasetVersion,
)
from app.schemas.v1 import JobCreate
from app.services import storage
from app.services.algorithm_catalog import (
    normalize_problem_type,
    resolve_algorithm,
    validate_hyperparameters,
)
from app.services.quality import get_training_quality_blockers
from app.services.training import _read_frame


class TrainingConfigError(Exception):
    def __init__(
        self, status_code: int, detail: str, hint: str | None = None
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.hint = hint


@dataclass
class ValidatedTrainingConfig:
    dataset: Dataset
    version: DatasetVersion | None
    resolved_problem_type: str
    algorithm: str
    hyperparameters: dict[str, Any]
    feature_columns: list[str]
    body: JobCreate


def _loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    import json

    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _get_owned(
    db: Session,
    model: type,
    object_id: int,
    project_id: int,
    label: str,
) -> Any:
    row = db.get(model, object_id)
    if row is None or getattr(row, "project_id", None) != project_id:
        raise TrainingConfigError(404, f"{label} was not found.")
    return row


def _load_frame(version: DatasetVersion | None, dataset: Dataset) -> pd.DataFrame:
    object_key = version.object_key if version else dataset.object_key
    data_format = (version.format if version else "csv") or "csv"
    if not object_key:
        raise TrainingConfigError(
            422,
            "Dataset file is missing.",
            "Re-upload the dataset before creating a training job.",
        )
    try:
        payload = storage.download_bytes(settings.minio_datasets_bucket, object_key)
    except Exception as exc:
        raise TrainingConfigError(
            422,
            "Dataset file could not be loaded.",
            "Check that the dataset object still exists in storage.",
        ) from exc
    try:
        return _read_frame(payload, data_format)
    except Exception as exc:
        raise TrainingConfigError(
            422,
            "Dataset file could not be parsed.",
            "Check the dataset format and contents.",
        ) from exc


def _resolve_version(
    db: Session,
    project_id: int,
    dataset: Dataset,
    dataset_version_id: int | None,
) -> DatasetVersion | None:
    if dataset_version_id is not None:
        version = _get_owned(
            db, DatasetVersion, dataset_version_id, project_id, "Dataset version"
        )
        if version.dataset_id != dataset.id:
            raise TrainingConfigError(
                400, "Dataset version does not belong to the selected dataset."
            )
        return version
    if dataset.latest_version:
        return db.scalar(
            select(DatasetVersion).where(
                DatasetVersion.dataset_id == dataset.id,
                DatasetVersion.version == dataset.latest_version,
            )
        )
    return None


def resolve_problem_type_for_version(
    db: Session,
    project_id: int,
    *,
    dataset_id: int,
    target_column: str,
    dataset_version_id: int | None = None,
    problem_type: str = "auto",
) -> dict[str, Any]:
    dataset = _get_owned(db, Dataset, dataset_id, project_id, "Dataset")
    version = _resolve_version(db, project_id, dataset, dataset_version_id)
    columns = _loads(version.columns_json if version else dataset.columns_json, [])
    if target_column not in columns:
        raise TrainingConfigError(
            422,
            f"Target column '{target_column}' is not in the dataset.",
            f"Available columns: {', '.join(columns)}",
        )
    frame = _load_frame(version, dataset)
    try:
        resolved = normalize_problem_type(problem_type, frame[target_column])
    except ValueError as exc:
        raise TrainingConfigError(422, str(exc)) from exc
    return {
        "requested_problem_type": problem_type,
        "resolved_problem_type": resolved,
        "target_column": target_column,
        "dataset_id": dataset.id,
        "dataset_version_id": version.id if version else None,
    }


def validate_training_config(
    db: Session, project_id: int, body: JobCreate
) -> ValidatedTrainingConfig:
    """Validate training inputs before creating a DB job row or queueing work."""
    dataset = _get_owned(db, Dataset, body.dataset_id, project_id, "Dataset")
    version = _resolve_version(db, project_id, dataset, body.dataset_version_id)

    columns = _loads(version.columns_json if version else dataset.columns_json, [])
    if body.target_column not in columns:
        raise TrainingConfigError(
            422,
            f"Target column '{body.target_column}' is not in the dataset.",
            f"Available columns: {', '.join(columns)}",
        )

    if body.split_id is not None:
        split = _get_owned(db, DatasetSplit, body.split_id, project_id, "Dataset split")
        split_version = db.get(DatasetVersion, split.dataset_version_id)
        if split_version is None or split_version.project_id != project_id:
            raise TrainingConfigError(
                400,
                "Dataset split does not belong to this project.",
                "Select a saved split from the same project.",
            )
        if split_version.dataset_id != dataset.id:
            raise TrainingConfigError(
                400,
                "Dataset split does not belong to the selected dataset.",
                "Choose a split created from this dataset, or clear the split selection.",
            )
        if not version or split.dataset_version_id != version.id:
            raise TrainingConfigError(
                400,
                "Dataset split does not belong to the selected version.",
                "Choose a split created from this dataset version, or clear the split selection.",
            )
        body = body.model_copy(
            update={
                "train_ratio": split.train_ratio,
                "val_ratio": split.val_ratio,
                "test_ratio": split.test_ratio,
                "random_seed": split.random_seed,
                "dataset_version_id": version.id,
            }
        )

    if version and not settings.allow_train_on_quality_fail:
        blockers = get_training_quality_blockers(db, version.id)
        if blockers:
            names = ", ".join(item["name"] for item in blockers)
            raise TrainingConfigError(
                409,
                "Training is blocked by failed data quality rules.",
                f"Blocking rules: {names}",
            )

    feature_columns = list(body.feature_columns or [])
    if not feature_columns:
        raise TrainingConfigError(
            422,
            "Select at least one feature column.",
            "Choose one or more columns other than the target.",
        )
    if len(feature_columns) != len(set(feature_columns)):
        raise TrainingConfigError(422, "Feature columns must be unique.")
    if body.target_column in feature_columns:
        raise TrainingConfigError(
            422,
            "The target column cannot also be a feature column.",
        )
    missing_features = [column for column in feature_columns if column not in columns]
    if missing_features:
        raise TrainingConfigError(
            422,
            f"Feature columns were not found: {', '.join(missing_features)}",
            f"Available columns: {', '.join(columns)}",
        )

    frame = _load_frame(version, dataset)
    try:
        resolved_problem_type = normalize_problem_type(
            body.problem_type, frame[body.target_column]
        )
        algorithm = resolve_algorithm(body.algorithm, resolved_problem_type)
        hyperparameters = validate_hyperparameters(algorithm, body.hyperparameters)
    except ValueError as exc:
        raise TrainingConfigError(422, str(exc)) from exc

    updated = body.model_copy(
        update={
            "algorithm": algorithm,
            "hyperparameters": hyperparameters,
            "feature_columns": feature_columns,
            "dataset_version_id": version.id if version else body.dataset_version_id,
        }
    )
    return ValidatedTrainingConfig(
        dataset=dataset,
        version=version,
        resolved_problem_type=resolved_problem_type,
        algorithm=algorithm,
        hyperparameters=hyperparameters,
        feature_columns=feature_columns,
        body=updated,
    )
