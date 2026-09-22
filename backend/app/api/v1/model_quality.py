"""Model quality policies/runs and ground-truth feedback APIs."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, dumps, friendly, get_owned
from app.core.deps import (
    ServiceApiKeyContext,
    authenticate_service_api_key,
    authorize_service_key_for_endpoint,
    require_project_perm,
)
from app.core.rbac import Permission
from app.db.models import (
    Endpoint,
    GroundTruthFeedback,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
    PredictionObservation,
)
from app.db.session import get_db
from app.schemas.v1 import (
    GroundTruthBatchRequest,
    ModelQualityPolicyCreate,
    ModelQualityPolicyUpdate,
)
from app.services import closed_loop, model_quality as quality_service

router = APIRouter(tags=["model-quality"])


def _parse_observed_at(value: str | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _submit_ground_truth_items(
    db: Session,
    *,
    project_id: int,
    items: list[dict[str, Any]],
    source: str,
    submitted_by: int | None = None,
    service_api_key_id: int | None = None,
    allowed_endpoint_id: int | None = None,
) -> dict[str, Any]:
    accepted: list[dict[str, Any]] = []
    for item in items:
        prediction_id = str(item.get("prediction_id") or "").strip()
        if not prediction_id:
            raise friendly(422, "prediction_id is required for each ground-truth item.")
        observation = db.get(PredictionObservation, prediction_id)
        if (
            observation is None
            or observation.project_id != project_id
            or (
                allowed_endpoint_id is not None
                and observation.endpoint_id != allowed_endpoint_id
            )
        ):
            raise friendly(404, f"Prediction '{prediction_id}' was not found.")

        model = (
            db.get(ModelVersion, observation.model_version_id)
            if observation.model_version_id
            else None
        )
        problem_type = quality_service.resolve_problem_type(db, model)
        target_columns = quality_service.resolve_target_columns(db, model)
        try:
            normalized = quality_service.normalize_actual(
                item.get("actual"),
                target_columns=target_columns or ["target"],
                problem_type=problem_type,
            )
        except ValueError as exc:
            raise friendly(422, str(exc)) from exc

        existing = db.scalar(
            select(GroundTruthFeedback).where(
                GroundTruthFeedback.prediction_observation_id == prediction_id
            )
        )
        if existing is not None:
            previous = quality_service._loads(existing.actual_json, None)
            if quality_service.actuals_equal(previous, normalized):
                accepted.append(
                    {
                        "prediction_id": prediction_id,
                        "ground_truth_id": existing.id,
                        "idempotent": True,
                    }
                )
                continue
            raise friendly(
                409,
                "Ground truth already exists for this prediction with a different actual.",
                "Phase 5-A does not overwrite accepted ground truth.",
            )

        row = GroundTruthFeedback(
            project_id=project_id,
            prediction_observation_id=prediction_id,
            actual_json=dumps(normalized),
            observed_at=_parse_observed_at(item.get("observed_at")),
            source=source,
            submitted_by=submitted_by,
            service_api_key_id=service_api_key_id,
            review_status="PENDING",
        )
        db.add(row)
        try:
            with db.begin_nested():
                db.flush()
        except IntegrityError as exc:
            # Concurrent insert of the same prediction_observation_id.
            existing = db.scalar(
                select(GroundTruthFeedback).where(
                    GroundTruthFeedback.prediction_observation_id == prediction_id
                )
            )
            if existing is None:
                raise friendly(409, "Ground truth could not be stored.") from exc
            previous = quality_service._loads(existing.actual_json, None)
            if quality_service.actuals_equal(previous, normalized):
                accepted.append(
                    {
                        "prediction_id": prediction_id,
                        "ground_truth_id": existing.id,
                        "idempotent": True,
                    }
                )
                continue
            raise friendly(
                409,
                "Ground truth already exists for this prediction with a different actual.",
            ) from exc
        accepted.append(
            {
                "prediction_id": prediction_id,
                "ground_truth_id": row.id,
                "idempotent": False,
            }
        )
    return {"accepted": accepted, "count": len(accepted)}


@router.post("/projects/{project_id}/ground-truth")
def submit_ground_truth(
    project_id: int,
    body: GroundTruthBatchRequest,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    if not body.items:
        raise friendly(422, "At least one ground-truth item is required.")
    result = _submit_ground_truth_items(
        db,
        project_id=project_id,
        items=[item.model_dump() for item in body.items],
        source="project_api",
        submitted_by=auth.user.id,
    )
    db.commit()
    return result


@router.post("/inference/endpoints/{endpoint_id}/ground-truth")
def submit_ground_truth_external(
    endpoint_id: int,
    body: GroundTruthBatchRequest,
    ctx: ServiceApiKeyContext = Depends(authenticate_service_api_key),
    db: Session = Depends(get_db),
):
    endpoint = authorize_service_key_for_endpoint(db, ctx, endpoint_id)
    if not body.items:
        raise friendly(422, "At least one ground-truth item is required.")
    result = _submit_ground_truth_items(
        db,
        project_id=endpoint.project_id,
        items=[item.model_dump() for item in body.items],
        source="service_api_key",
        service_api_key_id=ctx.key.id,
        allowed_endpoint_id=endpoint.id,
    )
    db.commit()
    return result


@router.get("/projects/{project_id}/model-quality/policies")
def list_quality_policies(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(ModelQualityPolicy)
        .where(ModelQualityPolicy.project_id == project_id)
        .order_by(ModelQualityPolicy.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [quality_service.policy_out(row) for row in rows]


@router.post("/projects/{project_id}/model-quality/policies", status_code=201)
def create_quality_policy(
    project_id: int,
    body: ModelQualityPolicyCreate,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    endpoint = get_owned(db, Endpoint, body.endpoint_id, project_id, "Endpoint")
    try:
        primary_metric = quality_service.validate_policy_metric_thresholds(
            primary_metric=body.primary_metric,
            warning_threshold=body.warning_threshold,
            critical_threshold=body.critical_threshold,
        )
    except ValueError as exc:
        raise friendly(422, str(exc)) from exc
    policy = ModelQualityPolicy(
        project_id=project_id,
        endpoint_id=endpoint.id,
        name=body.name.strip(),
        is_active=body.is_active,
        window_hours=body.window_hours,
        minimum_matched_samples=body.minimum_matched_samples,
        primary_metric=primary_metric,
        warning_threshold=body.warning_threshold,
        critical_threshold=body.critical_threshold,
        consecutive_breaches=body.consecutive_breaches,
        cooldown_hours=body.cooldown_hours,
        auto_retrain=body.auto_retrain,
        created_by=auth.user.id,
    )
    db.add(policy)
    db.flush()
    audit_event(
        db,
        auth,
        "model_quality_policy.create",
        "model_quality_policy",
        policy.id,
        after=quality_service.policy_out(policy),
    )
    db.commit()
    db.refresh(policy)
    return quality_service.policy_out(policy)


@router.get("/projects/{project_id}/model-quality/policies/{policy_id}")
def get_quality_policy(
    project_id: int,
    policy_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    return quality_service.policy_out(
        get_owned(db, ModelQualityPolicy, policy_id, project_id, "Quality policy")
    )


@router.patch("/projects/{project_id}/model-quality/policies/{policy_id}")
def update_quality_policy(
    project_id: int,
    policy_id: int,
    body: ModelQualityPolicyUpdate,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    policy = get_owned(db, ModelQualityPolicy, policy_id, project_id, "Quality policy")
    before = quality_service.policy_out(policy)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        policy.name = str(data["name"]).strip()
    for field in (
        "is_active",
        "window_hours",
        "minimum_matched_samples",
        "primary_metric",
        "warning_threshold",
        "critical_threshold",
        "consecutive_breaches",
        "cooldown_hours",
        "auto_retrain",
    ):
        if field in data and data[field] is not None:
            setattr(policy, field, data[field])
    try:
        policy.primary_metric = quality_service.validate_policy_metric_thresholds(
            primary_metric=policy.primary_metric,
            warning_threshold=policy.warning_threshold,
            critical_threshold=policy.critical_threshold,
        )
    except ValueError as exc:
        raise friendly(422, str(exc)) from exc
    policy.updated_at = datetime.now(timezone.utc)
    action = "model_quality_policy.update"
    if "is_active" in data and data["is_active"] is not None:
        action = (
            "model_quality_policy.enable"
            if policy.is_active
            else "model_quality_policy.disable"
        )
    audit_event(
        db,
        auth,
        action,
        "model_quality_policy",
        policy.id,
        before=before,
        after=quality_service.policy_out(policy),
    )
    db.commit()
    db.refresh(policy)
    return quality_service.policy_out(policy)


@router.post("/projects/{project_id}/model-quality/policies/{policy_id}/evaluate", status_code=201)
def evaluate_quality_policy(
    project_id: int,
    policy_id: int,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    policy = get_owned(db, ModelQualityPolicy, policy_id, project_id, "Quality policy")
    if not policy.is_active:
        raise friendly(409, "Cannot evaluate an inactive quality policy.")
    run = quality_service.enqueue_quality_run(
        db, policy=policy, created_by=auth.user.id
    )
    db.commit()
    db.refresh(run)
    return quality_service.quality_run_out(run)


@router.get("/projects/{project_id}/model-quality/runs")
def list_quality_runs(
    project_id: int,
    endpoint_id: int | None = None,
    policy_id: int | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    statement = select(ModelQualityRun).where(ModelQualityRun.project_id == project_id)
    if endpoint_id is not None:
        statement = statement.where(ModelQualityRun.endpoint_id == endpoint_id)
    if policy_id is not None:
        statement = statement.where(ModelQualityRun.policy_id == policy_id)
    rows = db.scalars(
        statement.order_by(ModelQualityRun.id.desc()).offset(skip).limit(limit)
    ).all()
    return [quality_service.quality_run_out(row) for row in rows]


@router.get("/projects/{project_id}/model-quality/runs/{run_id}")
def get_quality_run(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    return quality_service.quality_run_out(
        get_owned(db, ModelQualityRun, run_id, project_id, "Quality run")
    )


@router.get("/projects/{project_id}/model-quality/summary")
def quality_summary(
    project_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    """Monitoring Production Quality cards derived from policies and latest runs."""

    from app.db.models import JobStatus

    policies = db.scalars(
        select(ModelQualityPolicy)
        .where(
            ModelQualityPolicy.project_id == project_id,
            ModelQualityPolicy.is_active.is_(True),
        )
        .order_by(ModelQualityPolicy.id.desc())
    ).all()
    cards: list[dict[str, Any]] = []
    for policy in policies:
        endpoint = db.get(Endpoint, policy.endpoint_id)
        latest = db.scalar(
            select(ModelQualityRun)
            .where(
                ModelQualityRun.policy_id == policy.id,
                ModelQualityRun.status == JobStatus.succeeded,
            )
            .order_by(ModelQualityRun.id.desc())
        )
        model = (
            db.get(ModelVersion, endpoint.model_version_id)
            if endpoint and endpoint.model_version_id
            else None
        )
        metrics = quality_service._loads(latest.metrics_json, {}) if latest else {}
        primary_value = (
            quality_service.extract_primary_metric_value(metrics, policy.primary_metric)
            if latest
            else None
        )
        cards.append(
            {
                "policy_id": policy.id,
                "policy_name": policy.name,
                "endpoint_id": policy.endpoint_id,
                "endpoint_name": endpoint.name if endpoint else None,
                "current_model_version_id": endpoint.model_version_id if endpoint else None,
                "current_model_name": model.name if model else None,
                "current_model_version": model.version if model else None,
                "latest_quality_status": latest.quality_status if latest else None,
                "primary_metric": policy.primary_metric,
                "primary_metric_value": primary_value,
                "matched_ground_truth_count": (
                    latest.matched_ground_truth_count if latest else 0
                ),
                "prediction_count": latest.prediction_count if latest else 0,
                "match_rate": latest.match_rate if latest else None,
                "window_start": latest.window_start if latest else None,
                "window_end": latest.window_end if latest else None,
                "last_evaluated_at": latest.finished_at if latest else None,
                "closed_loop_state": closed_loop.compute_closed_loop_state(
                    db, project_id=project_id, endpoint_id=policy.endpoint_id
                ),
                "latest_run_id": latest.id if latest else None,
            }
        )
    return {"items": cards}
