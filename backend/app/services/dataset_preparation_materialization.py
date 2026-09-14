"""Full Dataset Preparation materialization (Phase 2-C).

Preview uses DatasetVersion.preview_json samples.
Full runs load pinned DatasetVersion artifacts from MinIO and share
execute_preparation_graph() with preview for identical transform semantics.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import safe_filename
from app.db.models import (
    Dataset,
    DatasetPreparation,
    DatasetPreparationRun,
    DatasetPreparationRunInput,
    DatasetPreparationRunStatus,
    DatasetPreparationVersion,
    DatasetVersion,
)
from app.services import datasets, storage
from app.services.dataset_preparation import (
    parse_graph_json,
    validate_preparation_graph,
)
from app.services.dataset_preparation_execution import execute_preparation_graph


def _append_log(run: DatasetPreparationRun, message: str) -> None:
    run.logs = (run.logs or "") + f"{message}\n"


def _source_node_ids(graph: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") != "source":
            continue
        node_id = str(node.get("id") or "").strip()
        if node_id:
            ids.add(node_id)
    return ids


def _run_inputs(db: Session, run: DatasetPreparationRun) -> list[DatasetPreparationRunInput]:
    return list(
        db.scalars(
            select(DatasetPreparationRunInput)
            .where(DatasetPreparationRunInput.run_id == run.id)
            .order_by(DatasetPreparationRunInput.node_id.asc())
        ).all()
    )


def ensure_run_output_dataset_pinned(
    db: Session,
    run: DatasetPreparationRun,
    preparation: DatasetPreparation,
) -> int:
    """Return the run's pinned output dataset id, applying a one-time legacy pin if needed."""
    if run.output_dataset_id is not None:
        return int(run.output_dataset_id)
    if preparation.output_dataset_id is not None:
        run.output_dataset_id = int(preparation.output_dataset_id)
        db.flush()
        return int(run.output_dataset_id)
    raise ValueError("Configure an output dataset before executing this preparation.")


def validate_run_for_queue(
    db: Session,
    run: DatasetPreparationRun,
    preparation: DatasetPreparation,
) -> None:
    """Validate a preparation run can be queued. May pin legacy output_dataset_id onto the run."""
    if run.preparation_id != preparation.id:
        raise ValueError("Preparation run does not belong to this preparation.")

    if not run.preparation_version_id:
        raise ValueError("Preparation run is missing a preparation version.")
    version = db.get(DatasetPreparationVersion, run.preparation_version_id)
    if (
        version is None
        or version.project_id != run.project_id
        or version.preparation_id != run.preparation_id
    ):
        raise ValueError("Preparation version was not found.")

    inputs = _run_inputs(db, run)
    if len(inputs) < 1:
        raise ValueError("Preparation run must have at least one source input.")

    graph = parse_graph_json(version.graph_json)
    validation = validate_preparation_graph(
        db, run.project_id, graph, strict=True, resolve_latest=False
    )
    if not validation["valid"]:
        raise ValueError(
            "Preparation graph is invalid: " + "; ".join(validation["errors"])
        )

    source_ids = _source_node_ids(graph)
    input_ids = {inp.node_id for inp in inputs}
    if source_ids != input_ids:
        missing = sorted(source_ids - input_ids)
        extra = sorted(input_ids - source_ids)
        parts: list[str] = []
        if missing:
            parts.append(f"missing inputs for source nodes: {', '.join(missing)}")
        if extra:
            parts.append(
                f"extra run inputs without matching source nodes: {', '.join(extra)}"
            )
        detail = "; ".join(parts) if parts else "source and input node ids differ"
        raise ValueError(
            "Preparation run inputs must exactly match graph source nodes; " + detail
        )

    output_dataset_id = ensure_run_output_dataset_pinned(db, run, preparation)

    output_dataset = db.get(Dataset, output_dataset_id)
    if output_dataset is None or output_dataset.project_id != run.project_id:
        raise ValueError("Output dataset was not found in this project.")

    if any(inp.dataset_id == output_dataset_id for inp in inputs):
        raise ValueError("Output dataset cannot also be used as a source dataset.")


