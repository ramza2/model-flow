from __future__ import annotations

import json
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import safe_filename
from app.db.models import Dataset, DatasetVersion
from app.services import storage
from app.services.profiling import profile_dataframe

SUPPORTED_FORMATS = {"csv", "json", "parquet"}
CONTENT_TYPES = {
    "csv": "text/csv",
    "json": "application/json",
    "parquet": "application/vnd.apache.parquet",
}


def normalize_format(filename: str, file_format: str | None = None) -> str:
    value = (file_format or Path(filename).suffix.lstrip(".")).strip().lower()
    aliases = {"jsonl": "json", "ndjson": "json", "pq": "parquet"}
    value = aliases.get(value, value)
    if value not in SUPPORTED_FORMATS:
        raise ValueError(f"Unsupported dataset format '{value}'; use CSV, JSON, or Parquet.")
    return value


def dataframe_from_bytes(
    data: bytes, *, filename: str = "dataset.csv", file_format: str | None = None
) -> pd.DataFrame:
    if not data:
        raise ValueError("Dataset content is empty.")
    fmt = normalize_format(filename, file_format)
    stream = BytesIO(data)
    if fmt == "csv":
        return pd.read_csv(stream)
    if fmt == "parquet":
        return pd.read_parquet(stream)
    try:
        return pd.read_json(stream)
    except ValueError:
        stream.seek(0)
        return pd.read_json(stream, lines=True)


def update_dataset_mirror(dataset: Dataset, version: DatasetVersion) -> None:
    dataset.object_key = version.object_key
    dataset.row_count = version.row_count
    dataset.column_count = version.column_count
    dataset.columns_json = version.columns_json
    dataset.stats_json = version.stats_json
    dataset.latest_version = version.version


def create_dataset_version_from_bytes(
    db: Session,
    dataset: Dataset | int,
    data: bytes,
    filename: str,
    *,
    file_format: str | None = None,
    created_by: int | None = None,
    source_type: str = "upload",
    data_source_id: int | None = None,
    import_job_id: int | None = None,
    object_key: str | None = None,
) -> DatasetVersion:
    """Profile, upload, and persist one immutable dataset version."""

    if isinstance(dataset, int):
        dataset_row = db.get(Dataset, dataset)
        if dataset_row is None:
            raise ValueError(f"Dataset {dataset} was not found.")
        dataset = dataset_row
    if dataset.id is None:
        db.flush()

    fmt = normalize_format(filename, file_format)
    frame = dataframe_from_bytes(data, filename=filename, file_format=fmt)
    profile = profile_dataframe(frame)
    latest = db.scalar(
        select(func.max(DatasetVersion.version)).where(DatasetVersion.dataset_id == dataset.id)
    )
    version_number = int(latest or 0) + 1
    clean_name = safe_filename(filename)
    key = object_key or (
        f"project-{dataset.project_id}/dataset-{dataset.id}/"
        f"v{version_number}-{uuid.uuid4().hex}/{clean_name}"
    )

    storage.ensure_buckets()
    storage.upload_bytes(
        settings.minio_datasets_bucket,
        key,
        data,
        CONTENT_TYPES[fmt],
    )
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=dataset.project_id,
        version=version_number,
        object_key=key,
        original_filename=clean_name,
        format=fmt,
        row_count=profile["row_count"],
        column_count=profile["column_count"],
        columns_json=json.dumps(profile["columns"]),
        dtypes_json=json.dumps(profile["dtypes"]),
        stats_json=json.dumps(profile["stats"], default=str),
        preview_json=json.dumps(profile["preview"], default=str),
        source_type=source_type,
        data_source_id=data_source_id,
        import_job_id=import_job_id,
        created_by=created_by,
    )
    db.add(version)
    db.flush()
    update_dataset_mirror(dataset, version)
    db.flush()
    return version


def create_dataset_version(
    db: Session,
    *,
    dataset_id: int,
    data: bytes,
    filename: str,
    file_format: str | None = None,
    created_by: int | None = None,
    source_type: str = "upload",
    data_source_id: int | None = None,
    import_job_id: int | None = None,
) -> DatasetVersion:
    return create_dataset_version_from_bytes(
        db,
        dataset_id,
        data,
        filename,
        file_format=file_format,
        created_by=created_by,
        source_type=source_type,
        data_source_id=data_source_id,
        import_job_id=import_job_id,
    )


def load_dataset_version_dataframe(version: DatasetVersion) -> pd.DataFrame:
    data = storage.download_bytes(settings.minio_datasets_bucket, version.object_key)
    return dataframe_from_bytes(
        data,
        filename=version.original_filename,
        file_format=version.format,
    )


def _json(value: str | None, default: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return default


def compare_versions(base: DatasetVersion, candidate: DatasetVersion) -> dict[str, Any]:
    base_columns = _json(base.columns_json, [])
    candidate_columns = _json(candidate.columns_json, [])
    base_dtypes = _json(base.dtypes_json, {})
    candidate_dtypes = _json(candidate.dtypes_json, {})
    shared = sorted(set(base_columns) & set(candidate_columns))
    dtype_changes = {
        column: {"from": base_dtypes.get(column), "to": candidate_dtypes.get(column)}
        for column in shared
        if base_dtypes.get(column) != candidate_dtypes.get(column)
    }
    return {
        "base_version": base.version,
        "candidate_version": candidate.version,
        "row_count": {
            "base": base.row_count,
            "candidate": candidate.row_count,
            "delta": candidate.row_count - base.row_count,
        },
        "column_count": {
            "base": base.column_count,
            "candidate": candidate.column_count,
            "delta": candidate.column_count - base.column_count,
        },
        "added_columns": sorted(set(candidate_columns) - set(base_columns)),
        "removed_columns": sorted(set(base_columns) - set(candidate_columns)),
        "dtype_changes": dtype_changes,
        "stats": {
            "base": _json(base.stats_json, {}),
            "candidate": _json(candidate.stats_json, {}),
        },
    }
