from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.db.models import DatasetVersion, ModelLifecycle, ModelVersion, TrainingJob
from app.services import inference, mlflow_service

CLASSIFICATION_METRICS = ("accuracy", "f1", "f1_score", "f1_macro", "f1_weighted")


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


def _normalize_schema(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        value = value.get("features", value.get("columns", []))
    if not isinstance(value, list):
        return []
    fields: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, str) and item:
            fields.append({"name": item, "required": True})
        elif isinstance(item, dict) and item.get("name"):
            fields.append({**item, "name": str(item["name"])})
    return fields


def _feature_schema(
    db: Session,
    row: ModelVersion,
    metadata: dict[str, Any],
    job: TrainingJob | None,
) -> tuple[list[dict[str, Any]], str | None, DatasetVersion | None]:
    version_id = row.dataset_version_id
    schema = _normalize_schema(
        metadata.get("feature_schema") or metadata.get("features")
    )
    if schema:
        version = db.get(DatasetVersion, version_id) if version_id else None
        return schema, "metadata", version
    if job is None:
        return [], None, db.get(DatasetVersion, version_id) if version_id else None

    version_id = job.dataset_version_id or version_id
    version = db.get(DatasetVersion, version_id) if version_id else None
    try:
        feature_names = json.loads(job.feature_columns_json or "[]")
    except json.JSONDecodeError:
        feature_names = []
    if not isinstance(feature_names, list):
        feature_names = []
    if not feature_names and version is not None:
        try:
            columns = json.loads(version.columns_json or "[]")
        except json.JSONDecodeError:
            columns = []
        feature_names = [
            name for name in columns if isinstance(name, str) and name != job.target_column
        ]
    dtypes = _json(version.dtypes_json) if version is not None else {}
    schema = [
        {
            "name": str(name),
            "dtype": str(dtypes.get(str(name), "")),
            "required": True,
        }
        for name in feature_names
        if name
    ]
    return schema, "training_job" if schema else None, version


def _generated_value(field: dict[str, Any]) -> Any:
    for key in ("example", "sample", "default"):
        if key in field:
            return field[key]
    dtype = str(field.get("dtype", field.get("type", ""))).lower()
    if "bool" in dtype:
        return False
    if any(token in dtype for token in ("str", "text", "object", "category")):
        return ""
    if any(token in dtype for token in ("int", "long")):
        return 0
    return 0.0


def _test_sample(
    schema: list[dict[str, Any]],
    version: DatasetVersion | None,
    configured: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, str | None]:
    names = [str(field["name"]) for field in schema]
    if configured:
        return {name: configured[name] for name in names if name in configured}, "configured"
    if version is not None:
        try:
            preview = json.loads(version.preview_json or "[]")
        except json.JSONDecodeError:
            preview = []
        if isinstance(preview, list) and preview and isinstance(preview[0], dict):
            sample = {name: preview[0][name] for name in names if name in preview[0]}
            if sample:
                return sample, "dataset"
    if schema:
        return {str(field["name"]): _generated_value(field) for field in schema}, "schema"
    return None, None


def _gate_config(
    metadata: dict[str, Any], gates: dict[str, Any] | list[dict[str, Any]] | None
) -> dict[str, Any]:
    configured = metadata.get("gates", {})
    config = dict(configured) if isinstance(configured, dict) else {}
    if isinstance(gates, dict):
        config.update(gates)
    elif isinstance(gates, list):
        for gate in gates:
            gate_type = str(gate.get("type", "")).lower()
            if gate_type == "min_metric":
                config["metric"] = {
                    "name": gate.get("metric"),
                    "minimum": gate.get(
                        "min", gate.get("minimum", gate.get("value", 0))
                    ),
                }
            elif gate_type in {"max_latency", "max_inference_latency"}:
                config["max_inference_latency_ms"] = gate.get(
                    "max", gate.get("maximum", gate.get("value", 5000))
                )
            elif gate_type == "test_predict" and isinstance(gate.get("instance"), dict):
                config["test_instance"] = gate["instance"]
    return config