def serialize_frame_to_parquet_bytes(frame: pd.DataFrame) -> bytes:
    """Serialize a DataFrame to parquet bytes (no index)."""
    buffer = BytesIO()
    frame.to_parquet(buffer, index=False)
    return buffer.getvalue()


def build_parquet_artifact(frame: pd.DataFrame) -> bytes:
    """Alias for serialize_frame_to_parquet_bytes."""
    return serialize_frame_to_parquet_bytes(frame)


def safe_preparation_filename(preparation_name: str, run_id: int) -> str:
    """Build a storage-safe parquet filename for a preparation run output."""
    base = safe_filename(preparation_name or "preparation")
    if base.lower().endswith(".parquet"):
        base = base[: -len(".parquet")]
    base = base.strip("._") or "preparation"
    return f"{base}-run-{run_id}.parquet"


def load_pinned_source_frames(
    db: Session, run: DatasetPreparationRun
) -> dict[str, pd.DataFrame]:
    """Load full DataFrames for each pinned run input. Never re-resolves latest."""
    version = db.get(DatasetPreparationVersion, run.preparation_version_id)
    if (
        version is None
        or version.project_id != run.project_id
        or version.preparation_id != run.preparation_id
    ):
        raise ValueError("Preparation version was not found.")

    graph = parse_graph_json(version.graph_json)
    source_ids = _source_node_ids(graph)
    inputs = _run_inputs(db, run)
    input_ids = {inp.node_id for inp in inputs}
    if source_ids != input_ids:
        raise ValueError(
            "Preparation run inputs must exactly match graph source nodes."
        )

    frames: dict[str, pd.DataFrame] = {}
    for inp in inputs:
        pinned = db.get(DatasetVersion, inp.dataset_version_id)
        if (
            pinned is None
            or pinned.project_id != run.project_id
            or pinned.dataset_id != inp.dataset_id
        ):
            raise ValueError(
                f"Pinned dataset version for source node '{inp.node_id}' was not found "
                "or does not match the run input."
            )
        frames[inp.node_id] = datasets.load_dataset_version_dataframe(pinned)
    return frames


def create_output_version(
    db: Session,
    dataset: Dataset,
    run: DatasetPreparationRun,
    frame: pd.DataFrame,
    preparation_name: str,
) -> DatasetVersion:
    """Lock the output dataset and create an immutable preparation-sourced version."""
    locked = (
        db.query(Dataset)
        .filter(Dataset.id == dataset.id)
        .with_for_update()
        .one()
    )
    if locked.project_id != run.project_id:
        raise ValueError("Output dataset was not found in this project.")

    payload = build_parquet_artifact(frame)
    filename = safe_preparation_filename(preparation_name, run.id)
    clean_name = safe_filename(filename)
    latest = db.scalar(
        select(func.max(DatasetVersion.version)).where(
            DatasetVersion.dataset_id == locked.id
        )
    )
    version_number = int(latest or 0) + 1
    object_key = (
        f"project-{locked.project_id}/dataset-{locked.id}/"
        f"v{version_number}-{uuid.uuid4().hex}/{clean_name}"
    )
    try:
        return datasets.create_dataset_version_from_bytes(
            db,
            locked,
            payload,
            filename,
            file_format="parquet",
            created_by=run.created_by,
            source_type="preparation",
            object_key=object_key,
        )
    except Exception:
        try:
            storage.delete_object(settings.minio_datasets_bucket, object_key)
        except Exception:
            pass
        raise


