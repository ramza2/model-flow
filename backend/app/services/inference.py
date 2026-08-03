from __future__ import annotations

import json
import math
from typing import Any

import mlflow
import pandas as pd

from app.core.config import settings

_cache: dict[str, Any] = {}


def load_model(model_uri: str):
    if model_uri not in _cache:
        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        _cache[model_uri] = mlflow.pyfunc.load_model(model_uri)
    return _cache[model_uri]


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


def predict(
    model_uri: str,
    instances: list[dict[str, Any]],
    feature_schema: str | list[str] | list[dict[str, Any]] | dict[str, Any] | None = None,
) -> list[Any]:
    validate_instances(instances, feature_schema)
    model = load_model(model_uri)
    frame = pd.DataFrame(instances)
    preds = model.predict(frame)
    return [p.item() if hasattr(p, "item") else p for p in preds]