def _metric_gate(
    metrics: dict[str, Any],
    problem_type: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    metric_config = config.get("metric", {})
    if isinstance(metric_config, str):
        metric_config = {"name": metric_config}
    if not isinstance(metric_config, dict):
        metric_config = {}
    name = metric_config.get("name") or metric_config.get("metric")
    minimum = metric_config.get(
        "minimum", metric_config.get("min", config.get("metric_minimum"))
    )
    maximum = metric_config.get(
        "maximum", metric_config.get("max", config.get("metric_maximum"))
    )

    kind = problem_type.lower()
    if not name and (
        kind == "classification"
        or any(key in metrics for key in CLASSIFICATION_METRICS)
    ):
        name = next(
            (key for key in CLASSIFICATION_METRICS if key in metrics),
            "accuracy",
        )
        minimum = 0.5 if minimum is None else minimum
    elif not name and (kind == "regression" or "r2" in metrics or "rmse" in metrics):
        if "r2" in metrics:
            name = "r2"
            minimum = 0.0 if minimum is None else minimum
        else:
            name = "rmse"
    name = str(name or "accuracy")
    if minimum is None and maximum is None and name != "rmse":
        minimum = 0.5 if name in CLASSIFICATION_METRICS else 0.0

    actual = metrics.get(name)
    try:
        numeric = float(actual)
        passed = math.isfinite(numeric)
    except (TypeError, ValueError):
        numeric = None
        passed = False
    expected: dict[str, float] = {}
    try:
        if minimum is not None:
            expected["minimum"] = float(minimum)
            passed = passed and numeric is not None and numeric >= float(minimum)
        if maximum is not None:
            expected["maximum"] = float(maximum)
            passed = passed and numeric is not None and numeric <= float(maximum)
    except (TypeError, ValueError):
        passed = False
        expected = {}
    return _gate_result(
        "metric_threshold",
        passed=passed,
        message=(
            f"{name} satisfies the configured threshold."
            if passed
            else f"{name} is missing, non-finite, or outside the configured threshold."
        ),
        observed={"metric": name, "value": actual},
        expected=expected or {"finite": True},
    )


def server_gates_passed(row: ModelVersion) -> bool:
    results = _json(row.gate_results_json)
    return bool(
        row.gates_passed
        and results.get("passed") is True
        and results.get("computed_by") == "server"
        and results.get("gate_version") == "1"
    )


def evaluate_gates(
    db: Session,
    model_version: ModelVersion | int,
    gates: dict[str, Any] | list[dict[str, Any]] | None = None,
    *,
    test_instance: dict[str, Any] | None = None,
    actor_id: int | None = None,
) -> dict[str, Any]:
    row = _model(db, model_version)
    if row.lifecycle in {
        ModelLifecycle.APPROVED,
        ModelLifecycle.PRODUCTION,
        ModelLifecycle.ARCHIVED,
    }:
        raise ValueError(f"Cannot evaluate gates while model is {row.lifecycle.value}.")
    previous_lifecycle = row.lifecycle
    row.lifecycle = ModelLifecycle.VALIDATING
    db.flush()

    metrics = _json(row.metrics_json)
    metadata = _json(row.metadata_json)
    config = _gate_config(metadata, gates)
    job = db.get(TrainingJob, row.training_job_id) if row.training_job_id else None
    schema, schema_source, version = _feature_schema(db, row, metadata, job)
    sample, sample_source = _test_sample(
        schema,
        version,
        test_instance
        or (
            config.get("test_instance")
            if isinstance(config.get("test_instance"), dict)
            else None
        ),
    )
    results: list[dict[str, Any]] = []

    run: dict[str, Any] | None = None
    try:
        run = mlflow_service.get_run(str(row.mlflow_run_id))
        expected_experiment = mlflow_service.ensure_experiment(
            f"project-{row.project_id}"
        )
        run_belongs = str(run.get("experiment_id")) == str(expected_experiment)
        results.append(
            _gate_result(
                "mlflow_project",
                passed=run_belongs,
                message=(
                    "MLflow run belongs to the project experiment."
                    if run_belongs
                    else "MLflow run belongs to a different project experiment."
                ),
                observed=run.get("experiment_id"),
                expected=expected_experiment,
            )
        )
    except Exception as exc:
        results.append(
            _gate_result(
                "mlflow_project",
                passed=False,
                message=f"MLflow run could not be verified: {exc}",
            )
        )

    artifact_path = str(metadata.get("artifact_path") or "model")
    artifact_present = bool(
        run
        and mlflow_service.artifact_exists(
            str(row.mlflow_run_id), artifact_path, run.get("artifacts")
        )
    )
    results.append(
        _gate_result(
            "artifact_exists",
            passed=artifact_present,
            message=(
                "Model artifact exists in the MLflow run."
                if artifact_present
                else "Model artifact is missing from the MLflow run."
            ),
            observed=artifact_path if artifact_present else None,
            expected=artifact_path,
        )
    )

    loaded_model: Any = None
    try:
        loaded_model = inference.load_model(row.model_uri)
        results.append(
            _gate_result(
                "load_model", passed=True, message="Model loaded successfully."
            )
        )
    except Exception as exc:
        results.append(
            _gate_result(
                "load_model", passed=False, message=f"Model load failed: {exc}"
            )
        )

    results.append(
        _gate_result(
            "schema_present",
            passed=bool(schema),
            message=(
                f"Feature schema is present from {schema_source}."
                if schema
                else "Feature schema is missing."
            ),
            observed=schema,
            expected={"source": "metadata_or_training_job"},
        )
    )

    prediction: Any = None
    latency_ms: float | None = None
    prediction_error: Exception | None = None
    if loaded_model is None:
        prediction_error = ValueError("Model was not loaded.")
    elif not sample:
        prediction_error = ValueError("No test instance could be created.")
    else:
        try:
            inference.validate_instances([sample], schema)
            started = time.perf_counter()
            prediction = loaded_model.predict(pd.DataFrame([sample]))
            latency_ms = (time.perf_counter() - started) * 1000
            if len(prediction) != 1:
                raise ValueError("Model did not return exactly one prediction.")
        except Exception as exc:
            prediction_error = exc
    results.append(
        _gate_result(
            "test_inference",
            passed=prediction_error is None,
            message=(
                "Single-sample test inference succeeded."
                if prediction_error is None
                else f"Test inference failed: {prediction_error}"
            ),
            observed={"sample_source": sample_source, "prediction_count": 1}
            if prediction_error is None
            else {"sample_source": sample_source},
            expected={"prediction_count": 1},
        )
    )

    problem_type = str(
        (job.problem_type if job is not None else None)
        or metadata.get("problem_type")
        or "auto"
    )
    results.append(_metric_gate(metrics, problem_type, config))

    try:
        max_latency_ms = float(config.get("max_inference_latency_ms", 5000))
    except (TypeError, ValueError):
        max_latency_ms = 5000.0
    latency_passed = (
        latency_ms is not None
        and math.isfinite(latency_ms)
        and latency_ms <= max_latency_ms
    )
    results.append(
        _gate_result(
            "inference_latency",
            passed=latency_passed,
            message=(
                "Test inference latency is within the configured maximum."
                if latency_passed
                else "Test inference latency is unavailable or exceeds the configured maximum."
            ),
            observed={"latency_ms": latency_ms},
            expected={"maximum_ms": max_latency_ms},
        )
    )

    passed = all(result["passed"] for result in results)
    summary = {
        "passed": passed,
        "results": results,
        "computed_by": "server",
        "gate_version": "1",
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }
    row.gate_results_json = json.dumps(summary)
    row.gates_passed = passed
    row.lifecycle = (
        ModelLifecycle.PENDING_APPROVAL
        if previous_lifecycle == ModelLifecycle.PENDING_APPROVAL
        else ModelLifecycle.CANDIDATE
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


def run_gates(
    db: Session,
    model_version: ModelVersion | int,
    gates: dict[str, Any] | list[dict[str, Any]] | None = None,
    *,
    test_instance: dict[str, Any] | None = None,
    actor_id: int | None = None,
) -> dict[str, Any]:
    """Backward-compatible alias for the server-owned gate evaluator."""

    return evaluate_gates(
        db,
        model_version,
        gates,
        test_instance=test_instance,
        actor_id=actor_id,
    )


def request_approval(
    db: Session, model_version: ModelVersion | int, *, actor_id: int | None = None
) -> ModelVersion:
    row = _model(db, model_version)
    if not server_gates_passed(row):
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
    if (
        row.lifecycle != ModelLifecycle.PENDING_APPROVAL
        or not server_gates_passed(row)
    ):
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