def execute_claimed_preparation_run(
    db: Session, run: DatasetPreparationRun
) -> DatasetPreparationRun:
    """Execute a claimed (running) preparation run. Raises on failure.

    Updates success fields on the session; the caller is responsible for commit
    or for marking the run failed after rollback.
    """
    live = db.get(DatasetPreparationRun, run.id)
    if live is None:
        raise RuntimeError(f"Preparation run {run.id} no longer exists")
    if live.status != DatasetPreparationRunStatus.running:
        return live

    preparation = db.get(DatasetPreparation, live.preparation_id)
    if preparation is None or preparation.project_id != live.project_id:
        raise ValueError("Preparation was not found.")
    version = db.get(DatasetPreparationVersion, live.preparation_version_id)
    if (
        version is None
        or version.project_id != live.project_id
        or version.preparation_id != live.preparation_id
    ):
        raise ValueError("Preparation version was not found.")

    if live.output_dataset_id is None:
        raise ValueError("Configure an output dataset before executing this preparation.")

    output_dataset = (
        db.query(Dataset)
        .filter(Dataset.id == live.output_dataset_id)
        .with_for_update()
        .one()
    )
    if output_dataset.project_id != live.project_id:
        raise ValueError("Output dataset was not found in this project.")

    inputs = _run_inputs(db, live)
    _append_log(live, f"Loading {len(inputs)} pinned source dataset version(s).")
    frames = load_pinned_source_frames(db, live)
    for inp in inputs:
        frame = frames.get(inp.node_id)
        row_count = len(frame) if frame is not None else 0
        _append_log(
            live,
            f"Loaded source node '{inp.node_id}' dataset version #{inp.dataset_version_id} "
            f"({row_count} rows).",
        )

    _append_log(live, "Executing preparation graph.")
    graph = parse_graph_json(version.graph_json)
    result_frame = execute_preparation_graph(graph, frames)

    _append_log(
        live,
        f"Materializing output dataset #{output_dataset.id} as Parquet.",
    )
    out_version = create_output_version(
        db, output_dataset, live, result_frame, preparation.name
    )

    live.status = DatasetPreparationRunStatus.succeeded
    live.output_dataset_version_id = out_version.id
    live.error_message = None
    live.finished_at = datetime.now(timezone.utc)
    _append_log(
        live,
        f"Created dataset version v{out_version.version} (#{out_version.id}), "
        f"{out_version.row_count} rows, {out_version.column_count} columns.",
    )
    _append_log(live, "Preparation succeeded.")
    db.flush()
    return live


def materialize_preparation_run(db: Session, run_id: int) -> DatasetPreparationRun:
    """Reload a preparation run and execute it when status is running."""
    run = db.get(DatasetPreparationRun, run_id)
    if run is None:
        raise RuntimeError(f"Preparation run {run_id} no longer exists")
    return execute_claimed_preparation_run(db, run)


def preparation_upstream_lineage(
    db: Session, dataset_version: DatasetVersion
) -> dict[str, Any] | None:
    """Return preparation upstream lineage for a DatasetVersion, or None."""
    run = db.scalar(
        select(DatasetPreparationRun).where(
            DatasetPreparationRun.output_dataset_version_id == dataset_version.id,
            DatasetPreparationRun.status == DatasetPreparationRunStatus.succeeded,
        )
    )
    if run is None:
        return None

    preparation = db.get(DatasetPreparation, run.preparation_id)
    prep_version = db.get(DatasetPreparationVersion, run.preparation_version_id)
    if preparation is None or prep_version is None:
        return None

    inputs = _run_inputs(db, run)
    input_versions: list[dict[str, Any]] = []
    for inp in inputs:
        pinned = db.get(DatasetVersion, inp.dataset_version_id)
        source_dataset = db.get(Dataset, inp.dataset_id)
        input_versions.append(
            {
                "node_id": inp.node_id,
                "dataset_id": inp.dataset_id,
                "dataset_name": source_dataset.name if source_dataset else None,
                "dataset_version_id": inp.dataset_version_id,
                "version": pinned.version if pinned else None,
            }
        )

    status = run.status.value if hasattr(run.status, "value") else str(run.status)
    return {
        "preparation": {"id": preparation.id, "name": preparation.name},
        "preparation_version": {"id": prep_version.id, "version": prep_version.version},
        "preparation_run": {"id": run.id, "status": status},
        "input_versions": input_versions,
    }
