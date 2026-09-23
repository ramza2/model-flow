"""Phase 5-C advanced quality policy helpers: rules, validation, snapshots, baselines."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Endpoint,
    JobStatus,
    ModelQualityBaseline,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
)
from app.services import model_quality as quality_service

COMPARISON_ABSOLUTE = "absolute"
COMPARISON_BASELINE_DELTA = "baseline_delta"
SUPPORTED_COMPARISONS = frozenset({COMPARISON_ABSOLUTE, COMPARISON_BASELINE_DELTA})
SUPPORTED_RULE_LOGIC = frozenset({"any", "all"})
MAX_RULES = 10
SEMANTIC_FIELDS = (
    "window_hours",
    "evaluation_delay_hours",
    "minimum_matched_samples",
    "minimum_match_rate",
    "rules",
    "rule_logic",
    "consecutive_breaches",
    "cooldown_hours",
    "auto_retrain",
)


def _loads(value: str | None, default: Any = None) -> Any:
    if default is None:
        default = {}
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def dumps(value: Any) -> str:
    return json.dumps(value, default=str)


def _finite(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a finite number.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number.")
    return number


def normalize_rule(raw: dict[str, Any]) -> dict[str, Any]:
    metric = str(raw.get("metric") or "").strip().lower()
    if metric not in quality_service.SUPPORTED_PRIMARY_METRICS:
        raise ValueError(
            "Unsupported metric. "
            f"Allowed: {', '.join(sorted(quality_service.SUPPORTED_PRIMARY_METRICS))}."
        )
    comparison = str(raw.get("comparison") or COMPARISON_ABSOLUTE).strip().lower()
    if comparison not in SUPPORTED_COMPARISONS:
        raise ValueError("comparison must be 'absolute' or 'baseline_delta'.")
    target_raw = raw.get("target")
    target = None if target_raw in (None, "") else str(target_raw)
    warning = _finite(raw.get("warning_threshold"), "warning_threshold")
    critical = _finite(raw.get("critical_threshold"), "critical_threshold")

    if comparison == COMPARISON_ABSOLUTE:
        if metric in quality_service.CLASSIFICATION_METRICS:
            for label, value in (("warning_threshold", warning), ("critical_threshold", critical)):
                if value < 0.0 or value > 1.0:
                    raise ValueError(f"{label} for {metric} must be between 0 and 1.")
        if metric in {"mae", "rmse"}:
            for label, value in (("warning_threshold", warning), ("critical_threshold", critical)):
                if value < 0.0:
                    raise ValueError(f"{label} for {metric} must be >= 0.")
        if quality_service.metric_is_higher_better(metric):
            if critical > warning:
                raise ValueError(
                    "For higher-is-better absolute rules, critical_threshold must be "
                    "<= warning_threshold."
                )
        elif critical < warning:
            raise ValueError(
                "For lower-is-better absolute rules, critical_threshold must be "
                ">= warning_threshold."
            )
    else:
        if warning < 0.0 or critical < 0.0:
            raise ValueError("baseline_delta thresholds must be >= 0.")
        if warning > critical:
            raise ValueError(
                "For baseline_delta rules, warning_threshold must be <= critical_threshold."
            )

    return {
        "metric": metric,
        "target": target,
        "comparison": comparison,
        "warning_threshold": warning,
        "critical_threshold": critical,
    }


def validate_rules_against_model(
    rules: list[dict[str, Any]],
    *,
    problem_type: str,
    target_columns: list[str],
) -> None:
    allowed = (
        quality_service.REGRESSION_METRICS
        if problem_type == "regression"
        else quality_service.CLASSIFICATION_METRICS
    )
    multi = len(target_columns) > 1
    for rule in rules:
        if rule["metric"] not in allowed:
            raise ValueError(
                f"Metric '{rule['metric']}' is incompatible with {problem_type} models."
            )
        if rule["target"] is not None:
            if problem_type != "regression" or not multi:
                raise ValueError(
                    "target is only allowed for multi-output regression rules."
                )
            if rule["target"] not in target_columns:
                raise ValueError(f"Unknown target '{rule['target']}'.")
        elif multi and rule["target"] is None:
            # aggregate is allowed via target=null
            pass


def validate_and_normalize_rules(raw_rules: list[Any] | None) -> list[dict[str, Any]]:
    if raw_rules is None:
        return []
    if not isinstance(raw_rules, list):
        raise ValueError("rules must be a list.")
    if len(raw_rules) > MAX_RULES:
        raise ValueError(f"A policy may define at most {MAX_RULES} rules.")
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str | None, str]] = set()
    for item in raw_rules:
        if not isinstance(item, dict):
            raise ValueError("Each rule must be an object.")
        rule = normalize_rule(item)
        key = (rule["metric"], rule["target"], rule["comparison"])
        if key in seen:
            raise ValueError(
                "Duplicate rules are not allowed "
                f"(metric={rule['metric']}, target={rule['target']}, "
                f"comparison={rule['comparison']})."
            )
        seen.add(key)
        normalized.append(rule)
    return normalized


def effective_quality_rules(
    policy_or_snapshot: ModelQualityPolicy | dict[str, Any],
) -> list[dict[str, Any]]:
    if isinstance(policy_or_snapshot, dict):
        rules = policy_or_snapshot.get("effective_rules")
        if isinstance(rules, list) and rules:
            return [normalize_rule(row) for row in rules]
        rules = policy_or_snapshot.get("rules")
        if isinstance(rules, list) and rules:
            return [normalize_rule(row) for row in rules]
        return [
            {
                "metric": str(policy_or_snapshot.get("primary_metric") or "").lower(),
                "target": None,
                "comparison": COMPARISON_ABSOLUTE,
                "warning_threshold": float(policy_or_snapshot["warning_threshold"]),
                "critical_threshold": float(policy_or_snapshot["critical_threshold"]),
            }
        ]

    stored = _loads(policy_or_snapshot.rules_json, [])
    if isinstance(stored, list) and stored:
        return [normalize_rule(row) for row in stored]
    return [
        {
            "metric": str(policy_or_snapshot.primary_metric).lower(),
            "target": None,
            "comparison": COMPARISON_ABSOLUTE,
            "warning_threshold": float(policy_or_snapshot.warning_threshold),
            "critical_threshold": float(policy_or_snapshot.critical_threshold),
        }
    ]


def policy_mode(policy: ModelQualityPolicy) -> str:
    stored = _loads(policy.rules_json, [])
    return "advanced" if isinstance(stored, list) and stored else "legacy"


def snapshot_mode(snapshot: dict[str, Any]) -> str:
    """Resolve legacy|advanced from an immutable run snapshot."""

    mode = snapshot.get("mode")
    if mode in {"legacy", "advanced"}:
        return str(mode)
    # Older Phase 5-C snapshots always populated effective_rules without mode.
    # Prefer explicit stored rules list when present; otherwise treat a single
    # absolute primary-aligned rule as legacy.
    stored_rules = snapshot.get("rules")
    if isinstance(stored_rules, list):
        return "advanced" if stored_rules else "legacy"
    rules = snapshot.get("effective_rules")
    if not isinstance(rules, list) or not rules:
        return "legacy"
    if (
        len(rules) == 1
        and str(rules[0].get("comparison") or "absolute").lower() == "absolute"
        and rules[0].get("target") in (None, "")
        and str(rules[0].get("metric") or "").lower()
        == str(snapshot.get("primary_metric") or "").lower()
    ):
        return "legacy"
    return "advanced"


def semantic_config_from_policy(policy: ModelQualityPolicy) -> dict[str, Any]:
    return {
        "window_hours": int(policy.window_hours),
        "evaluation_delay_hours": int(getattr(policy, "evaluation_delay_hours", 0) or 0),
        "minimum_matched_samples": int(policy.minimum_matched_samples),
        "minimum_match_rate": (
            None
            if getattr(policy, "minimum_match_rate", None) is None
            else float(policy.minimum_match_rate)
        ),
        "rules": effective_quality_rules(policy),
        "rule_logic": str(getattr(policy, "rule_logic", "any") or "any").lower(),
        "consecutive_breaches": int(policy.consecutive_breaches),
        "cooldown_hours": int(policy.cooldown_hours),
        "auto_retrain": bool(policy.auto_retrain),
    }


def configs_semantically_equal(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return dumps({k: left.get(k) for k in SEMANTIC_FIELDS}) == dumps(
        {k: right.get(k) for k in SEMANTIC_FIELDS}
    )


def validate_match_rate(value: float | None) -> float | None:
    if value is None:
        return None
    number = _finite(value, "minimum_match_rate")
    if number < 0.0 or number > 1.0:
        raise ValueError("minimum_match_rate must be between 0.0 and 1.0.")
    return number


def validate_evaluation_delay(value: int) -> int:
    hours = int(value)
    if hours < 0 or hours > 24 * 30:
        raise ValueError("evaluation_delay_hours must be between 0 and 720.")
    return hours


def validate_rule_logic(value: str) -> str:
    logic = str(value or "any").strip().lower()
    if logic not in SUPPORTED_RULE_LOGIC:
        raise ValueError("rule_logic must be 'any' or 'all'.")
    return logic


def baseline_out(row: ModelQualityBaseline | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": row.id,
        "policy_id": row.policy_id,
        "quality_run_id": row.quality_run_id,
        "endpoint_id": row.endpoint_id,
        "model_version_id": row.model_version_id,
        "metrics": _loads(row.metrics_json, {}),
        "matched_ground_truth_count": row.matched_ground_truth_count,
        "match_rate": row.match_rate,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def get_baseline_for_policy(
    db: Session, policy_id: int
) -> ModelQualityBaseline | None:
    return db.scalar(
        select(ModelQualityBaseline).where(ModelQualityBaseline.policy_id == policy_id)
    )


def build_policy_snapshot(
    db: Session,
    policy: ModelQualityPolicy,
    *,
    baseline: ModelQualityBaseline | None = None,
) -> dict[str, Any]:
    baseline = baseline if baseline is not None else get_baseline_for_policy(db, policy.id)
    rules = effective_quality_rules(policy)
    mode = policy_mode(policy)
    snapshot = {
        "revision": int(getattr(policy, "revision", 1) or 1),
        "mode": mode,
        "window_hours": int(policy.window_hours),
        "evaluation_delay_hours": int(getattr(policy, "evaluation_delay_hours", 0) or 0),
        "minimum_matched_samples": int(policy.minimum_matched_samples),
        "minimum_match_rate": (
            None
            if getattr(policy, "minimum_match_rate", None) is None
            else float(policy.minimum_match_rate)
        ),
        "rule_logic": str(getattr(policy, "rule_logic", "any") or "any").lower(),
        "effective_rules": rules,
        "consecutive_breaches": int(policy.consecutive_breaches),
        "cooldown_hours": int(policy.cooldown_hours),
        "auto_retrain": bool(policy.auto_retrain),
        "primary_metric": policy.primary_metric,
        "warning_threshold": policy.warning_threshold,
        "critical_threshold": policy.critical_threshold,
        "baseline": None,
    }
    if baseline is not None:
        snapshot["baseline"] = {
            "id": baseline.id,
            "quality_run_id": baseline.quality_run_id,
            "model_version_id": baseline.model_version_id,
            "endpoint_id": baseline.endpoint_id,
            "metrics": _loads(baseline.metrics_json, {}),
            "matched_ground_truth_count": baseline.matched_ground_truth_count,
            "match_rate": baseline.match_rate,
        }
    return snapshot


def legacy_compatible_snapshot(policy: ModelQualityPolicy) -> dict[str, Any]:
    """Build a snapshot from live policy for legacy pending runs without one."""
    return {
        "revision": int(getattr(policy, "revision", 1) or 1),
        "mode": policy_mode(policy),
        "window_hours": int(policy.window_hours),
        "evaluation_delay_hours": int(getattr(policy, "evaluation_delay_hours", 0) or 0),
        "minimum_matched_samples": int(policy.minimum_matched_samples),
        "minimum_match_rate": (
            None
            if getattr(policy, "minimum_match_rate", None) is None
            else float(policy.minimum_match_rate)
        ),
        "rule_logic": str(getattr(policy, "rule_logic", "any") or "any").lower(),
        "effective_rules": effective_quality_rules(policy),
        "consecutive_breaches": int(policy.consecutive_breaches),
        "cooldown_hours": int(policy.cooldown_hours),
        "auto_retrain": bool(policy.auto_retrain),
        "primary_metric": policy.primary_metric,
        "warning_threshold": policy.warning_threshold,
        "critical_threshold": policy.critical_threshold,
        "baseline": None,
    }


def validate_baseline_run(
    db: Session,
    *,
    policy: ModelQualityPolicy,
    run: ModelQualityRun,
    endpoint: Endpoint,
) -> None:
    if run.project_id != policy.project_id:
        raise ValueError("Quality run belongs to another project.")
    if run.endpoint_id != policy.endpoint_id:
        raise ValueError("Quality run must belong to the same endpoint as the policy.")
    if run.status != JobStatus.succeeded:
        raise ValueError("Baseline quality run must have status=succeeded.")
    if run.quality_status != "ok":
        raise ValueError("Baseline quality run must have quality_status=ok.")
    if run.model_version_id is None:
        raise ValueError("Baseline quality run is missing model_version_id.")
    if endpoint.model_version_id != run.model_version_id:
        raise ValueError(
            "Baseline quality run model version must match the endpoint's current model."
        )
    if run.matched_ground_truth_count < policy.minimum_matched_samples:
        raise ValueError(
            "Baseline quality run does not satisfy minimum_matched_samples."
        )
    if policy.minimum_match_rate is not None:
        rate = float(run.match_rate or 0.0)
        if rate < float(policy.minimum_match_rate):
            raise ValueError("Baseline quality run does not satisfy minimum_match_rate.")

    model = db.get(ModelVersion, run.model_version_id)
    problem_type = quality_service.resolve_problem_type(db, model)
    target_columns = quality_service.resolve_target_columns(db, model)
    metrics = _loads(run.metrics_json, {})
    for rule in effective_quality_rules(policy):
        if rule["comparison"] != COMPARISON_BASELINE_DELTA:
            continue
        if rule["metric"] not in (
            quality_service.REGRESSION_METRICS
            if problem_type == "regression"
            else quality_service.CLASSIFICATION_METRICS
        ):
            raise ValueError(
                f"Baseline cannot resolve metric '{rule['metric']}' for this model."
            )
        if quality_service.extract_metric_value(
            metrics, rule["metric"], target=rule["target"]
        ) is None:
            raise ValueError(
                f"Baseline run is missing metric '{rule['metric']}'"
                + (f" for target '{rule['target']}'" if rule["target"] else "")
                + "."
            )
        if rule["target"] is not None and rule["target"] not in target_columns:
            raise ValueError(f"Baseline run does not include target '{rule['target']}'.")


def lock_policy_for_update(db: Session, policy_id: int) -> ModelQualityPolicy | None:
    """Lock a policy row and refresh any stale identity-map instance.

    Callers that already loaded the policy via ``get``/``get_owned`` must still
    use this helper before bumping ``revision`` so concurrent commits are visible
    after the row lock is acquired (``populate_existing``).
    """

    return db.get(
        ModelQualityPolicy,
        policy_id,
        with_for_update=True,
        populate_existing=True,
    )


def set_baseline(
    db: Session,
    *,
    policy: ModelQualityPolicy,
    quality_run_id: int,
    created_by: int | None,
) -> ModelQualityBaseline:
    # Prefer an already-locked policy from the route; still re-lock with
    # populate_existing so stale identity-map revisions cannot win.
    locked = lock_policy_for_update(db, policy.id)
    if locked is None:
        raise ValueError("Quality policy was not found.")
    policy = locked
    run = db.get(ModelQualityRun, quality_run_id)
    if run is None or run.project_id != policy.project_id:
        raise ValueError("Quality run was not found.")
    endpoint = db.get(Endpoint, policy.endpoint_id)
    if endpoint is None:
        raise ValueError("Endpoint was not found.")
    validate_baseline_run(db, policy=policy, run=run, endpoint=endpoint)

    existing = get_baseline_for_policy(db, policy.id)
    now = datetime.now(timezone.utc)
    if existing is None:
        existing = ModelQualityBaseline(
            project_id=policy.project_id,
            policy_id=policy.id,
            quality_run_id=run.id,
            endpoint_id=run.endpoint_id,
            model_version_id=int(run.model_version_id),
            metrics_json=run.metrics_json or "{}",
            matched_ground_truth_count=run.matched_ground_truth_count,
            match_rate=run.match_rate,
            created_by=created_by,
        )
        db.add(existing)
    else:
        existing.quality_run_id = run.id
        existing.endpoint_id = run.endpoint_id
        existing.model_version_id = int(run.model_version_id)
        existing.metrics_json = run.metrics_json or "{}"
        existing.matched_ground_truth_count = run.matched_ground_truth_count
        existing.match_rate = run.match_rate
        existing.updated_at = now
    policy.revision = int(getattr(policy, "revision", 1) or 1) + 1
    policy.updated_at = now
    db.flush()
    return existing


def clear_baseline(db: Session, *, policy: ModelQualityPolicy) -> bool:
    locked = lock_policy_for_update(db, policy.id)
    if locked is None:
        return False
    policy = locked
    existing = get_baseline_for_policy(db, policy.id)
    if existing is None:
        return False
    db.delete(existing)
    policy.revision = int(getattr(policy, "revision", 1) or 1) + 1
    policy.updated_at = datetime.now(timezone.utc)
    db.flush()
    return True
