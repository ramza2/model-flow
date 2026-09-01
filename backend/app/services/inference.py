from __future__ import annotations

import json
import math
import re
from typing import Any

import mlflow
import pandas as pd
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import DatasetVersion, Endpoint, ModelVersion, TrainingJob
from app.services.prediction_serialization import serialize_predictions

_cache: dict[str, Any] = {}


class PredictionInputError(ValueError):
    """Raised when prediction instances cannot be coerced to the model input schema."""


def load_model(model_uri: str):
    if model_uri not in _cache:
        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        _cache[model_uri] = mlflow.pyfunc.load_model(model_uri)
    return _cache[model_uri]


def sample_value_for_dtype(dtype: str | None, example: Any = None) -> Any:
    """Build a dtype-aware sample value; prefer an explicit example when present."""

    if example is not None:
        return example
    lower = str(dtype or "").lower()
    if re.search(r"bool|boolean", lower):
        return False
    if re.search(r"datetime|date|timestamp|timedelta", lower):
        return "2026-01-01T00:00:00"
    if re.search(r"str|string|text|object|category|categorical", lower):
        return "sample"
    if re.search(r"int8|int16|int32|int64|uint|int|long", lower):
        return 0
    if re.search(r"float|double|decimal|number|numeric", lower):
        return 0.0
    # Unknown dtype is not an implicit float — use a safe generic sample.
    return "sample"


def _resolve_training_dataset_version(
    db: Session, endpoint: Endpoint
) -> DatasetVersion | None:
    if not endpoint.model_version_id:
        return None
    model = db.get(ModelVersion, endpoint.model_version_id)
    if model is None:
        return None
    if model.dataset_version_id is not None:
        version = db.get(DatasetVersion, model.dataset_version_id)
        if version is not None:
            return version
    if model.training_job_id is not None:
        job = db.get(TrainingJob, model.training_job_id)
        if job is not None and job.dataset_version_id is not None:
            return db.get(DatasetVersion, job.dataset_version_id)
    return None


