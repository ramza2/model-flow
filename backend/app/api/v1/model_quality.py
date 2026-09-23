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
    ModelQualityBaselineSetRequest,
    ModelQualityPolicyCreate,
    ModelQualityPolicyUpdate,
)
from app.services import closed_loop_ux, model_quality as quality_service
from app.services import quality_policy as policy_service

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


def _endpoint_model_context(db: Session, endpoint: Endpoint) -> tuple[str, list[str]]:
    model = (
        db.get(ModelVersion, endpoint.model_version_id)
        if endpoint.model_version_id
        else None
    )
    return (
        quality_service.resolve_problem_type(db, model),
        quality_service.resolve_target_columns(db, model),
    )


def _apply_legacy_primary_fields(policy: ModelQualityPolicy, rules: list[dict[str, Any]]) -> None:
    if not rules:
        return
    first = rules[0]
    policy.primary_metric = first["metric"]
    policy.warning_threshold = float(first["warning_threshold"])
    policy.critical_threshold = float(first["critical_threshold"])


def _validate_policy_config(
    db: Session,
    *,
    endpoint: Endpoint,
    primary_metric: str,
    warning_threshold: float,
    critical_threshold: float,
    rules_raw: list[Any] | None,
    rule_logic: str,
    evaluation_delay_hours: int,
    minimum_match_rate: float | None,
) -> tuple[list[dict[str, Any]], str, str, float | None, int]:
    try:
        delay = policy_service.validate_evaluation_delay(evaluation_delay_hours)
        match_rate = policy_service.validate_match_rate(minimum_match_rate)
        logic = policy_service.validate_rule_logic(rule_logic)
        rules = policy_service.validate_and_normalize_rules(rules_raw)
        if not rules:
            primary = quality_service.validate_policy_metric_thresholds(
                primary_metric=primary_metric,
                warning_threshold=warning_threshold,
                critical_threshold=critical_threshold,
            )
            rules = [
                {
                    "metric": primary,
                    "target": None,
                    "comparison": "absolute",
                    "warning_threshold": float(warning_threshold),
                    "critical_threshold": float(critical_threshold),
                }
            ]
            # Legacy mode stores empty rules_json; return empty for persistence.
            problem_type, target_columns = _endpoint_model_context(db, endpoint)
            policy_service.validate_rules_against_model(
                rules, problem_type=problem_type, target_columns=target_columns
            )
            return [], logic, primary, match_rate, delay

        problem_type, target_columns = _endpoint_model_context(db, endpoint)
        policy_service.validate_rules_against_model(
            rules, problem_type=problem_type, target_columns=target_columns
        )
        primary = rules[0]["metric"]
        return rules, logic, primary, match_rate, delay
    except ValueError as exc:
        raise friendly(422, str(exc)) from exc


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
    return [quality_service.policy_out(row, db) for row in rows]


