from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, dumps, get_owned, job_out, retrain_out
from app.api.v1.jobs import _body_from_job, _new_job, _validate_job_source
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import RetrainTrigger, TrainingJob
from app.db.session import get_db
from app.schemas.v1 import RetrainRequest

router = APIRouter(tags=["retraining"])


@router.post("/projects/{project_id}/retrain", status_code=202)
def trigger_retrain(
    project_id: int,
    body: RetrainRequest,
    access=Depends(require_project_perm(Permission.TRAIN_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, TrainingJob, body.source_job_id, project_id, "Training job")
    overrides = dict(body.overrides)
    if body.dataset_version_id is not None:
        overrides["dataset_version_id"] = body.dataset_version_id
    retrain_body = _body_from_job(
        source,
        name=body.name or f"{source.name} (retrain)",
        overrides=overrides,
    )
    _, version = _validate_job_source(db, project_id, retrain_body)
    job = _new_job(retrain_body, project_id, auth.user.id, version)
    job.parent_job_id = source.id
    db.add(job)
    db.flush()
    trigger = RetrainTrigger(
        project_id=project_id,
        trigger_type="manual",
        config_json=dumps(
            {
                "source_job_id": source.id,
                "dataset_version_id": body.dataset_version_id,
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
