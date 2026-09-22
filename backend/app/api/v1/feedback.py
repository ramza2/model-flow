"""Feedback review and materialization APIs (Phase 5-B)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.v1.common import friendly, get_owned
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import FeedbackMaterializationRun
from app.db.session import get_db
from app.services import feedback_materialization as materialization_service
from app.services import feedback_review as review_service
from app.services.feedback_materialization import FeedbackMaterializationError
from app.services.feedback_review import FeedbackReviewError

router = APIRouter(tags=["feedback"])


class FeedbackReviewItem(BaseModel):
    feedback_id: int
    decision: str
    comment: str | None = None


class FeedbackReviewRequest(BaseModel):
    items: list[FeedbackReviewItem] = Field(default_factory=list)


class FeedbackMaterializationCreate(BaseModel):
    endpoint_id: int
    feedback_ids: list[int] = Field(default_factory=list)


@router.get("/projects/{project_id}/feedback")
def list_feedback(
    project_id: int,
    endpoint_id: int | None = None,
    model_version_id: int | None = None,
    review_status: str | None = None,
    materialized: bool | None = None,
    materializable: bool | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    return review_service.list_feedback(
        db,
        project_id=project_id,
        endpoint_id=endpoint_id,
        model_version_id=model_version_id,
        review_status=review_status,
        materialized=materialized,
        materializable=materializable,
        skip=skip,
        limit=limit,
    )


@router.post("/projects/{project_id}/feedback/review")
def review_feedback(
    project_id: int,
    body: FeedbackReviewRequest,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    try:
        results = review_service.apply_review_decisions(
            db,
            project_id=project_id,
            items=[item.model_dump() for item in body.items],
            reviewer_id=auth.user.id,
        )
    except FeedbackReviewError as exc:
        raise friendly(exc.status_code, exc.message, exc.detail) from exc
    db.commit()
    return {"results": results, "count": len(results)}


@router.get("/projects/{project_id}/feedback-materializations")
def list_materializations(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    return materialization_service.list_runs(
        db, project_id=project_id, skip=skip, limit=limit
    )


@router.get("/projects/{project_id}/feedback-materializations/{run_id}")
def get_materialization(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    run = get_owned(
        db, FeedbackMaterializationRun, run_id, project_id, "Feedback materialization"
    )
    return materialization_service.run_out(run)


@router.post("/projects/{project_id}/feedback-materializations", status_code=201)
def create_materialization(
    project_id: int,
    body: FeedbackMaterializationCreate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    try:
        run = materialization_service.create_materialization_run(
            db,
            project_id=project_id,
            endpoint_id=body.endpoint_id,
            feedback_ids=list(body.feedback_ids),
            created_by=auth.user.id,
        )
    except FeedbackMaterializationError as exc:
        raise friendly(exc.status_code, exc.message, exc.detail) from exc
    db.commit()
    db.refresh(run)
    return materialization_service.run_out(run)
