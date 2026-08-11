from __future__ import annotations

import json
import operator
import uuid
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.db.models import (
    BatchInferenceJob,
    Dataset,
    DatasetVersion,
    Endpoint,
    JobStatus,
    ModelLifecycle,
    ModelVersion,
    PipelineRun,
    PipelineVersion,
    QualityCheck,
    QualityResult,
    QualityRule,
    TrainingJob,
)
from app.services import datasets as dataset_service
from app.services import inference, quality, storage
from app.services.alerts import create_alert
from app.services.algorithm_catalog import canonicalize_algorithm, resolve_algorithm
from app.services.training import TrainingJobContext, get_training_runner

NODE_TYPES = {
    "dataset_load",
    "quality_check",
    "split",
    "preprocessing",
    "training",
    "evaluation",
    "condition",
    "model_registration",
    "approval_request",
    "endpoint_deployment",
    "batch_prediction",
    "notification",
}
REQUIRED_PORTS = {
    "dataset_load": [],
    "quality_check": ["data"],
    "split": ["data"],
    "preprocessing": ["data"],
    "training": ["data"],
    "evaluation": ["model"],
    "condition": ["input"],
    "model_registration": ["model"],
    "approval_request": ["model"],
    "endpoint_deployment": ["model"],
    "batch_prediction": ["model", "data"],
    "notification": [],
}


def _node_type(node: dict[str, Any]) -> str:
    data = node.get("data") or {}
    candidates = (data.get("node_type"), data.get("nodeType"), data.get("type"), node.get("type"))
    return next((str(value) for value in candidates if value in NODE_TYPES), str(node.get("type", "")))


