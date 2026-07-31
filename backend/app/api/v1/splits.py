from __future__ import annotations

from io import BytesIO

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, friendly, get_owned, split_out
from app.api.v1.datasets import _read_frame
from app.core.config import settings
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import DatasetSplit, DatasetVersion
from app.db.session import get_db
from app.schemas.v1 import SplitCreate
from app.services import storage

router = APIRouter(tags=["splits"])


def _encode_frame(frame, format_name: str) -> tuple[bytes, str]:
    if format_name == "csv":
        return frame.to_csv(index=False).encode(), "text/csv"
    if format_name == "json":
        return frame.to_json(orient="records").encode(), "application/json"
    if format_name == "parquet":
        buffer = BytesIO()
        frame.to_parquet(buffer, index=False)
        return buffer.getvalue(), "application/vnd.apache.parquet"
    raise friendly(400, f"Dataset format '{format_name}' cannot be split.")


@router.post(
    "/projects/{project_id}/dataset-versions/{dataset_version_id}/splits",
    status_code=201,
)
def create_split(
    project_id: int,
    dataset_version_id: int,
    body: SplitCreate | None = None,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    body = body or SplitCreate()
    auth, _, _ = access
    version = get_owned(
        db,
        DatasetVersion,
        dataset_version_id,
        project_id,
        "Dataset version",
    )
    try:
        data = storage.download_bytes(
            settings.minio_datasets_bucket, version.object_key
        )
        frame = _read_frame(data, version.format).sample(
            frac=1,
            random_state=body.random_seed,
        )
    except Exception as exc:
        raise friendly(
            502, "The dataset version could not be loaded for splitting."
        ) from exc
    train_end = int(len(frame) * body.train_ratio)
    val_end = train_end + int(len(frame) * body.val_ratio)
    partitions = {
        "train": frame.iloc[:train_end],
        "validation": frame.iloc[train_end:val_end],
        "test": frame.iloc[val_end:],
    }
    row = DatasetSplit(
        project_id=project_id,
        dataset_version_id=version.id,
        name=body.name,
        train_ratio=body.train_ratio,
        val_ratio=body.val_ratio,
        test_ratio=body.test_ratio,
        random_seed=body.random_seed,
    )
    db.add(row)
    db.flush()
    storage.ensure_buckets()
    keys = {}
    for partition_name, partition in partitions.items():
        payload, content_type = _encode_frame(partition, version.format)
        key = (
            f"project-{project_id}/datasets/{version.dataset_id}/"
            f"v{version.version}/splits/{row.id}/{partition_name}.{version.format}"
        )
        storage.upload_bytes(settings.minio_datasets_bucket, key, payload, content_type)
        keys[partition_name] = key
    row.train_object_key = keys["train"]
    row.val_object_key = keys["validation"]
    row.test_object_key = keys["test"]
    audit_event(db, auth, "dataset_split.create", "dataset_split", row.id)
    db.commit()
    db.refresh(row)
    return split_out(row)


@router.get("/projects/{project_id}/dataset-versions/{dataset_version_id}/splits")
def list_splits(
    project_id: int,
    dataset_version_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    get_owned(db, DatasetVersion, dataset_version_id, project_id, "Dataset version")
    rows = db.scalars(
        select(DatasetSplit)
        .where(DatasetSplit.dataset_version_id == dataset_version_id)
        .order_by(DatasetSplit.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [split_out(row) for row in rows]
