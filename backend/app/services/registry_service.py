from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.db.models import ModelLifecycle, ModelVersion, TrainingJob
from app.services import inference, mlflow_service


def _model(db: Session, value: ModelVersion | int) -> ModelVersion:
    if isinstance(value, ModelVersion):
        return value
    row = db.get(ModelVersion, value)
    if row is None:
        raise ValueError(f"Model version {value} was not found.")
    return row


def _json(value: str | None) -> dict[str, Any]:
    try:
        loaded = json.loads(value or "{}")
        return loaded if isinstance(loaded, dict) else {}
    except json.JSONDecodeError:
        return {}


def register_from_run(
    db: Session,
    *,
    project_id: int,
    run_id: str,
    model_name: str,
    artifact_path: str = "model",
    dataset_version_id: int | None = None,
    training_job_id: int | None = None,
    pipeline_run_id: int | None = None,
    created_by: int | None = None,
) -> ModelVersion:
    """Register an MLflow run and mirror it in the app-owned registry."""

    run = mlflow_service.get_run(run_id)
    expected_experiment = mlflow_service.ensure_experiment(f"project-{project_id}")
    if str(run.get("experiment_id")) != str(expected_experiment):
        raise ValueError("The MLflow run does not belong to this project.")

    mlflow_name = (
        model_name
        if model_name.startswith(f"project-{project_id}-")
        else f"project-{project_id}-{model_name}"
    )
    registered = mlflow_service.register_model(run_id, mlflow_name, artifact_path)
    version = str(registered["version"])
    if (
        db.scalar(
            select(ModelVersion.id).where(
                ModelVersion.project_id == project_id,
                ModelVersion.name == mlflow_name,
                ModelVersion.version == version,
            )
        )
        is not None
    ):
        raise ValueError(f"Model {mlflow_name} version {version} is already registered.")

    if training_job_id is None:
        training_job = db.scalar(
            select(TrainingJob).where(
                TrainingJob.project_id == project_id,
                TrainingJob.mlflow_run_id == run_id,
            )
        )
        training_job_id = training_job.id if training_job else None
        if dataset_version_id is None and training_job is not None:
            dataset_version_id = training_job.dataset_version_id

    params = run.get("params") or {}
    feature_names = [name for name in str(params.get("features", "")).split(",") if name]
    metadata = {
        "artifact_path": artifact_path,
        "feature_schema": [{"name": name, "required": True} for name in feature_names],
        "run_tags": run.get("tags") or {},
    }
    row = ModelVersion(
        project_id=project_id,
        name=mlflow_name,
        version=version,
        lifecycle=ModelLifecycle.CANDIDATE,
        mlflow_model_name=str(registered["name"]),
        mlflow_version=version,
        mlflow_run_id=run_id,
        model_uri=f"models:/{registered['name']}/{version}",
        metrics_json=json.dumps(run.get("metrics") or {}),
        metadata_json=json.dumps(metadata),
        dataset_version_id=dataset_version_id,
        training_job_id=training_job_id,
        pipeline_run_id=pipeline_run_id,
        created_by=created_by,
    )
    db.add(row)
    db.flush()
    write_audit(
        db,
        action="model.register",
        resource_type="model_version",
        resource_id=row.id,
        user_id=created_by,
        after={"name": row.name, "version": row.version, "lifecycle": row.lifecycle.value},
    )
    return row


def _gate_result(
    gate_type: str,
    *,
    passed: bool,
    message: str,
    observed: Any = None,
    expected: Any = None,
) -> dict[str, Any]:
    return {
        "type": gate_type,
        "passed": passed,
        "message": message,
        "observed": observed,
        "expected": expected,
    }


