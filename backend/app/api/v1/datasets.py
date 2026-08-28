from __future__ import annotations

import json
import uuid
from io import BytesIO
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dataset_out,
    dataset_version_out,
    dumps,
    friendly,
    get_owned,
    job_out,
    model_version_out,
)
from app.core.config import settings
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.core.security import safe_filename
from app.db.models import Dataset, DatasetVersion, ModelVersion, TrainingJob
from app.db.session import get_db
from app.services import storage

router = APIRouter(tags=["datasets"])
_CONTENT_TYPES = {
    "csv": "text/csv",
    "json": "application/json",
    "parquet": "application/vnd.apache.parquet",
}


def _read_frame(data: bytes, extension: str) -> pd.DataFrame:
    if extension == "csv":
        return pd.read_csv(BytesIO(data))
    if extension == "json":
        return pd.read_json(BytesIO(data))
    if extension == "parquet":
        return pd.read_parquet(BytesIO(data))
    raise friendly(400, "Unsupported dataset format.", "Upload CSV, JSON, or Parquet.")


def _profile_frame(frame: pd.DataFrame) -> tuple[list[str], dict, dict, list[dict]]:
    columns = [str(column) for column in frame.columns]
    frame = frame.copy()
    frame.columns = columns
    dtypes = {column: str(frame[column].dtype) for column in columns}
    stats: dict = {}
    for column in columns:
        series = frame[column]
        entry: dict = {
            "dtype": str(series.dtype),
            "null_count": int(series.isna().sum()),
            "unique_count": int(series.nunique(dropna=True)),
        }
        if pd.api.types.is_numeric_dtype(series):
            entry.update(
                {
                    "min": float(series.min()) if series.notna().any() else None,
                    "max": float(series.max()) if series.notna().any() else None,
                    "mean": float(series.mean()) if series.notna().any() else None,
                    "std": float(series.std()) if series.notna().sum() > 1 else None,
                }
            )
        else:
            entry["top_values"] = {
                str(key): int(value)
                for key, value in series.dropna()
                .astype(str)
                .value_counts()
                .head(5)
                .items()
            }
        stats[column] = entry
    preview = json.loads(frame.head(100).to_json(orient="records", date_format="iso"))
    return columns, dtypes, stats, preview


def _dataset_version(
    db: Session, project_id: int, dataset_id: int, version: int
) -> DatasetVersion:
    dataset = get_owned(db, Dataset, dataset_id, project_id, "Dataset")
    row = db.scalar(
        select(DatasetVersion).where(
            DatasetVersion.dataset_id == dataset.id,
            DatasetVersion.version == version,
        )
    )
    if not row:
        raise friendly(404, f"Dataset version {version} was not found.")
    return row


def _latest_version_created_at_map(
    db: Session, dataset_ids: list[int]
) -> dict[int, datetime]:
    if not dataset_ids:
        return {}
    rows = db.execute(
        select(DatasetVersion.dataset_id, func.max(DatasetVersion.created_at))
        .where(DatasetVersion.dataset_id.in_(dataset_ids))
        .group_by(DatasetVersion.dataset_id)
    ).all()
    return {dataset_id: created_at for dataset_id, created_at in rows}


def _latest_version_created_at(db: Session, dataset_id: int) -> datetime | None:
    return db.scalar(
        select(func.max(DatasetVersion.created_at)).where(
            DatasetVersion.dataset_id == dataset_id
        )
    )


