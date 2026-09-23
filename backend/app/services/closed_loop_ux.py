"""Phase 5-D closed-loop presentation helpers: structured state and reason copy."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Endpoint,
    JobStatus,
    ModelLifecycle,
    ModelQualityBaseline,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
    RetrainTrigger,
    TrainingJob,
)

REASON_LABELS: dict[str, str] = {
    "baseline_not_set": "Baseline required",
    "baseline_model_mismatch": "Baseline belongs to a different model version",
    "baseline_metric_missing": "Baseline is missing a required metric",
    "minimum_matched_samples": "Not enough matched ground truth",
    "minimum_match_rate": "Ground-truth coverage is below policy minimum",
    "policy_metric_incompatible_with_model": "Policy metric is incompatible with the current model",
    "metric_missing": "A configured metric could not be resolved",
    "target_missing": "A configured target could not be resolved",
    "invalid_target_for_model": "A configured target is not valid for this model",
    "consecutive_breaches_not_met": "Waiting for more consecutive critical evaluations",
    "cooldown_active": "Retraining is in cooldown",
    "no_new_dataset_version": "No newer compatible DatasetVersion exists",
    "retrain_validation_failed": "New DatasetVersion is not compatible with the training configuration",
    "auto_retrain_disabled": "Automatic retraining is disabled",
    "insufficient_data": "Insufficient evaluation data",
    "quality_status_ok": "Quality is within policy thresholds",
    "quality_status_warning": "Quality warning threshold breached",
    "quality_status_critical": "Quality critical threshold breached",
    "endpoint_model_not_production": "Endpoint model is not in PRODUCTION",
    "endpoint_model_missing": "Endpoint has no current model",
    "source_training_job_missing": "Source training job is missing",
    "source_training_job_not_succeeded": "Source training job has not succeeded",
    "source_dataset_version_missing": "Source DatasetVersion is missing",
    "retrain_already_triggered": "Retraining was already triggered for this quality run",
    "retrain_triggered": "Full retraining was triggered",
    "critical_degradation": "Critical quality degradation triggered retraining",
}


def reason_label(code: str | None) -> str:
    if not code:
        return "No additional detail"
    key = str(code)
    if key in REASON_LABELS:
        return REASON_LABELS[key]
    if key.startswith("retrain_validation_failed:"):
        return REASON_LABELS["retrain_validation_failed"]
    if key.startswith("incompatible_dataset_version:"):
        return REASON_LABELS["retrain_validation_failed"]
    if key.startswith("quality_status_"):
        return REASON_LABELS.get(key, f"Quality status is {key.replace('quality_status_', '')}")
    return key.replace("_", " ")


def _loads(value: str | None, default: Any = None) -> Any:
    if default is None:
        default = {}
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _label_for_code(code: str) -> str:
    return {
        "healthy": "Healthy",
        "needs_baseline": "Needs baseline",
        "insufficient_data": "Insufficient data",
        "degraded_warning": "Degraded",
        "degraded_critical": "Degraded",
        "waiting_consecutive_breach": "Waiting for consecutive breaches",
        "cooldown": "Cooldown",
        "retrain_blocked_no_new_data": "Retrain blocked: no new data",
        "retrain_validation_failed": "Retrain validation failed",
        "retraining_queued": "Retraining queued",
        "retraining_running": "Retraining running",
        "retraining_failed": "Retraining failed",
        "candidate_registration_failed": "Candidate registration failed",
        "candidate_ready": "Candidate ready",
        "awaiting_human_review": "Awaiting human review",
    }.get(code, code.replace("_", " ").title())


def compute_closed_loop_detail(
    db: Session,
    *,
    project_id: int,
    endpoint_id: int,
    policy: ModelQualityPolicy | None = None,
) -> dict[str, Any]:
    """Derive structured closed-loop state from persisted entities only."""

    latest_run = db.scalar(
        select(ModelQualityRun)
        .where(
            ModelQualityRun.project_id == project_id,
            ModelQualityRun.endpoint_id == endpoint_id,
            ModelQualityRun.status == JobStatus.succeeded,
        )
        .order_by(ModelQualityRun.id.desc())
    )
    if policy is not None:
        policy_run = db.scalar(
            select(ModelQualityRun)
            .where(
                ModelQualityRun.policy_id == policy.id,
                ModelQualityRun.status == JobStatus.succeeded,
            )
            .order_by(ModelQualityRun.id.desc())
        )
        if policy_run is not None:
            latest_run = policy_run

    latest_trigger = db.scalar(
        select(RetrainTrigger)
        .join(ModelQualityRun, ModelQualityRun.id == RetrainTrigger.quality_run_id)
        .where(
            RetrainTrigger.project_id == project_id,
            RetrainTrigger.trigger_type == "quality_degradation",
            ModelQualityRun.endpoint_id == endpoint_id,
        )
        .order_by(RetrainTrigger.id.desc())
    )

    detail: dict[str, Any] = {
        "code": "healthy",
        "label": "Healthy",
        "reason": None,
        "reason_label": None,
        "next_action": None,
        "quality_run_id": latest_run.id if latest_run else None,
        "retrain_trigger_id": latest_trigger.id if latest_trigger else None,
        "training_job_id": (
            latest_trigger.created_training_job_id if latest_trigger else None
        ),
        "candidate_model_version_id": (
            latest_trigger.candidate_model_version_id if latest_trigger else None
        ),
        "target_dataset_version_id": (
            latest_trigger.target_dataset_version_id if latest_trigger else None
        ),
        "policy_id": policy.id if policy else None,
    }

    def _set(code: str, reason: str | None = None, next_action: str | None = None) -> dict[str, Any]:
        detail["code"] = code
        detail["label"] = _label_for_code(code)
        detail["reason"] = reason
        detail["reason_label"] = reason_label(reason) if reason else None
        detail["next_action"] = next_action
        return detail

    if latest_trigger is not None:
        if latest_trigger.candidate_model_version_id:
            candidate = db.get(ModelVersion, latest_trigger.candidate_model_version_id)
            if candidate and candidate.lifecycle == ModelLifecycle.CANDIDATE:
                return _set(
                    "candidate_ready",
                    "critical_degradation",
                    "Review the candidate ModelVersion before requesting approval.",
                )
            if candidate and candidate.lifecycle == ModelLifecycle.PENDING_APPROVAL:
                return _set(
                    "awaiting_human_review",
                    None,
                    "Complete human approval for PRODUCTION promotion.",
                )
        if latest_trigger.created_training_job_id:
            job = db.get(TrainingJob, latest_trigger.created_training_job_id)
            if job is not None:
                if job.status in {JobStatus.pending, JobStatus.queued}:
                    return _set(
                        "retraining_queued",
                        "retrain_triggered",
                        "Wait for the closed-loop TrainingJob to start.",
                    )
                if job.status == JobStatus.running:
                    return _set(
                        "retraining_running",
                        "retrain_triggered",
                        "Wait for the closed-loop TrainingJob to finish.",
                    )
                if job.status == JobStatus.failed:
                    return _set(
                        "retraining_failed",
                        job.error_message or "retrain_validation_failed",
                        "Inspect the failed TrainingJob logs, then resolve data/config issues.",
                    )
                if (
                    job.status == JobStatus.succeeded
                    and not latest_trigger.candidate_model_version_id
                ):
                    return _set(
                        "candidate_registration_failed",
                        "candidate_registration_failed",
                        "Inspect alerts for candidate registration failure, then retry registration if needed.",
                    )

    # Policy-scoped baseline / sufficiency signals (when a policy context exists).
    if policy is not None:
        rules = []
        try:
            from app.services import quality_policy as policy_service

            rules = policy_service.effective_quality_rules(policy)
        except Exception:
            rules = []
        needs_baseline = any(
            str(rule.get("comparison") or "") == "baseline_delta" for rule in rules
        )
        baseline = db.scalar(
            select(ModelQualityBaseline).where(
                ModelQualityBaseline.policy_id == policy.id
            )
        )
        if needs_baseline and baseline is None:
            return _set(
                "needs_baseline",
                "baseline_not_set",
                "Set a baseline in Quality Policies using an eligible OK quality run.",
            )
        endpoint = db.get(Endpoint, policy.endpoint_id)
        if (
            needs_baseline
            and baseline is not None
            and endpoint is not None
            and endpoint.model_version_id is not None
            and baseline.model_version_id != endpoint.model_version_id
        ):
            return _set(
                "insufficient_data",
                "baseline_model_mismatch",
                "Pin a new baseline for the current Production model.",
            )

    if latest_run is not None:
        decision = _loads(latest_run.trigger_decision_json, {})
        decision_reason = (
            str(decision.get("reason"))
            if isinstance(decision, dict) and decision.get("reason")
            else None
        )
        evaluation = _loads(latest_run.evaluation_json, {})
        eval_reason = (
            str(evaluation.get("reason"))
            if isinstance(evaluation, dict) and evaluation.get("reason")
            else None
        )

        if latest_run.quality_status == "insufficient_data":
            reason = eval_reason or decision_reason or "insufficient_data"
            return _set(
                "insufficient_data",
                reason,
                "Collect more matched ground truth or fix baseline/policy configuration.",
            )

        if decision_reason == "cooldown_active":
            return _set(
                "cooldown",
                "cooldown_active",
                "Wait for cooldown to expire, or review recent closed-loop retrains.",
            )
        if decision_reason == "consecutive_breaches_not_met":
            return _set(
                "waiting_consecutive_breach",
                "consecutive_breaches_not_met",
                "Wait for additional consecutive critical evaluations.",
            )
        if decision_reason == "no_new_dataset_version":
            return _set(
                "retrain_blocked_no_new_data",
                "no_new_dataset_version",
                "Review feedback and materialize a newer DatasetVersion.",
            )
        if decision_reason and str(decision_reason).startswith("retrain_validation_failed"):
            return _set(
                "retrain_validation_failed",
                decision_reason,
                "Choose a compatible DatasetVersion or adjust the training configuration.",
            )
        if decision_reason == "auto_retrain_disabled" and latest_run.quality_status == "critical":
            return _set(
                "degraded_critical",
                "auto_retrain_disabled",
                "Enable auto-retrain or trigger a manual retrain after reviewing quality evidence.",
            )

        if latest_run.quality_status == "critical":
            return _set(
                "degraded_critical",
                decision_reason or "quality_status_critical",
                "Review quality evidence and ensure newer training data is available.",
            )
        if latest_run.quality_status == "warning":
            return _set(
                "degraded_warning",
                decision_reason or "quality_status_warning",
                "Monitor the next evaluations and review recent predictions/feedback.",
            )

    return _set("healthy", None, "No closed-loop action required.")


def compute_closed_loop_state_label(detail: dict[str, Any]) -> str:
    """Map structured detail to the legacy presentation string."""

    code = str(detail.get("code") or "healthy")
    legacy = {
        "healthy": "Healthy",
        "needs_baseline": "Needs baseline",
        "insufficient_data": "Insufficient data",
        "degraded_warning": "Degraded",
        "degraded_critical": "Degraded",
        "waiting_consecutive_breach": "Degraded",
        "cooldown": "Degraded",
        "retrain_blocked_no_new_data": "Degraded",
        "retrain_validation_failed": "Degraded",
        "retraining_queued": "Retraining queued",
        "retraining_running": "Retraining running",
        "retraining_failed": "Retraining failed",
        "candidate_registration_failed": "Candidate registration failed",
        "candidate_ready": "Candidate ready",
        "awaiting_human_review": "Awaiting human review",
    }
    return legacy.get(code, str(detail.get("label") or "Healthy"))