def run_gates(
    db: Session,
    model_version: ModelVersion | int,
    gates: list[dict[str, Any]] | None = None,
    *,
    test_instance: dict[str, Any] | None = None,
    actor_id: int | None = None,
) -> dict[str, Any]:
    row = _model(db, model_version)
    if row.lifecycle in {
        ModelLifecycle.PRODUCTION,
        ModelLifecycle.ARCHIVED,
        ModelLifecycle.REJECTED,
    }:
        raise ValueError(f"Cannot run gates while model is {row.lifecycle.value}.")
    row.lifecycle = ModelLifecycle.VALIDATING
    db.flush()

    metrics = _json(row.metrics_json)
    metadata = _json(row.metadata_json)
    schema = metadata.get("feature_schema") or metadata.get("features")
    configured = gates or [
        {"type": "load_model"},
        {"type": "schema_present"},
    ]
    results: list[dict[str, Any]] = []
    loaded_model: Any = None
    for gate in configured:
        gate_type = str(gate.get("type", "")).lower()
        if gate_type == "min_metric":
            metric = str(gate.get("metric", ""))
            minimum = float(gate.get("min", gate.get("minimum", gate.get("value", 0))))
            actual = metrics.get(metric)
            passed = actual is not None and float(actual) >= minimum
            results.append(
                _gate_result(
                    gate_type,
                    passed=passed,
                    message=(
                        f"{metric} satisfies the minimum."
                        if passed
                        else f"{metric} is missing or below the minimum."
                    ),
                    observed=actual,
                    expected={"minimum": minimum},
                )
            )
        elif gate_type == "load_model":
            try:
                loaded_model = inference.load_model(row.model_uri)
                results.append(
                    _gate_result(gate_type, passed=True, message="Model loaded successfully.")
                )
            except Exception as exc:
                results.append(
                    _gate_result(gate_type, passed=False, message=f"Model load failed: {exc}")
                )
        elif gate_type == "schema_present":
            results.append(
                _gate_result(
                    gate_type,
                    passed=bool(schema),
                    message="Feature schema is present." if schema else "Feature schema is missing.",
                    observed=schema,
                )
            )
        elif gate_type == "test_predict":
            instance = gate.get("instance", test_instance)
            if not instance:
                results.append(
                    _gate_result(
                        gate_type,
                        passed=False,
                        message="A test instance is required for test_predict.",
                    )
                )
                continue
            try:
                if loaded_model is None:
                    loaded_model = inference.load_model(row.model_uri)
                inference.validate_instances([instance], schema)
                prediction = loaded_model.predict(pd.DataFrame([instance]))
                results.append(
                    _gate_result(
                        gate_type,
                        passed=len(prediction) == 1,
                        message="Test prediction succeeded.",
                    )
                )
            except Exception as exc:
                results.append(
                    _gate_result(gate_type, passed=False, message=f"Test prediction failed: {exc}")
                )
        else:
            raise ValueError(f"Unsupported registry gate type: {gate_type or '<empty>'}")

    passed = all(result["passed"] for result in results)
    summary = {
        "passed": passed,
        "results": results,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }
    row.gate_results_json = json.dumps(summary)
    row.gates_passed = passed
    row.lifecycle = (
        ModelLifecycle.PENDING_APPROVAL if passed else ModelLifecycle.CANDIDATE
    )
    write_audit(
        db,
        action="model.gates",
        resource_type="model_version",
        resource_id=row.id,
        user_id=actor_id,
        after=summary,
    )
    db.flush()
    return summary


def request_approval(
    db: Session, model_version: ModelVersion | int, *, actor_id: int | None = None
) -> ModelVersion:
    row = _model(db, model_version)
    if not row.gates_passed:
        raise ValueError("Model evaluation gates must pass before requesting approval.")
    before = row.lifecycle.value
    row.lifecycle = ModelLifecycle.PENDING_APPROVAL
    write_audit(
        db,
        action="model.request_approval",
        resource_type="model_version",
        resource_id=row.id,
        user_id=actor_id,
        before={"lifecycle": before},
        after={"lifecycle": row.lifecycle.value},
    )
    db.flush()
    return row


