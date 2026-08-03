from __future__ import annotations

from io import BytesIO

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, batch_out, friendly, get_owned
from app.core.config import settings
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import (
    BatchInferenceJob,
    DatasetVersion,
    Endpoint,
    JobStatus,
    ModelVersion,
)
from app.db.session import get_db
from app.schemas.v1 import BatchCreate
from app.services import storage

router = APIRouter(tags=["batch-inference"])


@router.get("/projects/{project_id}/batch-jobs")
def list_batch_jobs(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DEPLOY_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(BatchInferenceJob)
        .where(BatchInferenceJob.project_id == project_id)
        .order_by(BatchInferenceJob.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [batch_out(row) for row in rows]


@router.post("/projects/{project_id}/batch-jobs", status_code=202)
def create_batch_job(
    project_id: int,
    body: BatchCreate,
    access=Depends(require_project_perm(Permission.DEPLOY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    get_owned(
        db, DatasetVersion, body.dataset_version_id, project_id, "Dataset version"
    )
    if body.endpoint_id is not None:
        get_owned(db, Endpoint, body.endpoint_id, project_id, "Endpoint")
    if body.model_version_id is not None:
        get_owned(db, ModelVersion, body.model_version_id, project_id, "Model version")
    row = BatchInferenceJob(
        project_id=project_id,
        dataset_version_id=body.dataset_version_id,
        endpoint_id=body.endpoint_id,
        model_version_id=body.model_version_id,
        result_format=body.result_format,
        status=JobStatus.pending,
        created_by=auth.user.id,
    )
    db.add(row)
    db.flush()
    audit_event(db, auth, "batch_job.create", "batch_inference_job", row.id)
    db.commit()
    db.refresh(row)
    return batch_out(row)


@router.get("/projects/{project_id}/batch-jobs/{job_id}")
def get_batch_job(
    project_id: int,
    job_id: int,
    _=Depends(require_project_perm(Permission.DEPLOY_READ)),
    db: Session = Depends(get_db),
):
    return batch_out(
        get_owned(db, BatchInferenceJob, job_id, project_id, "Batch inference job")
    )


@router.get("/projects/{project_id}/batch-jobs/{job_id}/download")
def download_batch_result(
    project_id: int,
    job_id: int,
    stream: bool = False,
    _=Depends(require_project_perm(Permission.DEPLOY_READ)),
    db: Session = Depends(get_db),
):
    row = get_owned(db, BatchInferenceJob, job_id, project_id, "Batch inference job")
    if row.status != JobStatus.succeeded or not row.result_object_key:
        raise friendly(409, "Batch result is not ready for download.")
    if not stream:
        try:
            url = storage.s3_client().generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": settings.minio_batch_bucket,
                    "Key": row.result_object_key,
                },
                ExpiresIn=900,
            )
            return {"download_url": url, "expires_in_seconds": 900}
        except Exception as exc:
            raise friendly(502, "A download URL could not be generated.") from exc
    try:
        payload = storage.download_bytes(
            settings.minio_batch_bucket, row.result_object_key
        )
    except Exception as exc:
        raise friendly(502, "The batch result could not be downloaded.") from exc
    media_types = {
        "csv": "text/csv",
        "json": "application/json",
        "parquet": "application/vnd.apache.parquet",
    }
    return StreamingResponse(
        BytesIO(payload),
        media_type=media_types.get(row.result_format, "application/octet-stream"),
        headers={
            "Content-Disposition": f'attachment; filename="batch-{row.id}.{row.result_format}"'
        },
    )
