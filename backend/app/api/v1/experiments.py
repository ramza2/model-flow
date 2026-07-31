from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.v1.common import friendly
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.services import mlflow_service

router = APIRouter(tags=["experiments"])


def _project_run(project_id: int, run_id: str) -> dict:
    try:
        run = mlflow_service.get_run(run_id)
        experiment_id = mlflow_service.ensure_experiment(f"project-{project_id}")
    except Exception as exc:
        raise friendly(404, f"Run '{run_id}' was not found.") from exc
    if str(run.get("experiment_id")) != str(experiment_id):
        raise friendly(404, f"Run '{run_id}' was not found in this project.")
    return run


@router.get("/projects/{project_id}/experiments/runs")
def list_runs(
    project_id: int,
    status: str | None = None,
    search: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
):
    try:
        rows = mlflow_service.list_runs(f"project-{project_id}", max_results=limit)
    except Exception as exc:
        raise friendly(503, "MLflow runs are temporarily unavailable.") from exc
    if status:
        rows = [
            row for row in rows if str(row.get("status", "")).lower() == status.lower()
        ]
    if search:
        needle = search.lower()
        rows = [
            row
            for row in rows
            if needle in str(row.get("run_id", "")).lower()
            or needle in str(row.get("tags", {}).get("mlflow.runName", "")).lower()
        ]
    return rows


@router.get("/projects/{project_id}/experiments/runs/compare")
def compare_runs(
    project_id: int,
    run_ids: str = Query(..., description="Comma-separated MLflow run IDs"),
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
):
    ids = list(
        dict.fromkeys(value.strip() for value in run_ids.split(",") if value.strip())
    )
    if len(ids) < 2:
        raise friendly(400, "Provide at least two run IDs.", "Use ?run_ids=id1,id2")
    runs = [_project_run(project_id, run_id) for run_id in ids]
    return {
        "runs": runs,
        "metric_keys": sorted({key for run in runs for key in run.get("metrics", {})}),
        "param_keys": sorted({key for run in runs for key in run.get("params", {})}),
    }


@router.get("/projects/{project_id}/experiments/runs/{run_id}")
def get_run(
    project_id: int,
    run_id: str,
    _=Depends(require_project_perm(Permission.TRAIN_READ)),
):
    return _project_run(project_id, run_id)