def approve_model(
    db: Session,
    model_version: ModelVersion | int,
    *,
    approved_by: int | None = None,
    comment: str | None = None,
) -> ModelVersion:
    row = _model(db, model_version)
    if row.lifecycle != ModelLifecycle.PENDING_APPROVAL or not row.gates_passed:
        raise ValueError("Only a gate-passed model pending approval can be approved.")
    row.lifecycle = ModelLifecycle.APPROVED
    row.approved_by = approved_by
    row.approved_at = datetime.now(timezone.utc)
    row.approval_comment = comment
    write_audit(
        db,
        action="model.approve",
        resource_type="model_version",
        resource_id=row.id,
        user_id=approved_by,
        after={"lifecycle": row.lifecycle.value, "comment": comment},
    )
    db.flush()
    return row


def reject_model(
    db: Session,
    model_version: ModelVersion | int,
    *,
    rejected_by: int | None = None,
    comment: str | None = None,
) -> ModelVersion:
    row = _model(db, model_version)
    if row.lifecycle not in {
        ModelLifecycle.CANDIDATE,
        ModelLifecycle.VALIDATING,
        ModelLifecycle.PENDING_APPROVAL,
    }:
        raise ValueError(f"Cannot reject a model in {row.lifecycle.value}.")
    row.lifecycle = ModelLifecycle.REJECTED
    row.approved_by = rejected_by
    row.approval_comment = comment
    write_audit(
        db,
        action="model.reject",
        resource_type="model_version",
        resource_id=row.id,
        user_id=rejected_by,
        after={"lifecycle": row.lifecycle.value, "comment": comment},
    )
    db.flush()
    return row


def promote_model(
    db: Session,
    model_version: ModelVersion | int,
    *,
    promoted_by: int | None = None,
) -> ModelVersion:
    row = _model(db, model_version)
    if row.lifecycle != ModelLifecycle.APPROVED:
        raise ValueError("Only an approved model can be promoted to production.")
    current = db.scalar(
        select(ModelVersion).where(
            ModelVersion.project_id == row.project_id,
            ModelVersion.name == row.name,
            ModelVersion.lifecycle == ModelLifecycle.PRODUCTION,
        )
    )
    if current and current.id != row.id:
        current.lifecycle = ModelLifecycle.APPROVED
    row.lifecycle = ModelLifecycle.PRODUCTION
    write_audit(
        db,
        action="model.promote",
        resource_type="model_version",
        resource_id=row.id,
        user_id=promoted_by,
        before={"previous_production_id": current.id if current else None},
        after={"lifecycle": row.lifecycle.value},
    )
    db.flush()
    return row


def rollback_model(
    db: Session,
    target_version: ModelVersion | int,
    *,
    rolled_back_by: int | None = None,
) -> ModelVersion:
    target = _model(db, target_version)
    if target.lifecycle != ModelLifecycle.APPROVED:
        raise ValueError("Rollback target must be an approved prior version.")
    current = db.scalar(
        select(ModelVersion).where(
            ModelVersion.project_id == target.project_id,
            ModelVersion.name == target.name,
            ModelVersion.lifecycle == ModelLifecycle.PRODUCTION,
        )
    )
    if current is None:
        raise ValueError("There is no production model to roll back.")
    current.lifecycle = ModelLifecycle.APPROVED
    target.lifecycle = ModelLifecycle.PRODUCTION
    write_audit(
        db,
        action="model.rollback",
        resource_type="model_version",
        resource_id=target.id,
        user_id=rolled_back_by,
        before={"production_id": current.id},
        after={"production_id": target.id},
    )
    db.flush()
    return target


def archive_model(
    db: Session,
    model_version: ModelVersion | int,
    *,
    archived_by: int | None = None,
) -> ModelVersion:
    row = _model(db, model_version)
    if row.lifecycle == ModelLifecycle.PRODUCTION:
        raise ValueError("Promote or roll back another version before archiving production.")
    if row.lifecycle == ModelLifecycle.ARCHIVED:
        return row
    row.lifecycle = ModelLifecycle.ARCHIVED
    write_audit(
        db,
        action="model.archive",
        resource_type="model_version",
        resource_id=row.id,
        user_id=archived_by,
        after={"lifecycle": row.lifecycle.value},
    )
    db.flush()
    return row


register_model_from_run = register_from_run
approve = approve_model
reject = reject_model
promote = promote_model
rollback = rollback_model
archive = archive_model
