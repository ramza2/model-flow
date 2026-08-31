"""Legacy retrain trigger endpoint and RetrainTrigger records for drift/automation."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, dumps, friendly, get_owned, job_out, retrain_out
from app.api.v1.jobs import _new_job, _raise_config_error, _raise_retrain_error
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import RetrainTrigger, TrainingJob
from app.db.session import get_db
from app.schemas.v1 import RetrainRequest
from app.services.retrain_service import (
    RetrainConfigError,
    legacy_request_to_job_retrain,
    prepare_retrain_job,
)
from app.services.training_validation import TrainingConfigError

router = APIRouter(tags=["retraining"])


@router.post(
    "/projects/{project_id}/retrain",
    status_code=202,
    deprecated=True,
    summary="Legacy retrain trigger (deprecated)",
    description=(
        "Deprecated compatibility endpoint. "
        "Use POST /projects/{project_id}/jobs/{job_id}/retrain for new integrations."
    ),
)
def trigger_retrain(
    project_id: int,
    body: RetrainRequest,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, TrainingJob, body.source_job_id, project_id, "Training job")
    try:
        retrain_body = legacy_request_to_job_retrain(source, body)
    except RetrainConfigError as exc:
        _raise_retrain_error(exc)
    try:
        validated = prepare_retrain_job(db, project_id, source, retrain_body)
    except RetrainConfigError as exc:
        _raise_retrain_error(exc)
    except TrainingConfigError as exc:
        _raise_config_error(exc)
    job = _new_job(validated.body, project_id, auth.user.id, validated.version)
    job.retrain_source_job_id = source.id
    db.add(job)
    db.flush()
    trigger = RetrainTrigger(
        project_id=project_id,
        trigger_type="manual",
        config_json=dumps(
            {
                "source_job_id": source.id,
                "dataset_version_id": retrain_body.dataset_version_id,
                "overrides": body.overrides,
            }
        ),
        last_triggered_at=datetime.now(timezone.utc),
        created_training_job_id=job.id,
    )
    db.add(trigger)
    db.flush()
    audit_event(db, auth, "retrain.trigger", "retrain_trigger", trigger.id)
    db.commit()
    db.refresh(job)
    db.refresh(trigger)
    return {
        "trigger": retrain_out(trigger),
        "training_job": job_out(job),
        "registry_lifecycle": None,
    }
