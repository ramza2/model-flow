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


def extract_primary_metric_value(metrics: dict[str, Any], primary_metric: str) -> float | None:
    name = str(primary_metric)
    if name in metrics and isinstance(metrics[name], (int, float)):
        return float(metrics[name])
    aggregate = metrics.get("aggregate")
    if isinstance(aggregate, dict) and isinstance(aggregate.get(name), (int, float)):
        return float(aggregate[name])
    return None


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


def policy_out(row: ModelQualityPolicy) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "endpoint_id": row.endpoint_id,
        "name": row.name,
        "is_active": row.is_active,
        "window_hours": row.window_hours,
        "minimum_matched_samples": row.minimum_matched_samples,
        "primary_metric": row.primary_metric,
        "warning_threshold": row.warning_threshold,
        "critical_threshold": row.critical_threshold,
        "consecutive_breaches": row.consecutive_breaches,
        "cooldown_hours": row.cooldown_hours,
        "auto_retrain": row.auto_retrain,
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
    run = ModelQualityRun(
        project_id=policy.project_id,
        policy_id=policy.id,
        endpoint_id=policy.endpoint_id,
        status=JobStatus.pending,
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
        after={"policy_id": policy.id, "endpoint_id": policy.endpoint_id},
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


def evaluate_quality_run(db: Session, run: ModelQualityRun) -> ModelQualityRun:
    """Compute metrics and thresholds for a claimed ModelQualityRun."""

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

    # Snapshot the model version at evaluation start for immutable lineage.
    if run.model_version_id is None:
        run.model_version_id = endpoint.model_version_id

    model = db.get(ModelVersion, run.model_version_id) if run.model_version_id else None
    problem_type = resolve_problem_type(db, model)
    target_columns = resolve_target_columns(db, model)

    window_end = now
    window_start = window_end - timedelta(hours=max(1, int(policy.window_hours)))
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
    run.match_rate = (
        float(matched_count) / float(prediction_count) if prediction_count else 0.0
    )
    run.thresholds_json = dumps(
        {
            "primary_metric": policy.primary_metric,
            "warning_threshold": policy.warning_threshold,
            "critical_threshold": policy.critical_threshold,
            "minimum_matched_samples": policy.minimum_matched_samples,
            "consecutive_breaches": policy.consecutive_breaches,
            "cooldown_hours": policy.cooldown_hours,
        }
    )

    metrics: dict[str, Any] = {}
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
    primary_value = extract_primary_metric_value(metrics, policy.primary_metric)
    run.quality_status = evaluate_thresholds(
        primary_value=primary_value,
        primary_metric=policy.primary_metric,
        warning_threshold=policy.warning_threshold,
        critical_threshold=policy.critical_threshold,
        matched_count=matched_count,
        minimum_matched_samples=policy.minimum_matched_samples,
    )
    run.status = JobStatus.succeeded
    run.error_message = None
    run.finished_at = now
    write_audit(
        db,
        action="model_quality_run.complete",
        resource_type="model_quality_run",
        resource_id=run.id,
        user_id=run.created_by,
        after={
            "quality_status": run.quality_status,
            "matched_ground_truth_count": matched_count,
            "primary_metric": policy.primary_metric,
            "primary_value": primary_value,
        },
    )
    return run


def count_consecutive_breaches(
    db: Session,
    *,
    policy_id: int,
    model_version_id: int | None,
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