def _first_preview_row(version: DatasetVersion) -> dict[str, Any] | None:
    try:
        preview = json.loads(version.preview_json or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(preview, list):
        return None
    for row in preview:
        if isinstance(row, dict) and row:
            return row
    return None


def build_prediction_sample_for_endpoint(
    db: Session, endpoint: Endpoint
) -> dict[str, Any] | None:
    """Feature-scoped sample from DatasetVersion lineage; never raises for missing lineage."""

    try:
        schema = json.loads(endpoint.feature_schema_json or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(schema, list) or not schema:
        return None

    preview_row: dict[str, Any] | None = None
    dtypes: dict[str, Any] = {}
    try:
        version = _resolve_training_dataset_version(db, endpoint)
        if version is not None:
            preview_row = _first_preview_row(version)
            try:
                loaded = json.loads(version.dtypes_json or "{}")
                if isinstance(loaded, dict):
                    dtypes = loaded
            except json.JSONDecodeError:
                dtypes = {}
    except Exception:
        preview_row = None
        dtypes = {}

    sample: dict[str, Any] = {}
    for index, field in enumerate(schema):
        if isinstance(field, str):
            name = field.strip()
            if not name:
                continue
            if preview_row is not None and name in preview_row and preview_row[name] is not None:
                sample[name] = preview_row[name]
            else:
                sample[name] = sample_value_for_dtype(str(dtypes.get(name, "")))
            continue
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or field.get("field") or f"feature_{index + 1}")
        dtype = str(
            field.get("dtype") or field.get("type") or dtypes.get(name, "") or ""
        )
        if preview_row is not None and name in preview_row and preview_row[name] is not None:
            sample[name] = preview_row[name]
            continue
        for key in ("example", "sample", "default"):
            if field.get(key) is not None:
                sample[name] = field[key]
                break
        else:
            sample[name] = sample_value_for_dtype(dtype)
    return sample


def _matches_type(value: Any, dtype: str) -> bool:
    if value is None:
        return True
    dtype = dtype.lower()
    if dtype in {"number", "numeric", "float", "float64", "double"}:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if dtype in {"int", "integer", "int64", "long"}:
        return isinstance(value, int) and not isinstance(value, bool)
    if dtype in {"bool", "boolean"}:
        return isinstance(value, bool)
    if dtype in {"str", "string", "text", "object", "category", "categorical"}:
        return isinstance(value, str)
    return True


def validate_instances(
    instances: list[dict[str, Any]],
    feature_schema: str | list[str] | list[dict[str, Any]] | dict[str, Any] | None,
) -> None:
    if not instances:
        raise ValueError("Provide at least one instance in 'instances'.")
    if not feature_schema:
        return
    if isinstance(feature_schema, str):
        try:
            feature_schema = json.loads(feature_schema)
        except json.JSONDecodeError as exc:
            raise ValueError("Endpoint feature schema is not valid JSON.") from exc
    if isinstance(feature_schema, dict):
        feature_schema = feature_schema.get("features", feature_schema.get("columns", []))
    if not feature_schema:
        return

    fields: list[dict[str, Any]] = []
    for item in feature_schema:
        fields.append({"name": item, "required": True} if isinstance(item, str) else item)
    required = {
        str(field["name"])
        for field in fields
        if field.get("name") and field.get("required", True)
    }
    allowed = {str(field["name"]) for field in fields if field.get("name")}
    typed = {
        str(field["name"]): str(field.get("dtype", field.get("type", "")))
        for field in fields
        if field.get("name") and field.get("dtype", field.get("type"))
    }

    errors: list[str] = []
    for index, instance in enumerate(instances):
        if not isinstance(instance, dict):
            errors.append(f"instance {index} must be an object")
            continue
        missing = sorted(required - set(instance))
        extra = sorted(set(instance) - allowed)
        if missing:
            errors.append(f"instance {index} is missing required features: {missing}")
        if extra:
            errors.append(f"instance {index} contains unknown features: {extra}")
        for name, dtype in typed.items():
            if name in instance and not _matches_type(instance[name], dtype):
                errors.append(
                    f"instance {index} feature '{name}' must match type '{dtype}'"
                )
    if errors:
        raise ValueError("Feature schema validation failed: " + "; ".join(errors[:20]))


def _mlflow_type_name(col_type: Any) -> str:
    if col_type is None:
        return ""
    name = getattr(col_type, "name", None)
    if name:
        return str(name).lower()
    text = str(col_type).lower()
    return text.replace("datatype.", "")


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _coerce_column_to_mlflow_type(
    series: pd.Series, type_name: str, feature_name: str
) -> pd.Series:
    """Coerce a column to the MLflow signature type with safe widening only."""

    type_name = (type_name or "").lower()
    if type_name in {"double", "float"}:
        pandas_dtype = "float64" if type_name == "double" else "float32"
        for value in series.tolist():
            if _is_missing(value):
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise PredictionInputError(
                    f"Feature '{feature_name}' must be numeric for model type '{type_name}'."
                )
            if isinstance(value, float) and not math.isfinite(value):
                raise PredictionInputError(
                    f"Feature '{feature_name}' must be a finite number for model type '{type_name}'."
                )
        try:
            return series.astype(pandas_dtype)
        except (TypeError, ValueError) as exc:
            raise PredictionInputError(
                f"Feature '{feature_name}' must be numeric for model type '{type_name}'."
            ) from exc

    if type_name in {"integer", "long"}:
        pandas_dtype = "int64" if type_name == "long" else "int32"
        coerced: list[Any] = []
        for value in series.tolist():
            if _is_missing(value):
                coerced.append(pd.NA)
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise PredictionInputError(
                    f"Feature '{feature_name}' must be an integer for model type '{type_name}'."
                )
            if isinstance(value, float):
                if not math.isfinite(value) or not value.is_integer():
                    raise PredictionInputError(
                        f"Feature '{feature_name}' must be an integer for model type '{type_name}'."
                    )
                coerced.append(int(value))
            else:
                coerced.append(int(value))
        try:
            return pd.Series(coerced, index=series.index, dtype=pandas_dtype)
        except (TypeError, ValueError) as exc:
            raise PredictionInputError(
                f"Feature '{feature_name}' must be an integer for model type '{type_name}'."
            ) from exc

    if type_name == "string":
        for value in series.tolist():
            if _is_missing(value):
                continue
            if not isinstance(value, str):
                raise PredictionInputError(
                    f"Feature '{feature_name}' must be a string for model type 'string'."
                )
        return series.astype(object)

    if type_name == "boolean":
        for value in series.tolist():
            if _is_missing(value):
                continue
            if not isinstance(value, bool):
                raise PredictionInputError(
                    f"Feature '{feature_name}' must be a boolean for model type 'boolean'."
                )
        return series.astype("boolean")

    if type_name == "datetime":
        try:
            return pd.to_datetime(series, errors="raise")
        except (TypeError, ValueError) as exc:
            raise PredictionInputError(
                f"Feature '{feature_name}' must be a datetime for model type 'datetime'."
            ) from exc

    return series


def normalize_prediction_frame(frame: pd.DataFrame, input_schema: Any) -> pd.DataFrame:
    """Align DataFrame dtypes to an MLflow model input schema when available."""

    if input_schema is None:
        return frame
    inputs = getattr(input_schema, "inputs", None)
    if not inputs:
        return frame

    normalized = frame.copy()
    for column in inputs:
        name = getattr(column, "name", None)
        if not name or name not in normalized.columns:
            continue
        type_name = _mlflow_type_name(getattr(column, "type", None))
        if not type_name:
            continue
        normalized[name] = _coerce_column_to_mlflow_type(
            normalized[name], type_name, str(name)
        )
    return normalized


def _model_input_schema(model: Any) -> Any:
    try:
        metadata = getattr(model, "metadata", None)
        if metadata is None or not hasattr(metadata, "get_input_schema"):
            return None
        return metadata.get_input_schema()
    except Exception:
        return None


def predict(
    model_uri: str,
    instances: list[dict[str, Any]],
    feature_schema: str | list[str] | list[dict[str, Any]] | dict[str, Any] | None = None,
    target_columns: list[str] | None = None,
) -> list[Any]:
    validate_instances(instances, feature_schema)
    model = load_model(model_uri)
    frame = pd.DataFrame(instances)
    frame = normalize_prediction_frame(frame, _model_input_schema(model))
    preds = model.predict(frame)
    return serialize_predictions(preds, target_columns=target_columns)
