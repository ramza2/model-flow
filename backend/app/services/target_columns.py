"""Shared helpers for canonical training target column lists."""

from __future__ import annotations

import json
from typing import Any

from app.db.models import TrainingJob


class TargetColumnError(ValueError):
    """Raised when target column inputs cannot be canonicalized."""


def loads_target_columns_json(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(column).strip() for column in parsed if str(column).strip()]


def dumps_target_columns(columns: list[str]) -> str:
    return json.dumps(columns)


def effective_target_columns_from_job(job: TrainingJob) -> list[str]:
    stored = loads_target_columns_json(getattr(job, "target_columns_json", None) or "[]")
    if stored:
        return stored
    if job.target_column:
        return [job.target_column]
    return []


def effective_target_columns_from_values(
    target_column: str | None,
    target_columns: list[str] | None = None,
    *,
    stored_columns_json: str | list[str] | None = None,
) -> list[str]:
    if stored_columns_json is not None:
        if isinstance(stored_columns_json, str):
            stored = loads_target_columns_json(stored_columns_json)
        else:
            stored = [str(column).strip() for column in stored_columns_json if str(column).strip()]
        if stored:
            return stored

    columns: list[str] = []
    if target_columns is not None:
        for name in target_columns:
            trimmed = str(name).strip()
            if not trimmed:
                raise TargetColumnError("Target column names cannot be empty.")
            columns.append(trimmed)
    elif target_column:
        trimmed = str(target_column).strip()
        if not trimmed:
            raise TargetColumnError("Target column names cannot be empty.")
        columns.append(trimmed)
    else:
        raise TargetColumnError("At least one target column is required.")

    if len(columns) != len(set(columns)):
        raise TargetColumnError("Target columns must be unique.")
    return columns


def canonicalize_job_targets(
    target_column: str | None,
    target_columns: list[str] | None,
) -> tuple[str, list[str]]:
    normalized_list: list[str] | None = None
    if target_columns is not None:
        normalized_list = [str(column).strip() for column in target_columns]
        if any(not column for column in normalized_list):
            raise TargetColumnError("Target column names cannot be empty.")
        if len(normalized_list) != len(set(normalized_list)):
            raise TargetColumnError("Target columns must be unique.")
        if not normalized_list:
            raise TargetColumnError("At least one target column is required.")

    normalized_single = str(target_column).strip() if target_column else None
    if normalized_list is not None and normalized_single is not None:
        if normalized_single != normalized_list[0]:
            raise TargetColumnError(
                "target_column must match the first entry in target_columns."
            )

    effective = normalized_list if normalized_list is not None else (
        [normalized_single] if normalized_single else None
    )
    if not effective:
        raise TargetColumnError("At least one target column is required.")
    return effective[0], effective


def is_multi_output(columns: list[str]) -> bool:
    return len(columns) > 1


def resolve_output_target_columns(
    *,
    metadata: dict[str, Any] | None = None,
    job: TrainingJob | None = None,
    mlflow_params: dict[str, Any] | None = None,
) -> list[str]:
    if metadata:
        stored = metadata.get("target_columns")
        if isinstance(stored, list) and stored:
            return [str(column) for column in stored]
        output_schema = metadata.get("output_schema") or []
        if isinstance(output_schema, list):
            names = [
                str(item["name"])
                for item in output_schema
                if isinstance(item, dict) and item.get("name")
            ]
            if names:
                return names
    if mlflow_params and mlflow_params.get("target_columns"):
        raw = mlflow_params["target_columns"]
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError):
                parsed = [part.strip() for part in raw.split(",") if part.strip()]
            if isinstance(parsed, list) and parsed:
                return [str(column) for column in parsed]
    if job is not None:
        return effective_target_columns_from_job(job)
    return []


def output_schema_for_targets(targets: list[str], dtypes: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    schema: list[dict[str, Any]] = []
    for name in targets:
        dtype = "float64"
        if dtypes and name in dtypes:
            dtype = str(dtypes[name])
        schema.append({"name": name, "dtype": dtype})
    return schema