def _node_config(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("data") or {}
    config = dict(data.get("config") or {})
    for key, value in data.items():
        if key not in {"config", "label", "type", "node_type", "nodeType"}:
            config.setdefault(key, value)
    config.update(node.get("config") or {})
    return config


def _node_label(node: dict[str, Any]) -> str:
    data = node.get("data") or {}
    label = data.get("label")
    if label:
        return str(label)
    return str(node.get("id") or "step")


def initial_node_state(node: dict[str, Any]) -> dict[str, Any]:
    """Seed run node_states with readable metadata for the UI."""
    return {
        "status": "pending",
        "label": _node_label(node),
        "node_type": _node_type(node) or "unknown",
        "attempt": 1,
    }


CONDITION_OPERATORS = {">", ">=", "<", "<=", "==", "!="}


def _edge_branch(edge: dict[str, Any]) -> str:
    data = edge.get("data") or {}
    value = data.get(
        "branch", edge.get("branch", edge.get("label", data.get("label", "always")))
    )
    if isinstance(value, bool):
        return str(value).lower()
    return str(value or "always").strip().lower()


def _validate_strict_node_config(node_id: str, node_type: str, config: dict[str, Any]) -> list[str]:
    """Node-level config checks applied only when validate_graph(strict=True)."""

    errors: list[str] = []
    if node_type == "training":
        target = str(config.get("target_column") or "").strip()
        if not target:
            errors.append(f"Node '{node_id}' requires a non-empty target_column.")
        algorithm = str(config.get("algorithm") or "").strip()
        if not algorithm:
            errors.append(f"Node '{node_id}' requires a non-empty algorithm.")
        problem_type = str(config.get("problem_type") or "auto").lower().strip()
        if problem_type not in {"auto", "classification", "regression"}:
            errors.append(
                f"Node '{node_id}' has unsupported problem_type '{problem_type}'."
            )
        elif algorithm:
            try:
                if problem_type == "auto":
                    canonicalize_algorithm(algorithm)
                else:
                    resolve_algorithm(algorithm, problem_type)
            except ValueError as exc:
                errors.append(f"Node '{node_id}' {exc}")
    elif node_type == "split":
        try:
            train_ratio = float(config.get("train_ratio", 0.7))
            val_ratio = float(config.get("val_ratio", 0.15))
            test_ratio = float(config.get("test_ratio", 0.15))
        except (TypeError, ValueError):
            errors.append(f"Node '{node_id}' requires numeric split ratios.")
            return errors
        for name, ratio in (
            ("train_ratio", train_ratio),
            ("val_ratio", val_ratio),
            ("test_ratio", test_ratio),
        ):
            if not (0.0 < ratio < 1.0):
                errors.append(
                    f"Node '{node_id}' requires {name} to be greater than 0 and less than 1."
                )
        if abs(train_ratio + val_ratio + test_ratio - 1.0) >= 1e-9:
            errors.append(f"Node '{node_id}' requires split ratios to sum to 1.0.")
        seed = config.get("random_seed", 42)
        if isinstance(seed, bool) or not isinstance(seed, int):
            try:
                if isinstance(seed, float) and seed.is_integer():
                    seed = int(seed)
                elif isinstance(seed, str) and seed.strip().lstrip("-").isdigit():
                    seed = int(seed)
                else:
                    raise ValueError
            except (TypeError, ValueError):
                errors.append(f"Node '{node_id}' requires random_seed to be an integer.")
    elif node_type == "evaluation":
        metric = config.get("metric")
        if metric is None or str(metric).strip() == "":
            errors.append(f"Node '{node_id}' requires a metric.")
        minimum = config.get("minimum", config.get("min"))
        if minimum is None or (isinstance(minimum, str) and minimum.strip() == ""):
            errors.append(f"Node '{node_id}' requires a numeric minimum (or min).")
        else:
            try:
                float(minimum)
            except (TypeError, ValueError):
                errors.append(f"Node '{node_id}' requires a numeric minimum (or min).")
    elif node_type == "condition":
        metric = config.get("metric")
        left = config.get("left")
        if (metric is None or str(metric).strip() == "") and left is None:
            errors.append(f"Node '{node_id}' requires metric or left.")
        right = config.get("value", config.get("right"))
        if right is None or (isinstance(right, str) and right.strip() == ""):
            errors.append(f"Node '{node_id}' requires value or right.")
        operation = config.get("operator")
        if operation is None or str(operation).strip() == "":
            errors.append(f"Node '{node_id}' requires an operator.")
        elif str(operation) not in CONDITION_OPERATORS:
            errors.append(
                f"Node '{node_id}' has unsupported condition operator '{operation}'."
            )
    return errors


def validate_graph(graph: dict[str, Any], *, strict: bool = True) -> dict[str, Any]:
    """Validate node types, references, required input ports, and acyclicity."""

    errors: list[str] = []
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list):
        return {"valid": False, "errors": ["Graph nodes must be a list."], "order": []}
    if not nodes:
        if strict:
            return {
                "valid": False,
                "errors": ["Graph must contain at least one node."],
                "order": [],
            }
        return {"valid": True, "errors": [], "order": []}
    if not isinstance(edges, list):
        return {"valid": False, "errors": ["Graph edges must be a list."], "order": []}

    ids = [str(node.get("id", "")) for node in nodes]
    if any(not node_id for node_id in ids):
        errors.append("Every node must have a non-empty id.")
    duplicates = sorted({node_id for node_id in ids if ids.count(node_id) > 1})
    if duplicates:
        errors.append(f"Duplicate node ids: {duplicates}")
    node_map = {str(node.get("id")): node for node in nodes if node.get("id")}
    for node_id, node in node_map.items():
        node_type = _node_type(node)
        if node_type and node_type not in NODE_TYPES:
            errors.append(f"Node '{node_id}' has unsupported type '{node_type}'.")
        elif strict and node_type not in NODE_TYPES:
            errors.append(f"Node '{node_id}' has unsupported type '{node_type}'.")

    incoming: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in node_map}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in node_map}
    indegree = {node_id: 0 for node_id in node_map}
    for edge in edges:
        source, target = str(edge.get("source", "")), str(edge.get("target", ""))
        if source not in node_map or target not in node_map:
            errors.append(f"Edge references unknown nodes: {source!r} -> {target!r}.")
            continue
        incoming[target].append(edge)
        outgoing[source].append(target)
        indegree[target] += 1
        if _node_type(node_map[source]) == "condition":
            branch = _edge_branch(edge)
            if branch not in {"true", "false", "always"}:
                errors.append(
                    f"Condition edge {source!r} -> {target!r} has unsupported branch {branch!r}."
                )

    if strict:
        for node_id, node in node_map.items():
            node_type = _node_type(node)
            required = list(REQUIRED_PORTS.get(node_type, []))
            config = _node_config(node)
            if node_type == "batch_prediction" and config.get("dataset_version_id"):
                required = ["model"]
            connected_ports = {
                str(edge.get("targetHandle", edge.get("target_port", "")))
                for edge in incoming[node_id]
                if edge.get("targetHandle", edge.get("target_port"))
            }
            if connected_ports:
                missing = [port for port in required if port not in connected_ports]
            else:
                missing = required[len(incoming[node_id]) :]
            if missing:
                errors.append(
                    f"Node '{node_id}' is missing required input ports: {missing}."
                )
            if node_type == "dataset_load" and not (
                config.get("dataset_version_id") or config.get("dataset_id")
            ):
                errors.append(
                    f"Node '{node_id}' requires dataset_version_id or dataset_id configuration."
                )
            errors.extend(_validate_strict_node_config(node_id, node_type, config))

    queue = sorted(node_id for node_id, degree in indegree.items() if degree == 0)
    order: list[str] = []
    while queue:
        node_id = queue.pop(0)
        order.append(node_id)
        for target in outgoing[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
                queue.sort()
    if len(order) != len(node_map):
        errors.append("Graph contains a cycle.")
    return {"valid": not errors, "errors": errors, "order": order}


def _find(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        if key in value:
            return value[key]
        for nested in value.values():
            found = _find(nested, key)
            if found is not None:
                return found
    if isinstance(value, list):
        for nested in value:
            found = _find(nested, key)
            if found is not None:
                return found
    return None


def _json_safe(value: Any) -> Any:
    if isinstance(value, pd.DataFrame):
        return {"kind": "dataframe", "rows": len(value), "columns": list(map(str, value.columns))}
    if isinstance(value, pd.Series):
        return {"kind": "series", "rows": len(value), "name": str(value.name)}
    if isinstance(value, ModelVersion):
        return {
            "model_version_id": value.id,
            "name": value.name,
            "version": value.version,
            "lifecycle": value.lifecycle.value,
        }
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _input_for(
    node_id: str,
    edges: list[dict[str, Any]],
    outputs: dict[str, Any],
) -> Any:
    values: dict[str, Any] = {}
    unlabelled: list[Any] = []
    for edge in edges:
        if str(edge.get("target")) != node_id:
            continue
        output = outputs.get(str(edge.get("source")))
        port = edge.get("targetHandle", edge.get("target_port"))
        if port:
            values[str(port)] = output
        else:
            unlabelled.append(output)
    if values:
        values["_inputs"] = unlabelled
        return values
    if len(unlabelled) == 1:
        return unlabelled[0]
    return unlabelled


def _load_dataset(db: Session, config: dict[str, Any]) -> dict[str, Any]:
    if config.get("dataset_version_id") is not None:
        version = db.get(DatasetVersion, int(config["dataset_version_id"]))
        if version is None:
            raise ValueError(f"Dataset version {config['dataset_version_id']} was not found.")
        frame = dataset_service.load_dataset_version_dataframe(version)
        return {
            "dataframe": frame,
            "dataset_version_id": version.id,
            "dataset_id": version.dataset_id,
        }
    dataset = db.get(Dataset, int(config["dataset_id"]))
    if dataset is None:
        raise ValueError(f"Dataset {config['dataset_id']} was not found.")
    raw = storage.download_bytes(settings.minio_datasets_bucket, dataset.object_key)
    return {
        "dataframe": dataset_service.dataframe_from_bytes(raw, filename=dataset.name),
        "dataset_version_id": None,
        "dataset_id": dataset.id,
    }


def _execute_node(
    db: Session,
    run: PipelineRun,
    node_type: str,
    config: dict[str, Any],
    incoming: Any,
) -> Any:
    frame = _find(incoming, "dataframe")
    if node_type == "dataset_load":
        return _load_dataset(db, config)

    if node_type == "quality_check":
        if frame is None:
            raise ValueError("quality_check requires a dataframe input.")
        rules = config.get("rules", [])
        rule_id = config.get("quality_rule_id")
        rule_row = db.get(QualityRule, int(rule_id)) if rule_id else None
        if rule_id and rule_row is None:
            raise ValueError(f"Quality rule {rule_id} was not found.")
        if rule_row:
            if rule_row.project_id != run.project_id:
                raise ValueError(
                    f"Quality rule {rule_row.id} does not belong to this project."
                )
            if not rule_row.is_active:
                raise ValueError(f"Quality rule {rule_row.id} is inactive.")
            incoming_dataset_id = _find(incoming, "dataset_id")
            if (
                rule_row.dataset_id is not None
                and incoming_dataset_id is not None
                and int(rule_row.dataset_id) != int(incoming_dataset_id)
            ):
                raise ValueError(
                    f"Quality rule {rule_row.id} belongs to a different dataset."
                )
            rules = json.loads(rule_row.rules_json or "[]")
        result = quality.run_quality_rules(frame, rules)
        version_id = _find(incoming, "dataset_version_id")
        if version_id:
            db.add(
                QualityCheck(
                    project_id=run.project_id,
                    dataset_version_id=version_id,
                    quality_rule_id=rule_row.id if rule_row else None,
                    result=QualityResult(result["result"]),
                    details_json=json.dumps(result["details"], default=str),
                    created_by=run.created_by,
                )
            )
        block = config.get(
            "block_on_fail",
            rule_row.block_training_on_fail if rule_row else True,
        )
        if result["result"] == QualityResult.FAIL.value and block:
            raise ValueError("Dataset quality checks failed.")
        return {**(incoming if isinstance(incoming, dict) else {}), "quality": result}

    if node_type == "split":
        if frame is None:
            raise ValueError("split requires a dataframe input.")
        train_ratio = float(config.get("train_ratio", 0.7))
        val_ratio = float(config.get("val_ratio", 0.15))
        test_ratio = float(config.get("test_ratio", 0.15))
        if not abs(train_ratio + val_ratio + test_ratio - 1.0) < 1e-9:
            raise ValueError("Split ratios must sum to 1.")
        seed = int(config.get("random_seed", 42))
        shuffled = frame.sample(frac=1, random_state=seed)
        train_end = int(len(frame) * train_ratio)
        val_end = train_end + int(len(frame) * val_ratio)
        splits = {
            "train": shuffled.iloc[:train_end].copy(),
            "val": shuffled.iloc[train_end:val_end].copy(),
            "test": shuffled.iloc[val_end:].copy(),
        }
        # In-memory only: do not create DatasetSplit rows (no Saved Split artifacts).
        return {
            **(incoming if isinstance(incoming, dict) else {}),
            "dataframe": frame,
            "splits": splits,
            "split_id": None,
            "split_config": {
                "train_ratio": train_ratio,
                "val_ratio": val_ratio,
                "test_ratio": test_ratio,
                "random_seed": seed,
            },
        }

    if node_type == "preprocessing":
        if frame is None:
            raise ValueError("preprocessing requires a dataframe input.")
        return {
            **(incoming if isinstance(incoming, dict) else {}),
            "dataframe": frame,
            "preprocessing": config,
        }

    if node_type == "training":
        if frame is None:
            raise ValueError("training requires a dataframe input.")
        dataset_id = _find(incoming, "dataset_id")
        if not dataset_id:
            raise ValueError("training input is missing dataset lineage.")
        split_config = _find(incoming, "split_config") or {}
        preprocessing = _find(incoming, "preprocessing") or config.get("preprocessing", {})
        job = TrainingJob(
            project_id=run.project_id,
            dataset_id=dataset_id,
            dataset_version_id=_find(incoming, "dataset_version_id"),
            split_id=_find(incoming, "split_id"),
            name=str(config.get("name", f"pipeline-{run.id}-training")),
            target_column=str(config.get("target_column", "")),
            problem_type=str(config.get("problem_type", "auto")),
            algorithm=str(config.get("algorithm", "random_forest")),
            hyperparameters_json=json.dumps(config.get("hyperparameters", {})),
            preprocessing_json=json.dumps(preprocessing),
            feature_columns_json=json.dumps(config.get("feature_columns", [])),
            random_seed=int(config.get("random_seed", split_config.get("random_seed", 42))),
            train_ratio=float(config.get("train_ratio", split_config.get("train_ratio", 0.7))),
            val_ratio=float(config.get("val_ratio", split_config.get("val_ratio", 0.15))),
            test_ratio=float(config.get("test_ratio", split_config.get("test_ratio", 0.15))),
            status=JobStatus.running,
            started_at=datetime.now(timezone.utc),
            created_by=run.created_by,
        )
        if not job.target_column:
            raise ValueError("training requires target_column configuration.")
        db.add(job)
        db.flush()
        result = get_training_runner().run(
            TrainingJobContext(
                job_id=job.id,
                project_id=run.project_id,
                job_name=job.name,
                target_column=job.target_column,
                algorithm=job.algorithm,
                hyperparameters=json.loads(job.hyperparameters_json),
                csv_bytes=frame.to_csv(index=False).encode(),
                experiment_name=f"project-{run.project_id}",
                problem_type=job.problem_type,
                preprocessing=preprocessing,
                feature_columns=json.loads(job.feature_columns_json),
                train_ratio=job.train_ratio,
                val_ratio=job.val_ratio,
                test_ratio=job.test_ratio,
                random_seed=job.random_seed,
            )
        )
        job.status = JobStatus.succeeded
        job.mlflow_run_id = result.mlflow_run_id
        job.model_uri = result.model_uri
        job.metrics_json = json.dumps(result.metrics)
        job.logs = result.logs
        job.finished_at = datetime.now(timezone.utc)
        return {
            **(incoming if isinstance(incoming, dict) else {}),
            "training_job_id": job.id,
            "mlflow_run_id": result.mlflow_run_id,
            "model_uri": result.model_uri,
            "metrics": result.metrics,
        }

    if node_type == "evaluation":
        metrics = _find(incoming, "metrics") or {}
        metric = config.get("metric")
        minimum = config.get("minimum", config.get("min"))
        passed = True
        if metric and minimum is not None:
            passed = metric in metrics and float(metrics[metric]) >= float(minimum)
        if not passed and config.get("fail_on_gate", True):
            raise ValueError(f"Evaluation gate failed for metric '{metric}'.")
        return {**(incoming if isinstance(incoming, dict) else {}), "evaluation_passed": passed}

    if node_type == "condition":
        metrics = _find(incoming, "metrics") or {}
        left = metrics.get(config.get("metric")) if config.get("metric") else config.get("left")
        right = config.get("value", config.get("right"))
        operators = {
            ">": operator.gt,
            ">=": operator.ge,
            "<": operator.lt,
            "<=": operator.le,
            "==": operator.eq,
            "!=": operator.ne,
        }
        operation = str(config.get("operator", ">="))
        if operation not in CONDITION_OPERATORS:
            raise ValueError(f"Unsupported condition operator '{operation}'.")
        passed = bool(operators[operation](left, right))
        if not passed and config.get("fail_on_false", False):
            raise ValueError("Pipeline condition evaluated to false.")
        return {
            **(incoming if isinstance(incoming, dict) else {}),
            "condition": passed,
            "branch": "true" if passed else "false",
        }

    if node_type == "model_registration":
        from app.services.registry_service import register_from_run

        run_id = _find(incoming, "mlflow_run_id")
        if not run_id:
            raise ValueError("model_registration requires an MLflow run id.")
        model = register_from_run(
            db,
            project_id=run.project_id,
            run_id=run_id,
            model_name=str(config.get("model_name", "pipeline-model")),
            training_job_id=_find(incoming, "training_job_id"),
            dataset_version_id=_find(incoming, "dataset_version_id"),
            pipeline_run_id=run.id,
            created_by=run.created_by,
        )
        return {**(incoming if isinstance(incoming, dict) else {}), "model_version": model}

    if node_type == "approval_request":
        from app.services.gate_policy import (
            FORBIDDEN_PIPELINE_GATE_KEYS,
            get_gate_policy_for_project,
        )
        from app.services.registry_service import request_approval, run_gates

        banned = sorted(FORBIDDEN_PIPELINE_GATE_KEYS.intersection(config))
        if banned:
            raise ValueError(
                "approval_request must not set gate criteria fields: "
                + ", ".join(banned)
            )
        model = _find(incoming, "model_version")
        if not isinstance(model, ModelVersion):
            raise ValueError("approval_request requires a registered model.")
        policy_id = config.get("gate_policy_id")
        if policy_id is not None:
            get_gate_policy_for_project(db, run.project_id, int(policy_id))
        if not model.gates_passed:
            run_gates(
                db,
                model,
                actor_id=run.created_by,
                gate_policy_id=int(policy_id) if policy_id is not None else None,
            )
        request_approval(db, model, actor_id=run.created_by)
        return incoming

    if node_type == "endpoint_deployment":
        model = _find(incoming, "model_version")
        if not isinstance(model, ModelVersion):
            raise ValueError("endpoint_deployment requires a registered model.")
        if model.lifecycle not in {ModelLifecycle.APPROVED, ModelLifecycle.PRODUCTION}:
            raise ValueError("Model must be approved before endpoint deployment.")
        inference.load_model(model.model_uri)
        endpoint = Endpoint(
            project_id=run.project_id,
            name=str(config.get("name", f"{model.name}-endpoint")),
            model_name=model.mlflow_model_name,
            model_version=model.mlflow_version,
            model_version_id=model.id,
            model_uri=model.model_uri,
            status="ready",
            feature_schema_json=json.dumps(_json_safe(_find(incoming, "feature_schema") or [])),
            created_by=run.created_by,
        )
        db.add(endpoint)
        db.flush()
        return {**(incoming if isinstance(incoming, dict) else {}), "endpoint_id": endpoint.id}

    if node_type == "batch_prediction":
        model = _find(incoming, "model_version")
        model_uri = model.model_uri if isinstance(model, ModelVersion) else _find(incoming, "model_uri")
        if not model_uri:
            raise ValueError("batch_prediction requires a model.")
        if frame is None and config.get("dataset_version_id"):
            loaded = _load_dataset(db, config)
            frame = loaded["dataframe"]
            version_id = loaded["dataset_version_id"]
        else:
            version_id = _find(incoming, "dataset_version_id")
        if frame is None or not version_id:
            raise ValueError("batch_prediction requires versioned dataset input.")
        target_column = config.get("target_column")
        features = frame.drop(columns=[target_column]) if target_column in frame.columns else frame
        predictions = inference.load_model(model_uri).predict(features)
        result_frame = frame.copy()
        result_frame[str(config.get("prediction_column", "prediction"))] = predictions
        data = result_frame.to_csv(index=False).encode()
        key = f"project-{run.project_id}/pipeline-{run.id}/{uuid.uuid4().hex}.csv"
        storage.upload_bytes(settings.minio_batch_bucket, key, data, "text/csv")
        batch = BatchInferenceJob(
            project_id=run.project_id,
            dataset_version_id=version_id,
            model_version_id=model.id if isinstance(model, ModelVersion) else None,
            status=JobStatus.succeeded,
            result_object_key=key,
            row_count=len(result_frame),
            created_by=run.created_by,
            finished_at=datetime.now(timezone.utc),
        )
        db.add(batch)
        db.flush()
        return {**(incoming if isinstance(incoming, dict) else {}), "batch_job_id": batch.id}

    if node_type == "notification":
        alert = create_alert(
            db,
            project_id=run.project_id,
            alert_type=str(config.get("alert_type", "pipeline")),
            severity=str(config.get("severity", "info")),
            title=str(config.get("title", f"Pipeline run {run.id} notification")),
            message=str(config.get("message", "")),
            resource_type="pipeline_run",
            resource_id=run.id,
        )
        return {**(incoming if isinstance(incoming, dict) else {}), "alert_id": alert.id}

    raise ValueError(f"Unsupported pipeline node type: {node_type}")


_ARTIFACT_MARKER = "__modelflow_artifact__"
_TERMINAL_NODE_STATES = {"succeeded", "failed", "skipped", "cancelled"}


def _persist_output(run: PipelineRun, node_id: str, value: Any) -> Any:
    if isinstance(value, pd.DataFrame):
        buffer = BytesIO()
        value.to_parquet(buffer, index=False)
        key = (
            f"project-{run.project_id}/pipeline-runs/{run.id}/"
            f"{node_id}/{uuid.uuid4().hex}.parquet"
        )
        storage.upload_bytes(
            settings.minio_artifacts_bucket,
            key,
            buffer.getvalue(),
            "application/vnd.apache.parquet",
        )
        return {
            _ARTIFACT_MARKER: "dataframe",
            "bucket": settings.minio_artifacts_bucket,
            "key": key,
        }
    if isinstance(value, pd.Series):
        buffer = BytesIO()
        value.to_frame().to_parquet(buffer, index=False)
        key = (
            f"project-{run.project_id}/pipeline-runs/{run.id}/"
            f"{node_id}/{uuid.uuid4().hex}.series.parquet"
        )
        storage.upload_bytes(
            settings.minio_artifacts_bucket,
            key,
            buffer.getvalue(),
            "application/vnd.apache.parquet",
        )
        return {
            _ARTIFACT_MARKER: "series",
            "bucket": settings.minio_artifacts_bucket,
            "key": key,
            "name": value.name,
        }
    if isinstance(value, ModelVersion):
        return {_ARTIFACT_MARKER: "model_version", "id": value.id}
    if isinstance(value, dict):
        return {
            str(key): _persist_output(run, node_id, item) for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_persist_output(run, node_id, item) for item in value]
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _restore_output(db: Session, value: Any) -> Any:
    if isinstance(value, list):
        return [_restore_output(db, item) for item in value]
    if not isinstance(value, dict):
        return value
    kind = value.get(_ARTIFACT_MARKER)
    if kind in {"dataframe", "series"}:
        payload = storage.download_bytes(str(value["bucket"]), str(value["key"]))
        frame = pd.read_parquet(BytesIO(payload))
        if kind == "series":
            series = frame.iloc[:, 0]
            series.name = value.get("name")
            return series
        return frame
    if kind == "model_version":
        model = db.get(ModelVersion, int(value["id"]))
        if model is None:
            raise ValueError(f"Model version artifact {value['id']} was not found.")
        return model
    return {str(key): _restore_output(db, item) for key, item in value.items()}


def _bind_models(db: Session, value: Any) -> Any:
    if isinstance(value, ModelVersion):
        model = db.get(ModelVersion, value.id)
        if model is None:
            raise ValueError(f"Model version {value.id} was not found.")
        return model
    if isinstance(value, dict):
        return {key: _bind_models(db, item) for key, item in value.items()}
    if isinstance(value, list):
        return [_bind_models(db, item) for item in value]
    return value


def _condition_branch(value: Any) -> str | None:
    if isinstance(value, dict):
        branch = value.get("branch")
        if isinstance(branch, bool):
            return str(branch).lower()
        if str(branch).lower() in {"true", "false"}:
            return str(branch).lower()
        condition = value.get("condition")
        if isinstance(condition, bool):
            return str(condition).lower()
    return None


@dataclass
class _NodeResult:
    output: Any = None
    artifact: Any = None
    summary: Any = None
    error: str | None = None


def _run_node(
    session_factory: sessionmaker,
    run_id: int,
    node_id: str,
    node_type: str,
    config: dict[str, Any],
    incoming: Any,
) -> _NodeResult:
    with session_factory() as node_db:
        live_run = node_db.get(PipelineRun, run_id)
        if live_run is None:
            return _NodeResult(error=f"Pipeline run {run_id} was not found.")
        try:
            bound_input = _bind_models(node_db, incoming)
            output = _execute_node(node_db, live_run, node_type, config, bound_input)
            artifact = _persist_output(live_run, node_id, output)
            summary = _json_safe(output)
            node_db.commit()
            return _NodeResult(output=output, artifact=artifact, summary=summary)
        except Exception as exc:
            node_db.rollback()
            return _NodeResult(error=str(exc))


def prepare_rerun_from_failed(run: PipelineRun, graph: dict[str, Any]) -> list[str]:
    """Reset failed nodes and their descendants while retaining successful artifacts."""

    states = json.loads(run.node_states_json or "{}")
    failed = {
        node_id for node_id, state in states.items() if state.get("status") == "failed"
    }
    if not failed:
        return []
    nodes = {str(node.get("id")): node for node in graph.get("nodes", [])}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    for edge in graph.get("edges", []):
        source, target = str(edge.get("source")), str(edge.get("target"))
        if source in outgoing:
            outgoing[source].append(target)

    restart = set(failed)
    queue = list(failed)
    while queue:
        source = queue.pop()
        for target in outgoing.get(source, []):
            if target not in restart:
                restart.add(target)
                queue.append(target)

    artifacts = json.loads(run.node_artifacts_json or "{}")
    for node_id in restart:
        existing = dict(states.get(node_id) or {})
        graph_node = nodes.get(node_id) or {"id": node_id, "data": {}}
        previous_attempt = existing.get("attempt")
        try:
            attempt = int(previous_attempt) + 1 if previous_attempt is not None else 2
        except (TypeError, ValueError):
            attempt = 2
        states[node_id] = {
            "status": "pending",
            "label": existing.get("label") or _node_label(graph_node),
            "node_type": existing.get("node_type") or _node_type(graph_node) or "unknown",
            "attempt": attempt,
        }
        artifacts.pop(node_id, None)
    run.node_states_json = json.dumps(states)
    run.node_artifacts_json = json.dumps(artifacts)
    run.status = JobStatus.pending
    run.error_message = None
    run.scheduled_for = None
    run.started_at = None
    run.finished_at = None
    restarted = sorted(restart)
    run.logs = (run.logs or "") + (
        "Rerun from failed requested.\n"
        f"Restarting steps: {', '.join(restarted)}.\n"
    )
    return restarted


def execute_pipeline_run(db: Session, run_id: int) -> PipelineRun:
    """Execute ready graph nodes concurrently with branch and cancellation semantics."""

    run = db.get(PipelineRun, run_id)
    if run is None:
        raise ValueError(f"Pipeline run {run_id} was not found.")
    version = db.get(PipelineVersion, run.pipeline_version_id)
    if version is None:
        raise ValueError(f"Pipeline version {run.pipeline_version_id} was not found.")
    graph = json.loads(version.graph_json or "{}")
    validation = validate_graph(graph)
    states = json.loads(run.node_states_json or "{}")
    if not validation["valid"]:
        for state in states.values():
            if state.get("status") == "pending":
                state.update(
                    status="skipped", reason="Pipeline graph validation failed."
                )
        run.node_states_json = json.dumps(states)
        run.status = JobStatus.failed
        run.error_message = "; ".join(validation["errors"])
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        return run

    nodes = {str(node["id"]): node for node in graph["nodes"]}
    edges = graph.get("edges", [])
    incoming_edges: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in nodes}
    for edge in edges:
        incoming_edges[str(edge["target"])].append(edge)
    parameters = json.loads(run.parameters_json or "{}")
    artifacts = json.loads(run.node_artifacts_json or "{}")
    outputs: dict[str, Any] = {}
    for node_id, node in nodes.items():
        states.setdefault(node_id, {"status": "pending"})
        if states[node_id].get("status") == "succeeded":
            saved = artifacts.get(node_id, states[node_id].get("output"))
            outputs[node_id] = _restore_output(db, saved)

    if run.status == JobStatus.cancel_requested:
        for state in states.values():
            if state.get("status") == "pending":
                state.update(status="cancelled", reason="Pipeline run was cancelled.")
        run.node_states_json = json.dumps(states)
        run.status = JobStatus.cancelled
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        return run

    had_failure = any(state.get("status") == "failed" for state in states.values())
    fail_fast = had_failure and run.fail_policy != "continue"
    cancel_requested = False
    run.status = JobStatus.running
    run.started_at = run.started_at or datetime.now(timezone.utc)
    run.finished_at = None
    db.commit()

    node_sessions = sessionmaker(
        bind=db.get_bind(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )
    max_workers = max(1, int(settings.pipeline_max_parallel_nodes))
    futures: dict[Future[_NodeResult], str] = {}

    def persist_runtime_state() -> None:
        run.node_states_json = json.dumps(states, default=str)
        run.node_artifacts_json = json.dumps(artifacts, default=str)
        db.commit()

    def edge_is_active(edge: dict[str, Any]) -> bool:
        source = str(edge["source"])
        source_status = states[source].get("status")
        if source_status in {"skipped", "cancelled"}:
            return False
        if source_status != "succeeded" or _node_type(nodes[source]) != "condition":
            return True
        selected = states[source].get("branch") or _condition_branch(
            outputs.get(source)
        )
        return _edge_branch(edge) in {"always", selected}

    with ThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix=f"pipeline-{run_id}",
    ) as executor:
        while True:
            db.expire(run, ["status"])
            db.refresh(run, attribute_names=["status"])
            cancel_requested = (
                cancel_requested or run.status == JobStatus.cancel_requested
            )

            pending_ids = [
                node_id
                for node_id, state in states.items()
                if state.get("status") == "pending"
            ]
            if cancel_requested and not futures:
                for node_id in pending_ids:
                    states[node_id].update(
                        status="cancelled",
                        reason="Pipeline run was cancelled before this node started.",
                    )
                persist_runtime_state()
                break
            if fail_fast and not futures:
                for node_id in pending_ids:
                    states[node_id].update(
                        status="skipped",
                        reason="Skipped after a pipeline node failed.",
                    )
                persist_runtime_state()
                break

            ready: list[tuple[str, list[dict[str, Any]]]] = []
            skipped_any = False
            if not cancel_requested and not fail_fast:
                for node_id in sorted(pending_ids):
                    node_incoming = incoming_edges[node_id]
                    if any(
                        states[str(edge["source"])].get("status")
                        not in _TERMINAL_NODE_STATES
                        for edge in node_incoming
                    ):
                        continue
                    active = [edge for edge in node_incoming if edge_is_active(edge)]
                    if node_incoming and not active:
                        states[node_id].update(
                            status="skipped",
                            reason="No selected branch reaches this node.",
                        )
                        skipped_any = True
                        continue
                    if any(
                        states[str(edge["source"])].get("status")
                        in {"failed", "cancelled"}
                        for edge in active
                    ):
                        states[node_id].update(
                            status="skipped",
                            reason="An upstream dependency did not succeed.",
                        )
                        skipped_any = True
                        continue
                    if all(
                        states[str(edge["source"])].get("status") == "succeeded"
                        for edge in active
                    ):
                        ready.append((node_id, active))

            available = max_workers - len(futures)
            to_start = ready[:available]
            if to_start:
                started_at = datetime.now(timezone.utc).isoformat()
                for node_id, _ in to_start:
                    current = states.setdefault(node_id, {})
                    current.update(
                        {
                            "status": "running",
                            "node_type": current.get("node_type")
                            or _node_type(nodes[node_id]),
                            "label": current.get("label") or _node_label(nodes[node_id]),
                            "attempt": current.get("attempt") or 1,
                            "started_at": started_at,
                        }
                    )
                    current.pop("error", None)
                    current.pop("reason", None)
                    current.pop("finished_at", None)
                    current.pop("output", None)
                persist_runtime_state()
                for node_id, active in to_start:
                    node_type = _node_type(nodes[node_id])
                    config = {**parameters, **_node_config(nodes[node_id])}
                    incoming = _input_for(node_id, active, outputs)
                    future = executor.submit(
                        _run_node,
                        node_sessions,
                        run_id,
                        node_id,
                        node_type,
                        config,
                        incoming,
                    )
                    futures[future] = node_id

            if not futures:
                if skipped_any:
                    persist_runtime_state()
                    continue
                remaining = [
                    node_id
                    for node_id, state in states.items()
                    if state.get("status") == "pending"
                ]
                if remaining:
                    for node_id in remaining:
                        states[node_id].update(
                            status="skipped",
                            reason="No executable dependency path reaches this node.",
                        )
                    persist_runtime_state()
                break

            done, _ = wait(tuple(futures), timeout=0.2, return_when=FIRST_COMPLETED)
            if not done:
                continue
            finished_at = datetime.now(timezone.utc).isoformat()
            for future in done:
                node_id = futures.pop(future)
                node_type = _node_type(nodes[node_id])
                try:
                    result = future.result()
                except Exception as exc:
                    result = _NodeResult(error=str(exc))
                if result.error is None:
                    outputs[node_id] = result.output
                    artifacts[node_id] = result.artifact
                    states[node_id].update(
                        status="succeeded",
                        finished_at=finished_at,
                        output=result.summary,
                    )
                    branch = _condition_branch(result.output)
                    if node_type == "condition" and branch:
                        states[node_id]["branch"] = branch
                    run.logs = (
                        run.logs or ""
                    ) + f"{node_id} ({node_type}) succeeded.\n"
                else:
                    states[node_id].update(
                        status="failed",
                        finished_at=finished_at,
                        error=result.error,
                    )
                    run.logs = (
                        run.logs or ""
                    ) + f"{node_id} ({node_type}) failed: {result.error}\n"
                    run.error_message = result.error
                    had_failure = True
                    if run.fail_policy != "continue":
                        fail_fast = True
            persist_runtime_state()

    run.status = (
        JobStatus.cancelled
        if cancel_requested
        else JobStatus.failed
        if had_failure
        else JobStatus.succeeded
    )
    run.finished_at = datetime.now(timezone.utc)
    if run.status == JobStatus.succeeded:
        run.error_message = None
    db.commit()
    return run