@router.post("/projects/{project_id}/model-quality/policies", status_code=201)
def create_quality_policy(
    project_id: int,
    body: ModelQualityPolicyCreate,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    endpoint = get_owned(db, Endpoint, body.endpoint_id, project_id, "Endpoint")
    rules_raw = (
        [rule.model_dump() for rule in body.rules] if body.rules is not None else None
    )
    if rules_raw is None or rules_raw == []:
        if body.primary_metric is None or body.warning_threshold is None or body.critical_threshold is None:
            raise friendly(
                422,
                "Legacy policies require primary_metric, warning_threshold, and critical_threshold.",
            )
        primary_metric = body.primary_metric
        warning_threshold = body.warning_threshold
        critical_threshold = body.critical_threshold
        persist_rules: list[dict[str, Any]] = []
    else:
        primary_metric = body.primary_metric or rules_raw[0]["metric"]
        warning_threshold = (
            body.warning_threshold
            if body.warning_threshold is not None
            else float(rules_raw[0]["warning_threshold"])
        )
        critical_threshold = (
            body.critical_threshold
            if body.critical_threshold is not None
            else float(rules_raw[0]["critical_threshold"])
        )
        persist_rules = rules_raw

    rules, logic, primary, match_rate, delay = _validate_policy_config(
        db,
        endpoint=endpoint,
        primary_metric=primary_metric,
        warning_threshold=float(warning_threshold),
        critical_threshold=float(critical_threshold),
        rules_raw=persist_rules if persist_rules else None,
        rule_logic=body.rule_logic,
        evaluation_delay_hours=body.evaluation_delay_hours,
        minimum_match_rate=body.minimum_match_rate,
    )
    # When advanced rules provided, persist them; legacy keeps [].
    stored_rules = rules if persist_rules else []
    if stored_rules:
        warning_threshold = float(stored_rules[0]["warning_threshold"])
        critical_threshold = float(stored_rules[0]["critical_threshold"])
        primary = stored_rules[0]["metric"]
    else:
        # Re-validate legacy single metric (already done inside helper for empty list path)
        pass

    policy = ModelQualityPolicy(
        project_id=project_id,
        endpoint_id=endpoint.id,
        name=body.name.strip(),
        is_active=body.is_active,
        window_hours=body.window_hours,
        evaluation_delay_hours=delay,
        minimum_matched_samples=body.minimum_matched_samples,
        minimum_match_rate=match_rate,
        primary_metric=primary,
        warning_threshold=float(warning_threshold),
        critical_threshold=float(critical_threshold),
        consecutive_breaches=body.consecutive_breaches,
        cooldown_hours=body.cooldown_hours,
        auto_retrain=body.auto_retrain,
        revision=1,
        rule_logic=logic,
        rules_json=policy_service.dumps(stored_rules),
        created_by=auth.user.id,
    )
    if stored_rules:
        _apply_legacy_primary_fields(policy, stored_rules)
    db.add(policy)
    db.flush()
    audit_event(
        db,
        auth,
        "model_quality_policy.create",
        "model_quality_policy",
        policy.id,
        after=quality_service.policy_out(policy, db),
    )
    db.commit()
    db.refresh(policy)
    return quality_service.policy_out(policy, db)


@router.get("/projects/{project_id}/model-quality/policies/{policy_id}")
def get_quality_policy(
    project_id: int,
    policy_id: int,
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    return quality_service.policy_out(
        get_owned(db, ModelQualityPolicy, policy_id, project_id, "Quality policy"),
        db,
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
    # Row lock so concurrent baseline set/clear/PATCH cannot lose revision bumps.
    policy = policy_service.lock_policy_for_update(db, policy_id)
    if policy is None or policy.project_id != project_id:
        raise friendly(404, "Quality policy was not found.")
    before = quality_service.policy_out(policy, db)
    before_semantic = policy_service.semantic_config_from_policy(policy)
    data = body.model_dump(exclude_unset=True)
    endpoint = get_owned(db, Endpoint, policy.endpoint_id, project_id, "Endpoint")

    if "name" in data and data["name"] is not None:
        policy.name = str(data["name"]).strip()
    if "is_active" in data and data["is_active"] is not None:
        policy.is_active = bool(data["is_active"])

    # Merge patch onto current config then validate wholly.
    current_rules = policy_service._loads(policy.rules_json, [])
    merged_rules = current_rules if isinstance(current_rules, list) else []
    if "rules" in data:
        merged_rules = data["rules"] if data["rules"] is not None else []

    primary_metric = data.get("primary_metric", policy.primary_metric)
    warning_threshold = data.get("warning_threshold", policy.warning_threshold)
    critical_threshold = data.get("critical_threshold", policy.critical_threshold)
    rule_logic = data.get("rule_logic", policy.rule_logic)
    evaluation_delay_hours = data.get(
        "evaluation_delay_hours", policy.evaluation_delay_hours
    )
    minimum_match_rate = (
        data["minimum_match_rate"]
        if "minimum_match_rate" in data
        else policy.minimum_match_rate
    )

    for field in (
        "window_hours",
        "minimum_matched_samples",
        "consecutive_breaches",
        "cooldown_hours",
        "auto_retrain",
    ):
        if field in data and data[field] is not None:
            setattr(policy, field, data[field])

    # Determine whether caller is switching to/from advanced rules.
    advanced_requested = "rules" in data
    if advanced_requested and (merged_rules is None or merged_rules == []):
        # Clear advanced rules → legacy mode using primary fields.
        rules, logic, primary, match_rate, delay = _validate_policy_config(
            db,
            endpoint=endpoint,
            primary_metric=str(primary_metric),
            warning_threshold=float(warning_threshold),
            critical_threshold=float(critical_threshold),
            rules_raw=None,
            rule_logic=str(rule_logic or "any"),
            evaluation_delay_hours=int(evaluation_delay_hours or 0),
            minimum_match_rate=minimum_match_rate,
        )
        policy.rules_json = "[]"
        policy.primary_metric = primary
        policy.warning_threshold = float(warning_threshold)
        policy.critical_threshold = float(critical_threshold)
    elif advanced_requested:
        rules, logic, primary, match_rate, delay = _validate_policy_config(
            db,
            endpoint=endpoint,
            primary_metric=str(primary_metric or "f1_macro"),
            warning_threshold=float(
                warning_threshold
                if warning_threshold is not None
                else merged_rules[0]["warning_threshold"]
            ),
            critical_threshold=float(
                critical_threshold
                if critical_threshold is not None
                else merged_rules[0]["critical_threshold"]
            ),
            rules_raw=merged_rules,
            rule_logic=str(rule_logic or "any"),
            evaluation_delay_hours=int(evaluation_delay_hours or 0),
            minimum_match_rate=minimum_match_rate,
        )
        policy.rules_json = policy_service.dumps(rules)
        _apply_legacy_primary_fields(policy, rules)
    else:
        # No rules patch: keep mode; still validate merged primary + existing rules.
        existing = policy_service._loads(policy.rules_json, [])
        rules, logic, primary, match_rate, delay = _validate_policy_config(
            db,
            endpoint=endpoint,
            primary_metric=str(primary_metric),
            warning_threshold=float(warning_threshold),
            critical_threshold=float(critical_threshold),
            rules_raw=existing if isinstance(existing, list) and existing else None,
            rule_logic=str(rule_logic or "any"),
            evaluation_delay_hours=int(evaluation_delay_hours or 0),
            minimum_match_rate=minimum_match_rate,
        )
        if isinstance(existing, list) and existing:
            policy.rules_json = policy_service.dumps(rules)
            _apply_legacy_primary_fields(policy, rules)
        else:
            policy.primary_metric = primary
            policy.warning_threshold = float(warning_threshold)
            policy.critical_threshold = float(critical_threshold)

    policy.rule_logic = logic
    policy.evaluation_delay_hours = delay
    policy.minimum_match_rate = match_rate
    policy.updated_at = datetime.now(timezone.utc)

    after_semantic = policy_service.semantic_config_from_policy(policy)
    if not policy_service.configs_semantically_equal(before_semantic, after_semantic):
        policy.revision = int(getattr(policy, "revision", 1) or 1) + 1

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
        after=quality_service.policy_out(policy, db),
    )
    db.commit()
    db.refresh(policy)
    return quality_service.policy_out(policy, db)


@router.post(
    "/projects/{project_id}/model-quality/policies/{policy_id}/baseline",
    status_code=201,
)
def set_quality_baseline(
    project_id: int,
    policy_id: int,
    body: ModelQualityBaselineSetRequest,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    # Lock-first so concurrent baseline/PATCH cannot operate on a stale revision.
    policy = policy_service.lock_policy_for_update(db, policy_id)
    if policy is None or policy.project_id != project_id:
        raise friendly(404, "Quality policy was not found.")
    before = quality_service.policy_out(policy, db)
    try:
        baseline = policy_service.set_baseline(
            db,
            policy=policy,
            quality_run_id=body.quality_run_id,
            created_by=auth.user.id,
        )
    except ValueError as exc:
        raise friendly(422, str(exc)) from exc
    audit_event(
        db,
        auth,
        "model_quality_policy.baseline_set",
        "model_quality_policy",
        policy.id,
        before=before,
        after=quality_service.policy_out(policy, db),
    )
    db.commit()
    db.refresh(policy)
    return {
        "policy": quality_service.policy_out(policy, db),
        "baseline": policy_service.baseline_out(baseline),
    }


@router.delete("/projects/{project_id}/model-quality/policies/{policy_id}/baseline")
def clear_quality_baseline(
    project_id: int,
    policy_id: int,
    access=Depends(require_project_perm(Permission.MONITOR_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    policy = policy_service.lock_policy_for_update(db, policy_id)
    if policy is None or policy.project_id != project_id:
        raise friendly(404, "Quality policy was not found.")
    before = quality_service.policy_out(policy, db)
    cleared = policy_service.clear_baseline(db, policy=policy)
    if not cleared:
        raise friendly(404, "No baseline is set for this policy.")
    audit_event(
        db,
        auth,
        "model_quality_policy.baseline_clear",
        "model_quality_policy",
        policy.id,
        before=before,
        after=quality_service.policy_out(policy, db),
    )
    db.commit()
    db.refresh(policy)
    return quality_service.policy_out(policy, db)


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
    model_version_id: int | None = None,
    quality_status: str | None = None,
    status: str | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    paged: bool = Query(
        default=False,
        description="When true, return {items,total,skip,limit} instead of a bare list.",
    ),
    _=Depends(require_project_perm(Permission.MONITOR_READ)),
    db: Session = Depends(get_db),
):
    from sqlalchemy import func

    filters = [ModelQualityRun.project_id == project_id]
    if endpoint_id is not None:
        filters.append(ModelQualityRun.endpoint_id == endpoint_id)
    if policy_id is not None:
        filters.append(ModelQualityRun.policy_id == policy_id)
    if model_version_id is not None:
        filters.append(ModelQualityRun.model_version_id == model_version_id)
    if quality_status is not None:
        filters.append(ModelQualityRun.quality_status == quality_status.strip().lower())
    if status is not None:
        filters.append(ModelQualityRun.status == status.strip().lower())

    statement = select(ModelQualityRun).where(*filters)
    rows = db.scalars(
        statement.order_by(ModelQualityRun.id.desc()).offset(skip).limit(limit)
    ).all()
    items = [quality_service.quality_run_out(row) for row in rows]
    if not paged:
        return items
    total = int(db.scalar(select(func.count()).select_from(ModelQualityRun).where(*filters)) or 0)
    return {"items": items, "total": total, "skip": skip, "limit": limit}


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
        baseline = policy_service.get_baseline_for_policy(db, policy.id)
        effective = policy_service.effective_quality_rules(policy)
        evaluation = (
            quality_service._loads(latest.evaluation_json, {}) if latest else {}
        )
        closed_loop_detail = closed_loop_ux.compute_closed_loop_detail(
            db,
            project_id=project_id,
            endpoint_id=policy.endpoint_id,
            policy=policy,
        )
        decision = (
            quality_service._loads(latest.trigger_decision_json, {}) if latest else {}
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
                "closed_loop_state": closed_loop_ux.compute_closed_loop_state_label(
                    closed_loop_detail
                ),
                "closed_loop": closed_loop_detail,
                "latest_run_id": latest.id if latest else None,
                "latest_trigger_decision": decision if latest else None,
                "revision": int(getattr(policy, "revision", 1) or 1),
                "mode": policy_service.policy_mode(policy),
                "rule_logic": str(getattr(policy, "rule_logic", "any") or "any"),
                "rule_count": len(effective),
                "evaluation_delay_hours": int(
                    getattr(policy, "evaluation_delay_hours", 0) or 0
                ),
                "minimum_match_rate": getattr(policy, "minimum_match_rate", None),
                "minimum_matched_samples": int(
                    getattr(policy, "minimum_matched_samples", 0) or 0
                ),
                "baseline_quality_run_id": baseline.quality_run_id if baseline else None,
                "baseline_model_version_id": (
                    baseline.model_version_id if baseline else None
                ),
                "baseline_required": any(
                    rule.get("comparison") == "baseline_delta" for rule in effective
                )
                and baseline is None,
                "latest_evaluation": evaluation if latest else None,
                "latest_policy_revision": latest.policy_revision if latest else None,
            }
        )
    return {"items": cards}
