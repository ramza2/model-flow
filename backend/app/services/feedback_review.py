"""Feedback review eligibility, transitions, and listing (Phase 5-B)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.db.models import (
    Endpoint,
    FeedbackReviewStatus,
    GroundTruthFeedback,
    ModelVersion,
    PredictionObservation,
)


class FeedbackReviewError(Exception):
    def __init__(self, status_code: int, message: str, detail: str | None = None):
        self.status_code = status_code
        self.message = message
        self.detail = detail
        super().__init__(message)


def _loads(value: str | None, default: Any = None) -> Any:
    if default is None:
        default = None
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def is_materializable(observation: PredictionObservation | None) -> bool:
    if observation is None:
        return False
    return bool(observation.input_json and str(observation.input_json).strip())


def is_materialized(feedback: GroundTruthFeedback) -> bool:
    return feedback.materialized_dataset_version_id is not None


def is_reserved(feedback: GroundTruthFeedback) -> bool:
    return feedback.materialization_run_id is not None


def review_mutable(feedback: GroundTruthFeedback) -> bool:
    return not is_reserved(feedback) and not is_materialized(feedback)


def feedback_out(
    db: Session,
    feedback: GroundTruthFeedback,
    *,
    observation: PredictionObservation | None = None,
    endpoint: Endpoint | None = None,
    model: ModelVersion | None = None,
) -> dict[str, Any]:
    observation = observation or db.get(
        PredictionObservation, feedback.prediction_observation_id
    )
    endpoint = endpoint or (
        db.get(Endpoint, observation.endpoint_id) if observation else None
    )
    model = model or (
        db.get(ModelVersion, observation.model_version_id)
        if observation and observation.model_version_id
        else None
    )
    materializable = is_materializable(observation)
    return {
        "id": feedback.id,
        "project_id": feedback.project_id,
        "prediction_id": feedback.prediction_observation_id,
        "endpoint_id": observation.endpoint_id if observation else None,
        "endpoint_name": endpoint.name if endpoint else None,
        "model_version_id": observation.model_version_id if observation else None,
        "model_name": model.name if model else None,
        "model_version": model.version if model else None,
        "predicted_value": _loads(observation.prediction_json if observation else None),
        "actual_value": _loads(feedback.actual_json),
        "predicted_at": observation.predicted_at.isoformat() if observation else None,
        "observed_at": feedback.observed_at.isoformat() if feedback.observed_at else None,
        "review_status": feedback.review_status,
        "reviewed_by": feedback.reviewed_by,
        "reviewed_at": feedback.reviewed_at.isoformat() if feedback.reviewed_at else None,
        "review_comment": feedback.review_comment,
        "input_snapshot_available": materializable,
        "materializable": (
            materializable
            and feedback.review_status == FeedbackReviewStatus.APPROVED.value
            and not is_materialized(feedback)
            and not is_reserved(feedback)
        ),
        "materialization_run_id": feedback.materialization_run_id,
        "materialized_dataset_version_id": feedback.materialized_dataset_version_id,
        "created_at": feedback.created_at.isoformat() if feedback.created_at else None,
    }


def list_feedback(
    db: Session,
    *,
    project_id: int,
    endpoint_id: int | None = None,
    model_version_id: int | None = None,
    review_status: str | None = None,
    materialized: bool | None = None,
    materializable: bool | None = None,
    skip: int = 0,
    limit: int = 100,
) -> list[dict[str, Any]]:
    query = (
        select(GroundTruthFeedback, PredictionObservation)
        .join(
            PredictionObservation,
            PredictionObservation.id == GroundTruthFeedback.prediction_observation_id,
        )
        .where(GroundTruthFeedback.project_id == project_id)
    )
    if endpoint_id is not None:
        query = query.where(PredictionObservation.endpoint_id == endpoint_id)
    if model_version_id is not None:
        query = query.where(PredictionObservation.model_version_id == model_version_id)
    if review_status:
        query = query.where(GroundTruthFeedback.review_status == review_status.upper())
    if materialized is True:
        query = query.where(GroundTruthFeedback.materialized_dataset_version_id.is_not(None))
    elif materialized is False:
        query = query.where(GroundTruthFeedback.materialized_dataset_version_id.is_(None))

    rows = db.execute(
        query.order_by(GroundTruthFeedback.id.desc()).offset(skip).limit(limit)
    ).all()

    results: list[dict[str, Any]] = []
    for feedback, observation in rows:
        item = feedback_out(db, feedback, observation=observation)
        if materializable is True and not item["materializable"]:
            continue
        if materializable is False and item["materializable"]:
            continue
        results.append(item)
    return results


def apply_review_decisions(
    db: Session,
    *,
    project_id: int,
    items: list[dict[str, Any]],
    reviewer_id: int,
) -> list[dict[str, Any]]:
    if not items:
        raise FeedbackReviewError(422, "At least one review item is required.")

    seen: set[int] = set()
    results: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)

    for raw in items:
        feedback_id = raw.get("feedback_id")
        decision = str(raw.get("decision") or "").strip().lower()
        comment = raw.get("comment")
        if feedback_id is None:
            raise FeedbackReviewError(422, "feedback_id is required for each item.")
        try:
            feedback_id = int(feedback_id)
        except (TypeError, ValueError) as exc:
            raise FeedbackReviewError(422, "feedback_id must be an integer.") from exc
        if feedback_id in seen:
            raise FeedbackReviewError(422, f"Duplicate feedback_id {feedback_id}.")
        seen.add(feedback_id)
        if decision not in {"approved", "rejected"}:
            raise FeedbackReviewError(
                422, "decision must be 'approved' or 'rejected'."
            )

        feedback = db.get(GroundTruthFeedback, feedback_id)
        if feedback is None or feedback.project_id != project_id:
            raise FeedbackReviewError(404, f"Feedback #{feedback_id} was not found.")

        if not review_mutable(feedback):
            raise FeedbackReviewError(
                409,
                f"Feedback #{feedback_id} can no longer be reviewed.",
                "Materialized or reserved feedback review decisions are immutable.",
            )

        target = (
            FeedbackReviewStatus.APPROVED.value
            if decision == "approved"
            else FeedbackReviewStatus.REJECTED.value
        )
        previous = feedback.review_status
        idempotent = previous == target
        if not idempotent:
            feedback.review_status = target
            feedback.reviewed_by = reviewer_id
            feedback.reviewed_at = now
            if comment is not None:
                feedback.review_comment = str(comment)
            write_audit(
                db,
                action=(
                    "feedback.review.approve"
                    if decision == "approved"
                    else "feedback.review.reject"
                ),
                resource_type="ground_truth_feedback",
                resource_id=feedback.id,
                user_id=reviewer_id,
                before={"review_status": previous},
                after={
                    "review_status": feedback.review_status,
                    "comment": feedback.review_comment,
                },
            )
        elif comment is not None and feedback.review_comment != str(comment):
            # Same decision: allow optional comment update only when still mutable.
            feedback.review_comment = str(comment)

        results.append(
            {
                "feedback_id": feedback.id,
                "review_status": feedback.review_status,
                "idempotent": idempotent,
            }
        )

    db.flush()
    return results
