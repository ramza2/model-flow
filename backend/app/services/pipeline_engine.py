from __future__ import annotations

import json
import operator
import uuid
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import (
    BatchInferenceJob,
    Dataset,
    DatasetSplit,
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


def validate_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """Validate node types, references, required input ports, and acyclicity."""

    errors: list[str] = []
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list) or not nodes:
        return {"valid": False, "errors": ["Graph must contain at least one node."], "order": []}
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
        if node_type not in NODE_TYPES:
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
            errors.append(f"Node '{node_id}' is missing required input ports: {missing}.")
        if node_type == "dataset_load" and not (
            config.get("dataset_version_id") or config.get("dataset_id")
        ):
            errors.append(
                f"Node '{node_id}' requires dataset_version_id or dataset_id configuration."
            )

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
        if rule_row:
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
        shuffled = frame.sample(frac=1, random_state=int(config.get("random_seed", 42)))
        train_end = int(len(frame) * train_ratio)
        val_end = train_end + int(len(frame) * val_ratio)
        splits = {
            "train": shuffled.iloc[:train_end].copy(),
            "val": shuffled.iloc[train_end:val_end].copy(),
            "test": shuffled.iloc[val_end:].copy(),
        }
        version_id = _find(incoming, "dataset_version_id")
        split_row = None
        if version_id:
            split_row = DatasetSplit(
                project_id=run.project_id,
                dataset_version_id=version_id,
                name=str(config.get("name", "pipeline")),
                train_ratio=train_ratio,
                val_ratio=val_ratio,
                test_ratio=test_ratio,
                random_seed=int(config.get("random_seed", 42)),
            )
            db.add(split_row)
            db.flush()
        return {
            **(incoming if isinstance(incoming, dict) else {}),
            "dataframe": frame,
            "splits": splits,
            "split_id": split_row.id if split_row else None,
            "split_config": {
                "train_ratio": train_ratio,
                "val_ratio": val_ratio,
                "test_ratio": test_ratio,
                "random_seed": int(config.get("random_seed", 42)),
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
        if operation not in operators:
            raise ValueError(f"Unsupported condition operator '{operation}'.")
        passed = bool(operators[operation](left, right))
        if not passed and config.get("fail_on_false", False):
            raise ValueError("Pipeline condition evaluated to false.")
        return {**(incoming if isinstance(incoming, dict) else {}), "condition": passed}

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
        from app.services.registry_service import request_approval, run_gates

        model = _find(incoming, "model_version")
        if not isinstance(model, ModelVersion):
            raise ValueError("approval_request requires a registered model.")
        if not model.gates_passed:
            run_gates(
                db,
                model,
                config.get("gates"),
                test_instance=config.get("test_instance"),
                actor_id=run.created_by,
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


def execute_pipeline_run(db: Session, run_id: int) -> PipelineRun:
    """Execute a stored graph sequentially in topological order."""

    run = db.get(PipelineRun, run_id)
    if run is None:
        raise ValueError(f"Pipeline run {run_id} was not found.")
    version = db.get(PipelineVersion, run.pipeline_version_id)
    if version is None:
        raise ValueError(f"Pipeline version {run.pipeline_version_id} was not found.")
    graph = json.loads(version.graph_json or "{}")
    validation = validate_graph(graph)
    if not validation["valid"]:
        run.status = JobStatus.failed
        run.error_message = "; ".join(validation["errors"])
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        return run

    nodes = {str(node["id"]): node for node in graph["nodes"]}
    edges = graph.get("edges", [])
    parameters = json.loads(run.parameters_json or "{}")
    states = json.loads(run.node_states_json or "{}")
    outputs: dict[str, Any] = {}
    had_failure = False
    run.status = JobStatus.running
    run.started_at = datetime.now(timezone.utc)
    db.commit()

    for node_id in validation["order"]:
        db.refresh(run)
        if run.status == JobStatus.cancel_requested:
            run.status = JobStatus.cancelled
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            return run
        node = nodes[node_id]
        node_type = _node_type(node)
        config = {**parameters, **_node_config(node)}
        states[node_id] = {
            "status": "running",
            "node_type": node_type,
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        run.node_states_json = json.dumps(states)
        db.commit()
        try:
            incoming = _input_for(node_id, edges, outputs)
            output = _execute_node(db, run, node_type, config, incoming)
            outputs[node_id] = output
            states[node_id].update(
                {
                    "status": "succeeded",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "output": _json_safe(output),
                }
            )
            run.node_states_json = json.dumps(states, default=str)
            run.logs = (run.logs or "") + f"{node_id} ({node_type}) succeeded.\n"
            db.commit()
        except Exception as exc:
            db.rollback()
            run = db.get(PipelineRun, run_id)
            states[node_id].update(
                {
                    "status": "failed",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "error": str(exc),
                }
            )
            run.node_states_json = json.dumps(states)
            run.logs = (run.logs or "") + f"{node_id} ({node_type}) failed: {exc}\n"
            run.error_message = str(exc)
            had_failure = True
            if run.fail_policy != "continue":
                run.status = JobStatus.failed
                run.finished_at = datetime.now(timezone.utc)
                db.commit()
                return run
            db.commit()

    run.status = JobStatus.failed if had_failure else JobStatus.succeeded
    run.finished_at = datetime.now(timezone.utc)
    db.commit()
    return run
