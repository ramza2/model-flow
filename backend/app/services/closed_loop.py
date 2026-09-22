"""Closed-loop MLOps orchestration: alerts, retrain decisions, candidate registration."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.db.models import (
    Alert,
    AlertSeverity,
    DatasetVersion,
    Endpoint,
    JobStatus,
    ModelLifecycle,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
    RetrainTrigger,
    TrainingJob,
)
from app.schemas.v1 import JobRetrainRequest
from app.services.alerts import create_alert
from app.services import model_quality as quality_service
from app.services.retrain_service import RetrainConfigError, prepare_retrain_job
from app.services.training_validation import TrainingConfigError
from app.services.target_columns import dumps_target_columns
from app.services import registry_service


def _loads(value: str | None, default: Any = None) -> Any:
    if default is None:
        default = {}
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _dumps(value: Any) -> str:
    return json.dumps(value, default=str)


def _existing_alert(
    db: Session,
    *,
    project_id: int,
    alert_type: str,
    resource_type: str,
    resource_id: str,
) -> Alert | None:
    return db.scalar(
        select(Alert)
        .where(
            Alert.project_id == project_id,
            Alert.alert_type == alert_type,
            Alert.resource_type == resource_type,
            Alert.resource_id == resource_id,
        )
        .order_by(Alert.id.desc())
    )


def _snapshot_decision_config(run: ModelQualityRun, policy: ModelQualityPolicy) -> dict[str, Any]:
    snapshot = _loads(run.policy_snapshot_json, {})
    if not isinstance(snapshot, dict) or not snapshot:
        return {
            "auto_retrain": bool(policy.auto_retrain),
            "consecutive_breaches": int(policy.consecutive_breaches),
            "cooldown_hours": int(policy.cooldown_hours),
            "policy_revision": int(getattr(policy, "revision", 1) or 1),
            "rule_logic": str(getattr(policy, "rule_logic", "any") or "any"),
        }
    return {
        "auto_retrain": bool(snapshot.get("auto_retrain", policy.auto_retrain)),
        "consecutive_breaches": int(
            snapshot.get("consecutive_breaches", policy.consecutive_breaches)
        ),
        "cooldown_hours": int(snapshot.get("cooldown_hours", policy.cooldown_hours)),
        "policy_revision": int(
            snapshot.get("revision")
            or run.policy_revision
            or getattr(policy, "revision", 1)
            or 1
        ),
        "rule_logic": str(snapshot.get("rule_logic") or "any"),
        "baseline": snapshot.get("baseline"),
    }


def _format_degradation_alert_message(
    *,
    run: ModelQualityRun,
    endpoint: Endpoint,
) -> str:
    evaluation = _loads(run.evaluation_json, {})
    rules = evaluation.get("rules") if isinstance(evaluation, dict) else None
    if not isinstance(rules, list):
        rules = []
    breached = [
        row
        for row in rules
        if isinstance(row, dict) and row.get("status") in {"warning", "critical"}
    ]
    total = len(rules)
    lines = [
        f"Endpoint '{endpoint.name}' quality {str(run.quality_status or '').upper()}.",
        f"{len(breached)} of {total} rules breached." if total else "Quality degraded.",
        "",
    ]
    for row in breached[:3]:
        metric = row.get("metric")
        comparison = row.get("comparison")
        status = str(row.get("status") or "").upper()
        if comparison == "baseline_delta":
            delta = row.get("degradation_delta")
            critical = row.get("critical_threshold")
            warning = row.get("warning_threshold")
            threshold = critical if row.get("status") == "critical" else warning
            target = row.get("target")
            label = f"{metric}" + (f"[{target}]" if target else "")
            lines.append(
                f"- {label} baseline delta: {delta} >= {row.get('status')} {threshold}"
            )
        else:
            value = row.get("current_value")
            critical = row.get("critical_threshold")
            warning = row.get("warning_threshold")
            threshold = critical if row.get("status") == "critical" else warning
            target = row.get("target")
            label = f"{metric}" + (f"[{target}]" if target else "")
            higher = quality_service.metric_is_higher_better(str(metric))
            op = "<=" if higher else ">="
            lines.append(f"- {label}: {value} {op} {status.lower()} {threshold}")
    matched = run.matched_ground_truth_count
    predictions = run.prediction_count
    lines.extend(
        [
            "",
            f"Matched ground truth: {matched} / {predictions}",
            f"Quality Run #{run.id}",
            f"Policy revision: {run.policy_revision}",
        ]
    )
    return "\n".join(lines)


def maybe_create_degradation_alert(
    db: Session,
    *,
    run: ModelQualityRun,
    policy: ModelQualityPolicy,
    endpoint: Endpoint,
) -> Alert | None:
    if run.quality_status not in {"warning", "critical"}:
        return None
    resource_id = str(run.id)
    existing = _existing_alert(
        db,
        project_id=run.project_id,
        alert_type="model_quality_degradation",
        resource_type="model_quality_run",
        resource_id=resource_id,
    )
    if existing is not None:
        return existing

    evaluation = _loads(run.evaluation_json, {})
    has_rule_evidence = isinstance(evaluation, dict) and isinstance(
        evaluation.get("rules"), list
    ) and evaluation.get("rules")
    if has_rule_evidence:
        message = _format_degradation_alert_message(run=run, endpoint=endpoint)
    else:
        # Legacy fallback for historical runs without evaluation_json.
        metrics = _loads(run.metrics_json, {})
        primary_value = quality_service.extract_primary_metric_value(
            metrics, policy.primary_metric
        )
        threshold = (
            policy.critical_threshold
            if run.quality_status == "critical"
            else policy.warning_threshold
        )
        message = (
            f"Endpoint '{endpoint.name}' model version #{run.model_version_id}: "
            f"{policy.primary_metric}={primary_value} crossed {run.quality_status} "
            f"threshold {threshold} with {run.matched_ground_truth_count} matched samples "
            f"(quality run #{run.id})."
        )

    severity = (
        AlertSeverity.critical
        if run.quality_status == "critical"
        else AlertSeverity.warning
    )
    return create_alert(
        db,
        alert_type="model_quality_degradation",
        title=f"Model quality {run.quality_status} on {endpoint.name}",
        project_id=run.project_id,
        severity=severity,
        message=message,
        resource_type="model_quality_run",
        resource_id=resource_id,
        link_path=f"/projects/{run.project_id}/monitoring",
    )


def find_newer_compatible_dataset_version(
    db: Session,
    *,
    project_id: int,
    source_job: TrainingJob,
) -> tuple[DatasetVersion | None, str | None]:
    if source_job.dataset_version_id is None:
        return None, "source_dataset_version_missing"
    candidates = list(
        db.scalars(
            select(DatasetVersion)
            .where(
                DatasetVersion.dataset_id == source_job.dataset_id,
                DatasetVersion.id > source_job.dataset_version_id,
            )
            .order_by(DatasetVersion.id.desc())
        ).all()
    )
    if not candidates:
        return None, "no_new_dataset_version"

    last_error: str | None = None
    for version in candidates:
        try:
            prepare_retrain_job(
                db,
                project_id,
                source_job,
                JobRetrainRequest(
                    dataset_version_id=version.id,
                    name=f"{source_job.name} (closed-loop retrain)",
                ),
            )
            return version, None
        except (RetrainConfigError, TrainingConfigError) as exc:
            detail = getattr(exc, "detail", str(exc))
            last_error = f"incompatible_dataset_version:{detail}"
            continue
    return None, last_error or "incompatible_dataset_version"


def _cooldown_active(
    db: Session,
    *,
    project_id: int,
    endpoint_id: int,
    cooldown_hours: int,
    now: datetime,
) -> bool:
    since = now - timedelta(hours=max(0, int(cooldown_hours)))
    recent_id = db.scalar(
        select(RetrainTrigger.id)
        .join(ModelQualityRun, ModelQualityRun.id == RetrainTrigger.quality_run_id)
        .where(
            RetrainTrigger.project_id == project_id,
            RetrainTrigger.trigger_type == "quality_degradation",
            ModelQualityRun.endpoint_id == endpoint_id,
            RetrainTrigger.last_triggered_at.is_not(None),
            RetrainTrigger.last_triggered_at >= since,
        )
        .limit(1)
    )
    return recent_id is not None


def _create_training_job_from_validated(
    db: Session,
    *,
    project_id: int,
    source: TrainingJob,
    validated,
    created_by: int | None,
) -> TrainingJob:
    body = validated.body
    version = validated.version
    job = TrainingJob(
        project_id=project_id,
        dataset_id=body.dataset_id,
        dataset_version_id=version.id if version else body.dataset_version_id,
        split_id=body.split_id,
        name=body.name.strip(),
        description=body.description or "",
        target_column=body.target_column,
        target_columns_json=dumps_target_columns(
            list(body.target_columns or [body.target_column])
        ),
        problem_type=body.problem_type,
        algorithm=body.algorithm,
        hyperparameters_json=json.dumps(body.hyperparameters or {}),
        preprocessing_json=json.dumps(body.preprocessing or {}),
        feature_columns_json=json.dumps(body.feature_columns or []),
        metrics_config_json=json.dumps(body.metrics_config or []),
        resource_json=json.dumps(body.resources or {}),
        random_seed=body.random_seed,
        train_ratio=body.train_ratio,
        val_ratio=body.val_ratio,
        test_ratio=body.test_ratio,
        max_retries=body.max_retries,
        status=JobStatus.pending,
        logs="Queued for closed-loop retraining.\n",
        created_by=created_by,
        retrain_source_job_id=source.id,
    )
    db.add(job)
    db.flush()
    return job


def decide_and_maybe_retrain(
    db: Session,
    *,
    run: ModelQualityRun,
    policy: ModelQualityPolicy,
    endpoint: Endpoint,
) -> dict[str, Any]:
    """Apply consecutive-breach / cooldown / dataset rules and optionally enqueue retrain."""

    snap = _snapshot_decision_config(run, policy)
    decision: dict[str, Any] = {
        "action": "none",
        "reason": None,
        "quality_status": run.quality_status,
        "policy_revision": snap["policy_revision"],
    }
    if run.quality_status == "insufficient_data":
        decision["reason"] = "insufficient_data"
        run.trigger_decision_json = _dumps(decision)
        return decision
    if run.quality_status != "critical":
        decision["reason"] = f"quality_status_{run.quality_status}"
        run.trigger_decision_json = _dumps(decision)
        return decision
    if not snap["auto_retrain"]:
        decision["reason"] = "auto_retrain_disabled"
        run.trigger_decision_json = _dumps(decision)
        return decision

    existing = db.scalar(
        select(RetrainTrigger).where(RetrainTrigger.quality_run_id == run.id)
    )
    if existing is not None:
        decision.update(
            {
                "action": "skipped",
                "reason": "retrain_already_triggered",
                "retrain_trigger_id": existing.id,
                "training_job_id": existing.created_training_job_id,
            }
        )
        run.trigger_decision_json = _dumps(decision)
        return decision

    breach_count = quality_service.count_consecutive_breaches(
        db,
        policy_id=policy.id,
        model_version_id=run.model_version_id,
        policy_revision=int(snap["policy_revision"]),
        required_status="critical",
    )
    decision["consecutive_breaches_observed"] = breach_count
    if breach_count < max(1, int(snap["consecutive_breaches"])):
        decision.update(
            {
                "action": "skipped",
                "reason": "consecutive_breaches_not_met",
            }
        )
        run.trigger_decision_json = _dumps(decision)
        write_audit(
            db,
            action="closed_loop.retrain_skipped",
            resource_type="model_quality_run",
            resource_id=run.id,
            after=decision,
        )
        return decision

    now = datetime.now(timezone.utc)
    if _cooldown_active(
        db,
        project_id=policy.project_id,
        endpoint_id=endpoint.id,
        cooldown_hours=int(snap["cooldown_hours"]),
        now=now,
    ):
        decision.update({"action": "skipped", "reason": "cooldown_active"})
        run.trigger_decision_json = _dumps(decision)
        write_audit(
            db,
            action="closed_loop.retrain_skipped",
            resource_type="model_quality_run",
            resource_id=run.id,
            after=decision,
        )
        return decision

    model = db.get(ModelVersion, run.model_version_id) if run.model_version_id else None
    ready, reason, source_job = quality_service.production_model_ready_for_retrain(db, model)
    if not ready or source_job is None:
        decision.update({"action": "skipped", "reason": reason or "not_ready"})
        run.trigger_decision_json = _dumps(decision)
        write_audit(
            db,
            action="closed_loop.retrain_skipped",
            resource_type="model_quality_run",
            resource_id=run.id,
            after=decision,
        )
        return decision

    target_version, version_reason = find_newer_compatible_dataset_version(
        db, project_id=run.project_id, source_job=source_job
    )
    if target_version is None:
        decision.update(
            {
                "action": "skipped",
                "reason": version_reason or "no_new_dataset_version",
            }
        )
        run.trigger_decision_json = _dumps(decision)
        write_audit(
            db,
            action="closed_loop.retrain_skipped",
            resource_type="model_quality_run",
            resource_id=run.id,
            after=decision,
        )
        if version_reason == "no_new_dataset_version":
            resource_id = str(run.id)
            if (
                _existing_alert(
                    db,
                    project_id=run.project_id,
                    alert_type="retrain_blocked_no_new_data",
                    resource_type="model_quality_run",
                    resource_id=resource_id,
                )
                is None
            ):
                create_alert(
                    db,
                    alert_type="retrain_blocked_no_new_data",
                    title=f"Retrain blocked: no new data for {endpoint.name}",
                    project_id=run.project_id,
                    severity=AlertSeverity.warning,
                    message=(
                        f"Quality run #{run.id} is critical, but dataset "
                        f"#{source_job.dataset_id} has no newer DatasetVersion than "
                        f"#{source_job.dataset_version_id}. Closed-loop will not retrain "
                        "on the same data."
                    ),
                    resource_type="model_quality_run",
                    resource_id=resource_id,
                    link_path=f"/projects/{run.project_id}/monitoring",
                )
        return decision

    try:
        validated = prepare_retrain_job(
            db,
            run.project_id,
            source_job,
            JobRetrainRequest(
                dataset_version_id=target_version.id,
                name=f"{source_job.name} (closed-loop retrain)",
            ),
        )
    except (RetrainConfigError, TrainingConfigError) as exc:
        detail = getattr(exc, "detail", str(exc))
        decision.update(
            {
                "action": "skipped",
                "reason": f"retrain_validation_failed:{detail}",
            }
        )
        run.trigger_decision_json = _dumps(decision)
        write_audit(
            db,
            action="closed_loop.retrain_skipped",
            resource_type="model_quality_run",
            resource_id=run.id,
            after=decision,
        )
        return decision

    evaluation = _loads(run.evaluation_json, {})
    rules = evaluation.get("rules") if isinstance(evaluation, dict) else []
    if not isinstance(rules, list):
        rules = []
    critical_rules = [
        row for row in rules if isinstance(row, dict) and row.get("status") == "critical"
    ]
    baseline = snap.get("baseline") if isinstance(snap.get("baseline"), dict) else None
    trigger = RetrainTrigger(
        project_id=run.project_id,
        trigger_type="quality_degradation",
        config_json=_dumps(
            {
                "quality_run_id": run.id,
                "policy_id": policy.id,
                "endpoint_id": endpoint.id,
                "source_model_version_id": run.model_version_id,
                "source_training_job_id": source_job.id,
                "target_dataset_version_id": target_version.id,
                "policy_revision": snap["policy_revision"],
                "rule_logic": snap["rule_logic"],
                "critical_rule_count": len(critical_rules),
                "baseline_quality_run_id": (
                    baseline.get("quality_run_id") if baseline else None
                ),
                "critical_rules": [
                    {
                        "metric": row.get("metric"),
                        "target": row.get("target"),
                        "comparison": row.get("comparison"),
                        "current_value": row.get("current_value"),
                        "degradation_delta": row.get("degradation_delta"),
                    }
                    for row in critical_rules[:5]
                ],
            }
        ),
        last_triggered_at=now,
        quality_run_id=run.id,
        source_model_version_id=run.model_version_id,
        target_dataset_version_id=target_version.id,
    )
    db.add(trigger)
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        existing = db.scalar(
            select(RetrainTrigger).where(RetrainTrigger.quality_run_id == run.id)
        )
        decision.update(
            {
                "action": "skipped",
                "reason": "retrain_already_triggered",
                "retrain_trigger_id": existing.id if existing else None,
            }
        )
        run.trigger_decision_json = _dumps(decision)
        return decision

    job = _create_training_job_from_validated(
        db,
        project_id=run.project_id,
        source=source_job,
        validated=validated,
        created_by=None,
    )
    trigger.created_training_job_id = job.id
    decision.update(
        {
            "action": "retrain_triggered",
            "reason": "critical_degradation",
            "retrain_trigger_id": trigger.id,
            "training_job_id": job.id,
            "target_dataset_version_id": target_version.id,
            "source_training_job_id": source_job.id,
            "source_model_version_id": run.model_version_id,
        }
    )
    run.trigger_decision_json = _dumps(decision)
    write_audit(
        db,
        action="closed_loop.retrain_triggered",
        resource_type="retrain_trigger",
        resource_id=trigger.id,
        after=decision,
    )
    return decision


def process_completed_quality_run(db: Session, run: ModelQualityRun) -> dict[str, Any]:
    policy = db.get(ModelQualityPolicy, run.policy_id)
    endpoint = db.get(Endpoint, run.endpoint_id)
    if policy is None or endpoint is None:
        return {"action": "none", "reason": "missing_policy_or_endpoint"}
    maybe_create_degradation_alert(db, run=run, policy=policy, endpoint=endpoint)
    return decide_and_maybe_retrain(db, run=run, policy=policy, endpoint=endpoint)


def logical_model_name(model: ModelVersion) -> str:
    prefix = f"project-{model.project_id}-"
    if model.name.startswith(prefix):
        return model.name[len(prefix) :]
    return model.name


def register_candidate_idempotently(
    db: Session,
    *,
    training_job: TrainingJob,
) -> ModelVersion | None:
    """Register a closed-loop retrain job as CANDIDATE (idempotent)."""

    trigger = db.scalar(
        select(RetrainTrigger).where(
            RetrainTrigger.created_training_job_id == training_job.id,
            RetrainTrigger.trigger_type == "quality_degradation",
        )
    )
    if trigger is None:
        return None
    if trigger.candidate_model_version_id:
        return db.get(ModelVersion, trigger.candidate_model_version_id)
    if training_job.status != JobStatus.succeeded or not training_job.mlflow_run_id:
        return None

    source_model = (
        db.get(ModelVersion, trigger.source_model_version_id)
        if trigger.source_model_version_id
        else None
    )
    # MLflow naming uses a logical stem; ModelVersion.name must match source PRODUCTION.
    mlflow_stem = logical_model_name(source_model) if source_model else training_job.name
    registry_name = source_model.name if source_model is not None else None

    closed_loop = {
        "quality_run_id": trigger.quality_run_id,
        "retrain_trigger_id": trigger.id,
        "source_model_version_id": trigger.source_model_version_id,
        "source_training_job_id": training_job.retrain_source_job_id,
        "target_dataset_version_id": trigger.target_dataset_version_id
        or training_job.dataset_version_id,
    }

    # Idempotency: reuse an existing ModelVersion for this training job.
    existing = db.scalar(
        select(ModelVersion)
        .where(
            ModelVersion.project_id == training_job.project_id,
            ModelVersion.training_job_id == training_job.id,
        )
        .order_by(ModelVersion.id.desc())
    )
    if existing is not None:
        if registry_name is not None and existing.name != registry_name:
            existing.name = registry_name
        trigger.candidate_model_version_id = existing.id
        metadata = _loads(existing.metadata_json, {})
        if isinstance(metadata, dict):
            metadata["closed_loop"] = closed_loop
            existing.metadata_json = _dumps(metadata)
        return existing

    try:
        row = registry_service.register_from_run(
            db,
            project_id=training_job.project_id,
            run_id=str(training_job.mlflow_run_id),
            model_name=mlflow_stem,
            artifact_path="model",
            dataset_version_id=training_job.dataset_version_id,
            training_job_id=training_job.id,
            created_by=None,
            registry_model_name=registry_name,
        )
    except Exception as exc:
        create_alert(
            db,
            alert_type="closed_loop_candidate_registration_failed",
            title=f"Closed-loop candidate registration failed for job #{training_job.id}",
            project_id=training_job.project_id,
            severity=AlertSeverity.error,
            message=str(exc),
            resource_type="training_job",
            resource_id=str(training_job.id),
            link_path=f"/projects/{training_job.project_id}/jobs/{training_job.id}",
        )
        write_audit(
            db,
            action="closed_loop.candidate_registered",
            resource_type="training_job",
            resource_id=training_job.id,
            success=False,
            failure_reason=str(exc),
        )
        # Keep TrainingJob succeeded; do not raise (avoids duplicate worker failure alerts).
        return None

    metadata = _loads(row.metadata_json, {})
    if not isinstance(metadata, dict):
        metadata = {}
    metadata["closed_loop"] = closed_loop
    row.metadata_json = _dumps(metadata)
    # Keep lifecycle at CANDIDATE even if gates pass.
    row.lifecycle = ModelLifecycle.CANDIDATE
    try:
        registry_service.evaluate_gates(db, row, actor_id=None)
    except Exception:
        # Gate failure must not promote lifecycle.
        pass
    row.lifecycle = ModelLifecycle.CANDIDATE
    trigger.candidate_model_version_id = row.id

    create_alert(
        db,
        alert_type="retraining_candidate_ready",
        title=f"Retraining candidate ready: {row.name} v{row.version}",
        project_id=training_job.project_id,
        severity=AlertSeverity.info,
        message=(
            f"Closed-loop retraining produced ModelVersion #{row.id} in CANDIDATE. "
            "Review the candidate before requesting approval. Automatic PRODUCTION "
            "promotion is never performed."
        ),
        resource_type="model_version",
        resource_id=str(row.id),
        link_path=f"/projects/{training_job.project_id}/models/{row.id}",
    )
    write_audit(
        db,
        action="closed_loop.candidate_registered",
        resource_type="model_version",
        resource_id=row.id,
        after={
            "lifecycle": row.lifecycle.value,
            "closed_loop": closed_loop,
            "gates_passed": row.gates_passed,
        },
    )
    return row


def compute_closed_loop_state(
    db: Session,
    *,
    project_id: int,
    endpoint_id: int,
) -> str:
    """Presentation-only closed-loop state derived from persisted entities."""

    latest_run = db.scalar(
        select(ModelQualityRun)
        .where(
            ModelQualityRun.project_id == project_id,
            ModelQualityRun.endpoint_id == endpoint_id,
            ModelQualityRun.status == JobStatus.succeeded,
        )
        .order_by(ModelQualityRun.id.desc())
    )
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
    if latest_trigger is not None:
        if latest_trigger.candidate_model_version_id:
            candidate = db.get(ModelVersion, latest_trigger.candidate_model_version_id)
            if candidate and candidate.lifecycle == ModelLifecycle.CANDIDATE:
                return "Candidate ready"
            if candidate and candidate.lifecycle == ModelLifecycle.PENDING_APPROVAL:
                return "Awaiting human review"
        if latest_trigger.created_training_job_id:
            job = db.get(TrainingJob, latest_trigger.created_training_job_id)
            if job is not None:
                if job.status in {JobStatus.pending, JobStatus.queued}:
                    return "Retraining queued"
                if job.status == JobStatus.running:
                    return "Retraining running"
                if (
                    job.status == JobStatus.succeeded
                    and not latest_trigger.candidate_model_version_id
                ):
                    return "Candidate ready"

    if latest_run and latest_run.quality_status in {"warning", "critical"}:
        return "Degraded"
    return "Healthy"