@router.get("/projects/{project_id}/datasets")
def list_datasets(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Dataset)
        .where(Dataset.project_id == project_id)
        .order_by(Dataset.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    latest_by_dataset = _latest_version_created_at_map(db, [row.id for row in rows])
    return [
        dataset_out(
            row,
            latest_version_created_at=latest_by_dataset.get(row.id),
        )
        for row in rows
    ]


@router.post("/projects/{project_id}/datasets", status_code=201)
async def upload_dataset(
    project_id: int,
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
    description: str = Form(default=""),
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    filename = safe_filename(file.filename or "")
    extension = Path(filename).suffix.lower().lstrip(".")
    if extension not in _CONTENT_TYPES:
        raise friendly(
            400, "Unsupported dataset format.", "Upload CSV, JSON, or Parquet."
        )
    data = await file.read(settings.max_upload_bytes + 1)
    if not data:
        raise friendly(400, "The uploaded file is empty.")
    if len(data) > settings.max_upload_bytes:
        raise friendly(
            413,
            "The uploaded file is too large.",
            f"Maximum: {settings.max_upload_bytes} bytes.",
        )
    try:
        frame = _read_frame(data, extension)
        columns, dtypes, stats, preview = _profile_frame(frame)
    except Exception as exc:
        raise friendly(
            400,
            f"Could not parse {extension.upper()} dataset.",
            "Check the file format.",
        ) from exc
    logical_name = (name or filename).strip()
    dataset = db.scalar(
        select(Dataset).where(
            Dataset.project_id == project_id,
            func.lower(Dataset.name) == logical_name.lower(),
        )
    )
    if dataset is None:
        dataset = Dataset(
            project_id=project_id,
            name=logical_name,
            description=description,
            created_by=auth.user.id,
        )
        db.add(dataset)
        db.flush()
    next_version = (dataset.latest_version or 0) + 1
    storage.ensure_buckets()
    object_key = (
        f"project-{project_id}/datasets/{dataset.id}/v{next_version}/"
        f"{uuid.uuid4().hex}-{filename}"
    )
    storage.upload_bytes(
        settings.minio_datasets_bucket,
        object_key,
        data,
        _CONTENT_TYPES[extension],
    )
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project_id,
        version=next_version,
        object_key=object_key,
        original_filename=filename,
        format=extension,
        row_count=len(frame),
        column_count=len(columns),
        columns_json=dumps(columns),
        dtypes_json=dumps(dtypes),
        stats_json=dumps(stats),
        preview_json=dumps(preview),
        source_type="upload",
        created_by=auth.user.id,
    )
    db.add(version)
    dataset.latest_version = next_version
    dataset.object_key = object_key
    dataset.row_count = len(frame)
    dataset.column_count = len(columns)
    dataset.columns_json = dumps(columns)
    dataset.stats_json = dumps(stats)
    if description and not dataset.description:
        dataset.description = description
    db.flush()
    audit_event(
        db,
        auth,
        "dataset.upload",
        "dataset_version",
        version.id,
        after={"dataset_id": dataset.id, "version": next_version, "format": extension},
    )
    db.commit()
    db.refresh(dataset)
    db.refresh(version)
    result = dataset_out(dataset, latest_version_created_at=version.created_at)
    result["version"] = dataset_version_out(version)
    return result


@router.get("/projects/{project_id}/datasets/{dataset_id}")
def get_dataset(
    project_id: int,
    dataset_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    dataset = get_owned(db, Dataset, dataset_id, project_id, "Dataset")
    return dataset_out(
        dataset,
        latest_version_created_at=_latest_version_created_at(db, dataset.id),
    )


@router.get("/projects/{project_id}/datasets/{dataset_id}/versions")
def list_versions(
    project_id: int,
    dataset_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    get_owned(db, Dataset, dataset_id, project_id, "Dataset")
    rows = db.scalars(
        select(DatasetVersion)
        .where(DatasetVersion.dataset_id == dataset_id)
        .order_by(DatasetVersion.version.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [dataset_version_out(row) for row in rows]


@router.get("/projects/{project_id}/datasets/{dataset_id}/versions/compare")
def compare_versions(
    project_id: int,
    dataset_id: int,
    left: int = Query(..., ge=1),
    right: int = Query(..., ge=1),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    left_row = _dataset_version(db, project_id, dataset_id, left)
    right_row = _dataset_version(db, project_id, dataset_id, right)
    left_columns = set(json.loads(left_row.columns_json or "[]"))
    right_columns = set(json.loads(right_row.columns_json or "[]"))
    left_dtypes = json.loads(left_row.dtypes_json or "{}")
    right_dtypes = json.loads(right_row.dtypes_json or "{}")
    changed_types = {
        column: {"left": left_dtypes.get(column), "right": right_dtypes.get(column)}
        for column in sorted(left_columns & right_columns)
        if left_dtypes.get(column) != right_dtypes.get(column)
    }
    return {
        "left": dataset_version_out(left_row),
        "right": dataset_version_out(right_row),
        "changes": {
            "row_count_delta": right_row.row_count - left_row.row_count,
            "added_columns": sorted(right_columns - left_columns),
            "removed_columns": sorted(left_columns - right_columns),
            "changed_types": changed_types,
        },
    }


@router.get("/projects/{project_id}/datasets/{dataset_id}/versions/{version}")
def get_version(
    project_id: int,
    dataset_id: int,
    version: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    return dataset_version_out(_dataset_version(db, project_id, dataset_id, version))


@router.get("/projects/{project_id}/datasets/{dataset_id}/versions/{version}/preview")
def preview_version(
    project_id: int,
    dataset_id: int,
    version: int,
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    row = _dataset_version(db, project_id, dataset_id, version)
    return {
        "dataset_version_id": row.id,
        "columns": json.loads(row.columns_json or "[]"),
        "rows": json.loads(row.preview_json or "[]")[:limit],
    }


@router.get("/projects/{project_id}/datasets/{dataset_id}/versions/{version}/lineage")
def version_lineage(
    project_id: int,
    dataset_id: int,
    version: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    row = _dataset_version(db, project_id, dataset_id, version)
    jobs = db.scalars(
        select(TrainingJob)
        .where(TrainingJob.dataset_version_id == row.id)
        .order_by(TrainingJob.id.desc())
    ).all()
    models = db.scalars(
        select(ModelVersion)
        .where(ModelVersion.dataset_version_id == row.id)
        .order_by(ModelVersion.id.desc())
    ).all()
    return {
        "dataset_version": dataset_version_out(row),
        "training_jobs": [job_out(job) for job in jobs],
        "model_versions": [model_version_out(model) for model in models],
    }
