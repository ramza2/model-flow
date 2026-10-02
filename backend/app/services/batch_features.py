"""Shared batch / pipeline prediction feature-schema selection.

Priority (authoritative for both normal Batch Worker and Pipeline batch_prediction):

1. Endpoint.feature_schema
2. ModelVersion metadata feature_schema / features
3. TrainingJob.feature_columns
4. Legacy fallback (drop job targets, else full frame)
"""

from __future__ import annotations

import json
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session

from app.db.models import Endpoint, ModelVersion, TrainingJob
from app.services.target_columns import effective_target_columns_from_job


def schema_columns(value: str | list | dict | None) -> list[str]:
    """Normalize feature schema JSON / list / dict into ordered column names."""
    if value is None:
        return []
    schema: Any = value
    if isinstance(value, str):
        try:
            schema = json.loads(value or "[]")
        except (TypeError, json.JSONDecodeError):
            return []
    if isinstance(schema, dict):
        schema = schema.get("features", schema.get("columns", []))
    if not isinstance(schema, list):
        return []
    return [
        str(item["name"] if isinstance(item, dict) else item)
        for item in schema
        if (isinstance(item, str) and item)
        or (isinstance(item, dict) and item.get("name"))
    ]


def resolve_feature_column_names(
    db: Session,
    *,
    endpoint: Endpoint | None = None,
    model_version: ModelVersion | None = None,
    training_job: TrainingJob | None = None,
) -> list[str]:
    """Resolve ordered feature column names without requiring a dataframe."""
    columns = schema_columns(endpoint.feature_schema_json if endpoint else None)
    resolved_job = training_job
    if model_version is not None:
        if not columns:
            try:
                metadata = json.loads(model_version.metadata_json or "{}")
            except json.JSONDecodeError:
                metadata = {}
            columns = schema_columns(
                metadata.get("feature_schema", metadata.get("features", []))
            )
        if resolved_job is None and model_version.training_job_id:
            resolved_job = db.get(TrainingJob, model_version.training_job_id)
    if not columns and resolved_job is not None:
        columns = schema_columns(resolved_job.feature_columns_json)
    return columns


def _schema_payload_from_value(value: Any) -> list[dict[str, Any]]:
    """Normalize a schema source into Endpoint feature_schema entries.

    Structured dict entries preserve name / required / dtype (and type when that
    is the source representation). Name-only sources become name + required.
    """
    schema: Any = value
    if isinstance(value, str):
        try:
            schema = json.loads(value or "[]")
        except (TypeError, json.JSONDecodeError):
            return []
    if isinstance(schema, dict):
        schema = schema.get("features", schema.get("columns", []))
    if not isinstance(schema, list) or not schema:
        return []

    if all(isinstance(item, dict) for item in schema):
        payload: list[dict[str, Any]] = []
        for item in schema:
            name = item.get("name")
            if not name:
                continue
            entry: dict[str, Any] = {
                "name": str(name),
                "required": bool(item.get("required", True)),
            }
            dtype = item.get("dtype")
            if isinstance(dtype, str) and dtype:
                entry["dtype"] = dtype
            type_name = item.get("type")
            if "dtype" not in entry and isinstance(type_name, str) and type_name:
                entry["type"] = type_name
            payload.append(entry)
        return payload

    return [{"name": name, "required": True} for name in schema_columns(schema)]


def resolve_feature_schema_payload(
    db: Session,
    *,
    endpoint: Endpoint | None = None,
    model_version: ModelVersion | None = None,
    training_job: TrainingJob | None = None,
    incoming: Any = None,
) -> list[dict[str, Any]]:
    """Build a JSON-serializable feature schema list for Endpoint persistence.

    Priority matches feature-column resolution:

    1. explicit incoming schema
    2. Endpoint.feature_schema
    3. ModelVersion metadata feature_schema / features
    4. TrainingJob.feature_columns
    """
    payload = _schema_payload_from_value(incoming)
    if payload:
        return payload

    if endpoint is not None:
        payload = _schema_payload_from_value(endpoint.feature_schema_json)
        if payload:
            return payload

    resolved_job = training_job
    if model_version is not None:
        try:
            metadata = json.loads(model_version.metadata_json or "{}")
        except json.JSONDecodeError:
            metadata = {}
        payload = _schema_payload_from_value(
            metadata.get("feature_schema", metadata.get("features", []))
        )
        if payload:
            return payload
        if resolved_job is None and model_version.training_job_id:
            resolved_job = db.get(TrainingJob, model_version.training_job_id)

    if resolved_job is not None:
        payload = _schema_payload_from_value(resolved_job.feature_columns_json)
        if payload:
            return payload
    return []


def select_batch_feature_frame(
    db: Session,
    frame: pd.DataFrame,
    *,
    endpoint: Endpoint | None = None,
    model_version: ModelVersion | None = None,
    training_job: TrainingJob | None = None,
) -> pd.DataFrame:
    """Select model-input features in authoritative order; fail closed on missing."""
    columns = resolve_feature_column_names(
        db,
        endpoint=endpoint,
        model_version=model_version,
        training_job=training_job,
    )
    resolved_job = training_job
    if (
        resolved_job is None
        and model_version is not None
        and model_version.training_job_id
    ):
        resolved_job = db.get(TrainingJob, model_version.training_job_id)

    if columns:
        missing = sorted(set(columns) - set(map(str, frame.columns)))
        if missing:
            raise ValueError(f"Batch dataset is missing model features: {missing}")
        return frame.loc[:, columns]
    if resolved_job is not None:
        target_columns = effective_target_columns_from_job(resolved_job)
        drop_columns = [column for column in target_columns if column in frame.columns]
        if drop_columns:
            return frame.drop(columns=drop_columns)
    return frame
