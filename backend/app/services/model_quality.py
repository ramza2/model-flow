"""Production model quality evaluation: matching, metrics, and thresholds."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.db.models import (
    Endpoint,
    GroundTruthFeedback,
    JobStatus,
    ModelLifecycle,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
    PredictionObservation,
    TrainingJob,
)
from app.services.target_columns import (
    effective_target_columns_from_job,
    is_multi_output,
)

HIGHER_IS_BETTER = frozenset(
    {"accuracy", "precision_macro", "recall_macro", "f1_macro", "r2"}
)
LOWER_IS_BETTER = frozenset({"mae", "rmse"})
CLASSIFICATION_METRICS = ("accuracy", "precision_macro", "recall_macro", "f1_macro")
REGRESSION_METRICS = ("mae", "rmse", "r2")
SUPPORTED_PRIMARY_METRICS = frozenset(CLASSIFICATION_METRICS + REGRESSION_METRICS)


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


def default_primary_metric(problem_type: str) -> str:
    if str(problem_type).lower() == "regression":
        return "rmse"
    return "f1_macro"


def metric_is_higher_better(metric: str) -> bool:
    name = str(metric).lower()
    if name in LOWER_IS_BETTER:
        return False
    return True


def validate_policy_metric_thresholds(
    *,
    primary_metric: str,
    warning_threshold: float,
    critical_threshold: float,
) -> str:
    """Validate primary metric allowlist and direction-aware threshold ordering.

    Returns the canonical (lowercased) metric name.
    """

    metric = str(primary_metric or "").strip().lower()
    if metric not in SUPPORTED_PRIMARY_METRICS:
        raise ValueError(
            "Unsupported primary_metric. "
            f"Allowed: {', '.join(sorted(SUPPORTED_PRIMARY_METRICS))}."
        )
    for label, value in (
        ("warning_threshold", warning_threshold),
        ("critical_threshold", critical_threshold),
    ):
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{label} must be a finite number.") from exc
        if not math.isfinite(number):
            raise ValueError(f"{label} must be a finite number.")
    warning = float(warning_threshold)
    critical = float(critical_threshold)
    if metric_is_higher_better(metric):
        if critical > warning:
            raise ValueError(
                "For higher-is-better metrics, critical_threshold must be "
                "<= warning_threshold."
            )
    elif critical < warning:
        raise ValueError(
            "For lower-is-better metrics, critical_threshold must be "
            ">= warning_threshold."
        )
    return metric


def resolve_problem_type(db: Session, model: ModelVersion | None) -> str:
    if model is None:
        return "classification"
    metadata = _loads(model.metadata_json, {})
    if isinstance(metadata, dict) and metadata.get("problem_type"):
        return str(metadata["problem_type"]).lower()
    if model.training_job_id:
        job = db.get(TrainingJob, model.training_job_id)
        if job and job.problem_type and job.problem_type != "auto":
            return str(job.problem_type).lower()
    metrics = _loads(model.metrics_json, {})
    if isinstance(metrics, dict):
        if any(key in metrics for key in ("accuracy", "f1", "f1_macro")):
            return "classification"
        if any(key in metrics for key in ("mae", "rmse", "r2", "mse")):
            return "regression"
    return "classification"


def resolve_target_columns(db: Session, model: ModelVersion | None) -> list[str]:
    if model is None:
        return []
    metadata = _loads(model.metadata_json, {})
    if isinstance(metadata, dict):
        cols = metadata.get("target_columns") or metadata.get("targets")
        if isinstance(cols, list) and cols:
            return [str(c) for c in cols]
        if metadata.get("target_column"):
            return [str(metadata["target_column"])]
    if model.training_job_id:
        job = db.get(TrainingJob, model.training_job_id)
        if job is not None:
            return effective_target_columns_from_job(job)
    return []


def normalize_actual(actual: Any, *, target_columns: list[str], problem_type: str) -> Any:
    """Validate and normalize a ground-truth actual value for storage/comparison."""

    if is_multi_output(target_columns):
        if not isinstance(actual, dict):
            raise ValueError(
                "Multi-output models require an object actual with one value per target."
            )
        missing = [name for name in target_columns if name not in actual]
        if missing:
            raise ValueError(f"Missing target values: {', '.join(missing)}.")
        extra = [name for name in actual if name not in target_columns]
        if extra:
            raise ValueError(f"Unexpected target names: {', '.join(extra)}.")
        normalized: dict[str, Any] = {}
        for name in target_columns:
            value = actual[name]
            if problem_type == "regression":
                try:
                    normalized[name] = float(value)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"Target '{name}' must be numeric.") from exc
            else:
                normalized[name] = value
        return normalized

    if isinstance(actual, dict):
        if len(target_columns) == 1 and target_columns[0] in actual:
            actual = actual[target_columns[0]]
        else:
            raise ValueError("Single-output models require a scalar actual value.")
    if problem_type == "regression":
        try:
            return float(actual)
        except (TypeError, ValueError) as exc:
            raise ValueError("Regression actual values must be numeric.") from exc
    return actual


def actuals_equal(left: Any, right: Any) -> bool:
    return json.dumps(left, sort_keys=True, default=str) == json.dumps(
        right, sort_keys=True, default=str
    )


def _classification_metrics(y_true: list[Any], y_pred: list[Any]) -> dict[str, float]:
    from sklearn.metrics import (
        accuracy_score,
        f1_score,
        precision_score,
        recall_score,
    )

    labels = sorted({*y_true, *y_pred}, key=lambda value: str(value))
    return {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision_macro": float(
            precision_score(y_true, y_pred, average="macro", labels=labels, zero_division=0)
        ),
        "recall_macro": float(
            recall_score(y_true, y_pred, average="macro", labels=labels, zero_division=0)
        ),
        "f1_macro": float(
            f1_score(y_true, y_pred, average="macro", labels=labels, zero_division=0)
        ),
    }


def _regression_metrics(y_true: list[float], y_pred: list[float]) -> dict[str, float]:
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

    yt = np.asarray(y_true, dtype=float)
    yp = np.asarray(y_pred, dtype=float)
    mse = float(mean_squared_error(yt, yp))
    return {
        "mae": float(mean_absolute_error(yt, yp)),
        "rmse": float(math.sqrt(mse)),
        "r2": float(r2_score(yt, yp)) if len(yt) >= 2 else 0.0,
    }


def compute_quality_metrics(
    *,
    predictions: list[Any],
    actuals: list[Any],
    problem_type: str,
    target_columns: list[str],
) -> dict[str, Any]:
    if not predictions or len(predictions) != len(actuals):
        raise ValueError("Predictions and actuals must be non-empty and aligned.")

    if problem_type == "regression" and is_multi_output(target_columns):
        per_target: dict[str, dict[str, float]] = {}
        aggregate_true: list[float] = []
        aggregate_pred: list[float] = []
        for name in target_columns:
            y_true = [float(row[name]) for row in actuals]
            y_pred = [float(row[name]) for row in predictions]
            per_target[name] = _regression_metrics(y_true, y_pred)
            aggregate_true.extend(y_true)
            aggregate_pred.extend(y_pred)
        return {
            "aggregate": _regression_metrics(aggregate_true, aggregate_pred),
            "targets": per_target,
        }

    if problem_type == "regression":
        y_true = [float(value) for value in actuals]
        y_pred = [float(value) for value in predictions]
        return _regression_metrics(y_true, y_pred)

    # classification (single-label for Phase 5-A)
    return _classification_metrics(actuals, predictions)


def extract_metric_value(
    metrics: dict[str, Any],
    metric: str,
    target: str | None = None,
) -> float | None:
    """Resolve a metric value from flat, aggregate, or per-target metrics."""

    name = str(metric)
    if target is not None:
        targets = metrics.get("targets")
        if isinstance(targets, dict):
            bucket = targets.get(target)
            if isinstance(bucket, dict) and isinstance(bucket.get(name), (int, float)):
                return float(bucket[name])
        return None
    if name in metrics and isinstance(metrics[name], (int, float)):
        return float(metrics[name])
    aggregate = metrics.get("aggregate")
    if isinstance(aggregate, dict) and isinstance(aggregate.get(name), (int, float)):
        return float(aggregate[name])
    return None


def extract_primary_metric_value(metrics: dict[str, Any], primary_metric: str) -> float | None:
    return extract_metric_value(metrics, primary_metric, target=None)


def evaluate_thresholds(
    *,
    primary_value: float | None,
    primary_metric: str,
    warning_threshold: float,
    critical_threshold: float,
    matched_count: int,
    minimum_matched_samples: int,
) -> str:
    if matched_count < minimum_matched_samples or primary_value is None:
        return "insufficient_data"
    higher_better = metric_is_higher_better(primary_metric)
    if higher_better:
        if primary_value <= critical_threshold:
            return "critical"
        if primary_value <= warning_threshold:
            return "warning"
        return "ok"
    if primary_value >= critical_threshold:
        return "critical"
    if primary_value >= warning_threshold:
        return "warning"
    return "ok"


def evaluate_absolute_value(
    *,
    value: float,
    metric: str,
    warning_threshold: float,
    critical_threshold: float,
) -> str:
    if metric_is_higher_better(metric):
        if value <= critical_threshold:
            return "critical"
        if value <= warning_threshold:
            return "warning"
        return "ok"
    if value >= critical_threshold:
        return "critical"
    if value >= warning_threshold:
        return "warning"
    return "ok"


def evaluate_baseline_delta(
    *,
    degradation_delta: float,
    warning_threshold: float,
    critical_threshold: float,
) -> str:
    if degradation_delta >= critical_threshold:
        return "critical"
    if degradation_delta >= warning_threshold:
        return "warning"
    return "ok"


def combine_rule_statuses(statuses: list[str], rule_logic: str) -> str:
    logic = str(rule_logic or "any").lower()
    if not statuses:
        return "insufficient_data"
    if any(status == "insufficient_data" for status in statuses):
        return "insufficient_data"
    if logic == "all":
        if all(status == "critical" for status in statuses):
            return "critical"
        if all(status in {"warning", "critical"} for status in statuses):
            return "warning"
        return "ok"
    if any(status == "critical" for status in statuses):
        return "critical"
    if any(status == "warning" for status in statuses):
        return "warning"
    return "ok"


def policy_out(row: ModelQualityPolicy, db: Session | None = None) -> dict[str, Any]:
    from app.services import quality_policy as policy_service

    rules = policy_service.effective_quality_rules(row)
    baseline = None
    if db is not None:
        baseline = policy_service.baseline_out(
            policy_service.get_baseline_for_policy(db, row.id)
        )
    return {
        "id": row.id,
        "project_id": row.project_id,
        "endpoint_id": row.endpoint_id,
        "name": row.name,
        "is_active": row.is_active,
        "window_hours": row.window_hours,
        "evaluation_delay_hours": int(getattr(row, "evaluation_delay_hours", 0) or 0),
        "minimum_matched_samples": row.minimum_matched_samples,
        "minimum_match_rate": getattr(row, "minimum_match_rate", None),
        "primary_metric": row.primary_metric,
        "warning_threshold": row.warning_threshold,
        "critical_threshold": row.critical_threshold,
        "consecutive_breaches": row.consecutive_breaches,
        "cooldown_hours": row.cooldown_hours,
        "auto_retrain": row.auto_retrain,
        "revision": int(getattr(row, "revision", 1) or 1),
        "rule_logic": str(getattr(row, "rule_logic", "any") or "any"),
        "rules": rules if policy_service.policy_mode(row) == "advanced" else [],
        "mode": policy_service.policy_mode(row),
        "effective_rules": rules,
        "baseline": baseline,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def quality_run_out(row: ModelQualityRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "policy_id": row.policy_id,
        "endpoint_id": row.endpoint_id,
        "model_version_id": row.model_version_id,
        "status": row.status.value if hasattr(row.status, "value") else row.status,
        "window_start": row.window_start,
        "window_end": row.window_end,
        "prediction_count": row.prediction_count,
        "matched_ground_truth_count": row.matched_ground_truth_count,
        "match_rate": row.match_rate,
        "metrics": _loads(row.metrics_json, {}),
        "thresholds": _loads(row.thresholds_json, {}),
        "policy_revision": row.policy_revision,
        "policy_snapshot": _loads(row.policy_snapshot_json, {}),
        "evaluation": _loads(row.evaluation_json, {}),
        "quality_status": row.quality_status,
        "trigger_decision": _loads(row.trigger_decision_json, {}),
        "error_message": row.error_message,
        "created_at": row.created_at,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
        "created_by": row.created_by,
        "schedule_run_id": row.schedule_run_id,
    }


def enqueue_quality_run(
    db: Session,
    *,
    policy: ModelQualityPolicy,
    created_by: int | None = None,
    schedule_run_id: int | None = None,
) -> ModelQualityRun:
    from app.services import quality_policy as policy_service

    endpoint = db.get(Endpoint, policy.endpoint_id)
    snapshot = policy_service.build_policy_snapshot(db, policy)
    run = ModelQualityRun(
        project_id=policy.project_id,
        policy_id=policy.id,
        endpoint_id=policy.endpoint_id,
        model_version_id=endpoint.model_version_id if endpoint else None,
        status=JobStatus.pending,
        policy_revision=int(snapshot.get("revision") or getattr(policy, "revision", 1) or 1),
        policy_snapshot_json=dumps(snapshot),
        evaluation_json="{}",
        created_by=created_by,
        schedule_run_id=schedule_run_id,
    )
    db.add(run)
    db.flush()
    write_audit(
        db,
        action="model_quality_run.create",
        resource_type="model_quality_run",
        resource_id=run.id,
        user_id=created_by,
        after={
            "policy_id": policy.id,
            "endpoint_id": policy.endpoint_id,
            "policy_revision": run.policy_revision,
            "model_version_id": run.model_version_id,
        },
    )
    return run


def collect_matched_pairs(
    db: Session,
    *,
    project_id: int,
    endpoint_id: int,
    model_version_id: int | None,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[Any], list[Any], int, int]:
    observations = list(
        db.scalars(
            select(PredictionObservation)
            .where(
                PredictionObservation.project_id == project_id,
                PredictionObservation.endpoint_id == endpoint_id,
                PredictionObservation.predicted_at >= window_start,
                PredictionObservation.predicted_at <= window_end,
            )
            .order_by(PredictionObservation.predicted_at.asc(), PredictionObservation.id.asc())
        ).all()
    )
    if model_version_id is not None:
        observations = [
            row for row in observations if row.model_version_id == model_version_id
        ]
    obs_ids = [row.id for row in observations]
    truth_by_obs: dict[str, GroundTruthFeedback] = {}
    if obs_ids:
        for truth in db.scalars(
            select(GroundTruthFeedback).where(
                GroundTruthFeedback.prediction_observation_id.in_(obs_ids)
            )
        ).all():
            truth_by_obs[truth.prediction_observation_id] = truth

    predictions: list[Any] = []
    actuals: list[Any] = []
    for obs in observations:
        truth = truth_by_obs.get(obs.id)
        if truth is None:
            continue
        predictions.append(_loads(obs.prediction_json, None))
        actuals.append(_loads(truth.actual_json, None))
    return predictions, actuals, len(observations), len(predictions)


def _resolve_run_snapshot(
    db: Session, run: ModelQualityRun, policy: ModelQualityPolicy
) -> dict[str, Any]:
    from app.services import quality_policy as policy_service

    snapshot = _loads(run.policy_snapshot_json, {})
    if not isinstance(snapshot, dict) or not snapshot:
        snapshot = policy_service.legacy_compatible_snapshot(policy)
        run.policy_snapshot_json = dumps(snapshot)
        run.policy_revision = int(snapshot.get("revision") or 1)
    elif run.policy_revision is None:
        run.policy_revision = int(snapshot.get("revision") or getattr(policy, "revision", 1) or 1)
    return snapshot


def evaluate_rules(
    *,
    metrics: dict[str, Any],
    rules: list[dict[str, Any]],
    rule_logic: str,
    baseline_metrics: dict[str, Any] | None,
    problem_type: str,
    target_columns: list[str],
) -> tuple[str, list[dict[str, Any]], str | None]:
    """Evaluate configured rules. Returns (status, rule_evidence, fail_reason)."""

    from app.services.quality_policy import (
        COMPARISON_ABSOLUTE,
        COMPARISON_BASELINE_DELTA,
    )

    allowed = REGRESSION_METRICS if problem_type == "regression" else CLASSIFICATION_METRICS
    evidence: list[dict[str, Any]] = []
    statuses: list[str] = []

    for index, rule in enumerate(rules):
        metric = rule["metric"]
        target = rule.get("target")
        comparison = rule.get("comparison") or COMPARISON_ABSOLUTE
        entry: dict[str, Any] = {
            "index": index,
            "metric": metric,
            "target": target,
            "comparison": comparison,
            "warning_threshold": rule["warning_threshold"],
            "critical_threshold": rule["critical_threshold"],
        }
        if metric not in allowed:
            entry["status"] = "insufficient_data"
            entry["reason"] = "policy_metric_incompatible_with_model"
            evidence.append(entry)
            return "insufficient_data", evidence, "policy_metric_incompatible_with_model"
        if target is not None:
            if problem_type != "regression" or len(target_columns) <= 1:
                entry["status"] = "insufficient_data"
                entry["reason"] = "invalid_target_for_model"
                evidence.append(entry)
                return "insufficient_data", evidence, "invalid_target_for_model"
            if target not in target_columns:
                entry["status"] = "insufficient_data"
                entry["reason"] = "target_missing"
                evidence.append(entry)
                return "insufficient_data", evidence, "target_missing"

        current_value = extract_metric_value(metrics, metric, target=target)
        if current_value is None:
            entry["status"] = "insufficient_data"
            entry["reason"] = "metric_missing"
            evidence.append(entry)
            return "insufficient_data", evidence, "metric_missing"
        entry["current_value"] = current_value

        if comparison == COMPARISON_ABSOLUTE:
            status = evaluate_absolute_value(
                value=current_value,
                metric=metric,
                warning_threshold=float(rule["warning_threshold"]),
                critical_threshold=float(rule["critical_threshold"]),
            )
            entry["status"] = status
            evidence.append(entry)
            statuses.append(status)
            continue

        if comparison == COMPARISON_BASELINE_DELTA:
            if baseline_metrics is None:
                entry["status"] = "insufficient_data"
                entry["reason"] = "baseline_not_set"
                evidence.append(entry)
                return "insufficient_data", evidence, "baseline_not_set"
            baseline_value = extract_metric_value(baseline_metrics, metric, target=target)
            if baseline_value is None:
                entry["status"] = "insufficient_data"
                entry["reason"] = "baseline_metric_missing"
                evidence.append(entry)
                return "insufficient_data", evidence, "baseline_metric_missing"
            if metric_is_higher_better(metric):
                degradation = float(baseline_value) - float(current_value)
            else:
                degradation = float(current_value) - float(baseline_value)
            entry["baseline_value"] = baseline_value
            entry["degradation_delta"] = degradation
            status = evaluate_baseline_delta(
                degradation_delta=degradation,
                warning_threshold=float(rule["warning_threshold"]),
                critical_threshold=float(rule["critical_threshold"]),
            )
            entry["status"] = status
            evidence.append(entry)
            statuses.append(status)
            continue

        entry["status"] = "insufficient_data"
        entry["reason"] = "unsupported_comparison"
        evidence.append(entry)
        return "insufficient_data", evidence, "unsupported_comparison"

    return combine_rule_statuses(statuses, rule_logic), evidence, None


def evaluate_quality_run(db: Session, run: ModelQualityRun) -> ModelQualityRun:
    """Compute metrics and thresholds for a claimed ModelQualityRun."""

    from app.services import quality_policy as policy_service

    now = datetime.now(timezone.utc)
    run.started_at = run.started_at or now
    policy = db.get(ModelQualityPolicy, run.policy_id)
    if policy is None:
        run.status = JobStatus.failed
        run.error_message = "Quality policy was not found."
        run.finished_at = now
        return run

    endpoint = db.get(Endpoint, run.endpoint_id)
    if endpoint is None or endpoint.project_id != run.project_id:
        run.status = JobStatus.failed
        run.error_message = "Endpoint was not found for this quality policy."
        run.finished_at = now
        return run

    # Legacy pending runs may lack enqueue-time model pin; resolve at start.
    if run.model_version_id is None:
        run.model_version_id = endpoint.model_version_id

    snapshot = _resolve_run_snapshot(db, run, policy)
    rules = policy_service.effective_quality_rules(snapshot)
    rule_logic = str(snapshot.get("rule_logic") or "any").lower()
    window_hours = max(1, int(snapshot.get("window_hours") or policy.window_hours or 1))
    delay_hours = max(0, int(snapshot.get("evaluation_delay_hours") or 0))
    minimum_matched = int(
        snapshot.get("minimum_matched_samples") or policy.minimum_matched_samples or 1
    )
    minimum_match_rate = snapshot.get("minimum_match_rate")
    if minimum_match_rate is not None:
        minimum_match_rate = float(minimum_match_rate)

    model = db.get(ModelVersion, run.model_version_id) if run.model_version_id else None
    problem_type = resolve_problem_type(db, model)
    target_columns = resolve_target_columns(db, model)

    window_end = now - timedelta(hours=delay_hours)
    window_start = window_end - timedelta(hours=window_hours)
    run.window_start = window_start
    run.window_end = window_end

    predictions, actuals, prediction_count, matched_count = collect_matched_pairs(
        db,
        project_id=run.project_id,
        endpoint_id=run.endpoint_id,
        model_version_id=run.model_version_id,
        window_start=window_start,
        window_end=window_end,
    )
    run.prediction_count = prediction_count
    run.matched_ground_truth_count = matched_count
    match_rate = (
        float(matched_count) / float(prediction_count) if prediction_count else 0.0
    )
    run.match_rate = match_rate

    run.thresholds_json = dumps(
        {
            "mode": policy_service.snapshot_mode(snapshot),
            "rule_logic": rule_logic,
            "rules": rules,
            "primary_metric": snapshot.get("primary_metric", policy.primary_metric),
            "warning_threshold": snapshot.get(
                "warning_threshold", policy.warning_threshold
            ),
            "critical_threshold": snapshot.get(
                "critical_threshold", policy.critical_threshold
            ),
            "minimum_matched_samples": minimum_matched,
            "minimum_match_rate": minimum_match_rate,
            "evaluation_delay_hours": delay_hours,
            "consecutive_breaches": snapshot.get(
                "consecutive_breaches", policy.consecutive_breaches
            ),
            "cooldown_hours": snapshot.get("cooldown_hours", policy.cooldown_hours),
            "policy_revision": run.policy_revision,
        }
    )

    sufficiency = {
        "status": "sufficient",
        "prediction_count": prediction_count,
        "matched_count": matched_count,
        "match_rate": match_rate,
        "minimum_matched_samples": minimum_matched,
        "minimum_match_rate": minimum_match_rate,
    }
    baseline_snap = snapshot.get("baseline") if isinstance(snapshot.get("baseline"), dict) else None
    evaluation: dict[str, Any] = {
        "sufficiency": sufficiency,
        "baseline": (
            {
                "quality_run_id": baseline_snap.get("quality_run_id"),
                "model_version_id": baseline_snap.get("model_version_id"),
            }
            if baseline_snap
            else None
        ),
        "rules": [],
        "rule_logic": rule_logic,
        "quality_status": "insufficient_data",
        "reason": None,
    }

    metrics: dict[str, Any] = {}
    if matched_count < minimum_matched:
        sufficiency["status"] = "insufficient"
        evaluation["reason"] = "minimum_matched_samples"
        run.metrics_json = dumps(metrics)
        run.evaluation_json = dumps(evaluation)
        run.quality_status = "insufficient_data"
        run.status = JobStatus.succeeded
        run.error_message = None
        run.finished_at = now
        _audit_quality_complete(db, run, evaluation)
        return run

    if minimum_match_rate is not None and match_rate < minimum_match_rate:
        sufficiency["status"] = "insufficient"
        evaluation["reason"] = "minimum_match_rate"
        run.metrics_json = dumps(metrics)
        run.evaluation_json = dumps(evaluation)
        run.quality_status = "insufficient_data"
        run.status = JobStatus.succeeded
        run.error_message = None
        run.finished_at = now
        _audit_quality_complete(db, run, evaluation)
        return run

    if matched_count > 0:
        try:
            metrics = compute_quality_metrics(
                predictions=predictions,
                actuals=actuals,
                problem_type=problem_type,
                target_columns=target_columns or ["target"],
            )
        except Exception as exc:
            run.status = JobStatus.failed
            run.error_message = f"Metric calculation failed: {exc}"
            run.finished_at = now
            return run

    run.metrics_json = dumps(metrics)

    needs_baseline = any(
        rule.get("comparison") == "baseline_delta" for rule in rules
    )
    baseline_metrics: dict[str, Any] | None = None
    if needs_baseline:
        if not baseline_snap:
            evaluation["reason"] = "baseline_not_set"
            evaluation["rules"] = [
                {
                    "index": i,
                    "metric": r["metric"],
                    "target": r.get("target"),
                    "comparison": r.get("comparison"),
                    "status": "insufficient_data",
                    "reason": "baseline_not_set",
                }
                for i, r in enumerate(rules)
            ]
            run.evaluation_json = dumps(evaluation)
            run.quality_status = "insufficient_data"
            run.status = JobStatus.succeeded
            run.error_message = None
            run.finished_at = now
            _audit_quality_complete(db, run, evaluation)
            return run
        if baseline_snap.get("model_version_id") != run.model_version_id:
            evaluation["reason"] = "baseline_model_mismatch"
            evaluation["rules"] = [
                {
                    "index": i,
                    "metric": r["metric"],
                    "target": r.get("target"),
                    "comparison": r.get("comparison"),
                    "status": "insufficient_data",
                    "reason": "baseline_model_mismatch",
                }
                for i, r in enumerate(rules)
            ]
            run.evaluation_json = dumps(evaluation)
            run.quality_status = "insufficient_data"
            run.status = JobStatus.succeeded
            run.error_message = None
            run.finished_at = now
            _audit_quality_complete(db, run, evaluation)
            return run
        baseline_metrics = baseline_snap.get("metrics") or {}
        if not isinstance(baseline_metrics, dict):
            baseline_metrics = {}

    # Fail-safe when any configured metric is incompatible with the model.
    for rule in rules:
        allowed = REGRESSION_METRICS if problem_type == "regression" else CLASSIFICATION_METRICS
        if rule["metric"] not in allowed:
            evaluation["reason"] = "policy_metric_incompatible_with_model"
            run.evaluation_json = dumps(evaluation)
            run.quality_status = "insufficient_data"
            run.status = JobStatus.succeeded
            run.error_message = None
            run.finished_at = now
            _audit_quality_complete(db, run, evaluation)
            return run

    quality_status, rule_evidence, fail_reason = evaluate_rules(
        metrics=metrics,
        rules=rules,
        rule_logic=rule_logic,
        baseline_metrics=baseline_metrics,
        problem_type=problem_type,
        target_columns=target_columns or ["target"],
    )
    evaluation["rules"] = rule_evidence
    evaluation["quality_status"] = quality_status
    evaluation["reason"] = fail_reason
    run.evaluation_json = dumps(evaluation)
    run.quality_status = quality_status
    run.status = JobStatus.succeeded
    run.error_message = None
    run.finished_at = now
    _audit_quality_complete(db, run, evaluation)
    return run


def _audit_quality_complete(
    db: Session, run: ModelQualityRun, evaluation: dict[str, Any]
) -> None:
    rules = evaluation.get("rules") or []
    write_audit(
        db,
        action="model_quality_run.complete",
        resource_type="model_quality_run",
        resource_id=run.id,
        user_id=run.created_by,
        after={
            "quality_status": run.quality_status,
            "matched_ground_truth_count": run.matched_ground_truth_count,
            "policy_revision": run.policy_revision,
            "rule_logic": evaluation.get("rule_logic"),
            "critical_rule_count": sum(
                1 for row in rules if row.get("status") == "critical"
            ),
            "warning_rule_count": sum(
                1 for row in rules if row.get("status") == "warning"
            ),
            "reason": evaluation.get("reason"),
        },
    )


def count_consecutive_breaches(
    db: Session,
    *,
    policy_id: int,
    model_version_id: int | None,
    policy_revision: int | None = None,
    required_status: str = "critical",
) -> int:
    rows = list(
        db.scalars(
            select(ModelQualityRun)
            .where(
                ModelQualityRun.policy_id == policy_id,
                ModelQualityRun.status == JobStatus.succeeded,
            )
            .order_by(ModelQualityRun.id.desc())
            .limit(50)
        ).all()
    )
    count = 0
    for row in rows:
        if model_version_id is not None and row.model_version_id != model_version_id:
            break
        if policy_revision is not None:
            row_revision = row.policy_revision
            if row_revision is None:
                snap = _loads(row.policy_snapshot_json, {})
                if isinstance(snap, dict) and snap.get("revision") is not None:
                    row_revision = int(snap["revision"])
            if row_revision != policy_revision:
                break
        if row.quality_status == required_status:
            count += 1
            continue
        if row.quality_status == "insufficient_data":
            continue
        break
    return count


def production_model_ready_for_retrain(
    db: Session, model: ModelVersion | None
) -> tuple[bool, str | None, TrainingJob | None]:
    if model is None:
        return False, "endpoint_model_missing", None
    if model.lifecycle != ModelLifecycle.PRODUCTION:
        return False, "endpoint_model_not_production", None
    if not model.training_job_id:
        return False, "source_training_job_missing", None
    job = db.get(TrainingJob, model.training_job_id)
    if job is None:
        return False, "source_training_job_missing", None
    if job.status != JobStatus.succeeded:
        return False, "source_training_job_not_succeeded", None
    if job.dataset_version_id is None:
        return False, "source_dataset_version_missing", None
    return True, None, job
