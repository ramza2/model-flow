from __future__ import annotations

import mlflow
from mlflow.tracking import MlflowClient

from app.core.config import settings


def client() -> MlflowClient:
    mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
    return MlflowClient(tracking_uri=settings.mlflow_tracking_uri)


def ensure_experiment(name: str) -> str:
    c = client()
    exp = c.get_experiment_by_name(name)
    if exp is None:
        return c.create_experiment(name)
    return exp.experiment_id


def list_runs(experiment_name: str, max_results: int = 100) -> list[dict]:
    c = client()
    exp = c.get_experiment_by_name(experiment_name)
    if exp is None:
        return []
    runs = c.search_runs([exp.experiment_id], order_by=["attributes.start_time DESC"], max_results=max_results)
    out = []
    for r in runs:
        out.append(
            {
                "run_id": r.info.run_id,
                "experiment_id": r.info.experiment_id,
                "status": r.info.status,
                "start_time": r.info.start_time,
                "end_time": r.info.end_time,
                "params": dict(r.data.params),
                "metrics": {k: float(v) for k, v in r.data.metrics.items()},
                "artifact_uri": r.info.artifact_uri,
                "tags": dict(r.data.tags),
            }
        )
    return out


def get_run(run_id: str) -> dict:
    c = client()
    r = c.get_run(run_id)
    artifacts = []
    try:
        for a in c.list_artifacts(run_id):
            artifacts.append({"path": a.path, "is_dir": a.is_dir, "file_size": a.file_size})
    except Exception:
        artifacts = []
    return {
        "run_id": r.info.run_id,
        "experiment_id": r.info.experiment_id,
        "status": r.info.status,
        "start_time": r.info.start_time,
        "end_time": r.info.end_time,
        "params": dict(r.data.params),
        "metrics": {k: float(v) for k, v in r.data.metrics.items()},
        "artifact_uri": r.info.artifact_uri,
        "tags": dict(r.data.tags),
        "artifacts": artifacts,
    }


def artifact_exists(
    run_id: str, artifact_path: str, artifacts: list[dict] | None = None
) -> bool:
    """Return whether a run or its MLflow 3 logged model owns the artifact."""

    normalized = artifact_path.strip().strip("/")
    if not normalized:
        return False
    if any(str(item.get("path", "")).strip("/") == normalized for item in artifacts or []):
        return True
    parent = normalized.rsplit("/", 1)[0] if "/" in normalized else None
    c = client()
    try:
        listed = c.list_artifacts(run_id, parent)
    except Exception:
        listed = []
    if any(str(item.path).strip("/") == normalized for item in listed):
        return True

    # MLflow 3 stores model artifacts under first-class LoggedModels rather
    # than the run artifact tree. Keep the run ownership check by requiring
    # both the source run and logged-model name to match.
    try:
        experiment_id = c.get_run(run_id).info.experiment_id
        logged_models = c.search_logged_models(
            experiment_ids=[str(experiment_id)],
            max_results=1000,
        )
    except (AttributeError, TypeError, ValueError):
        return False
    except Exception:
        return False
    return any(
        str(getattr(model, "source_run_id", "")) == run_id
        and str(getattr(model, "name", "")).strip("/") == normalized
        and str(getattr(model, "status", "READY")).upper().endswith("READY")
        for model in logged_models
    )


def register_model(run_id: str, model_name: str, artifact_path: str = "model") -> dict:
    mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
    model_uri = f"runs:/{run_id}/{artifact_path}"
    result = mlflow.register_model(model_uri, model_name)
    return {
        "name": result.name,
        "version": str(result.version),
        "status": result.status,
        "run_id": result.run_id,
        "source": result.source,
        "creation_timestamp": result.creation_timestamp,
    }


def list_registered_models(prefix: str | None = None) -> list[dict]:
    c = client()
    models = c.search_registered_models(max_results=100)
    out = []
    for m in models:
        if prefix and not m.name.startswith(prefix):
            continue
        versions = []
        for v in m.latest_versions or []:
            versions.append(
                {
                    "name": v.name,
                    "version": str(v.version),
                    "status": v.status,
                    "run_id": v.run_id,
                    "source": v.source,
                    "creation_timestamp": v.creation_timestamp,
                }
            )
        out.append({"name": m.name, "latest_versions": versions})
    return out


def get_model_version(name: str, version: str) -> dict:
    c = client()
    v = c.get_model_version(name, version)
    return {
        "name": v.name,
        "version": str(v.version),
        "status": v.status,
        "run_id": v.run_id,
        "source": v.source,
        "creation_timestamp": v.creation_timestamp,
    }
