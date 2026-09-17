"""Pipeline adapter for executing a saved Dataset Preparation as one pipeline step.

Phase 3-A keeps Dataset Preparation as the owner of multi-source composition and
transform semantics. The pipeline node pins one saved Preparation version and
one logical output Dataset, snapshots source DatasetVersions at Pipeline Run
execution time, materializes the normal Preparation output DatasetVersion, and
passes that exact immutable version downstream.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import (
    Dataset,
    DatasetPreparation,
    DatasetPreparationRun,
    DatasetPreparationRunInput,
    DatasetPreparationRunStatus,
    DatasetPreparationVersion,
    DatasetVersion,
    PipelineRun,
)
from app.services import datasets
from app.services.dataset_preparation import (
    PreparationValidationError,
    parse_graph_json,
    resolve_source_pins,
)
from app.services.dataset_preparation_materialization import (
    execute_claimed_preparation_run,
    validate_run_for_queue,
)


def _required_positive_int(config: dict[str, Any], key: str) -> int:
    value = config.get(key)
    if isinstance(value, bool):
        raise ValueError(f"dataset_preparation requires a positive {key}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"dataset_preparation requires a positive {key}.") from exc
    if parsed <= 0:
        raise ValueError(f"dataset_preparation requires a positive {key}.")
    return parsed


def execute_pipeline_preparation(
    db: Session,
    pipeline_run: PipelineRun,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Run one exact saved Preparation version and return its materialized output.

    The Preparation version itself is fixed by pipeline config. Source nodes using
    ``version_strategy=latest`` are resolved exactly once when this pipeline step
    starts, matching the normal Dataset Preparation Run snapshot contract.
    """

    preparation_id = _required_positive_int(config, "preparation_id")
    preparation_version_id = _required_positive_int(config, "preparation_version_id")
    output_dataset_id = _required_positive_int(config, "output_dataset_id")

    preparation = db.get(DatasetPreparation, preparation_id)
    if preparation is None or preparation.project_id != pipeline_run.project_id:
        raise ValueError("Dataset Preparation was not found in this project.")

    version = db.get(DatasetPreparationVersion, preparation_version_id)
    if (
        version is None
        or version.project_id != pipeline_run.project_id
        or version.preparation_id != preparation.id
    ):
        raise ValueError("Dataset Preparation version was not found in this project.")

    output_dataset = db.get(Dataset, output_dataset_id)
    if output_dataset is None or output_dataset.project_id != pipeline_run.project_id:
        raise ValueError("Dataset Preparation output dataset was not found in this project.")

    graph = parse_graph_json(version.graph_json)
    try:
        pins = resolve_source_pins(db, pipeline_run.project_id, graph)
    except PreparationValidationError as exc:
        raise ValueError(
            "Dataset Preparation graph is invalid for pipeline execution: "
            + "; ".join(exc.errors)
        ) from exc

    prep_run = DatasetPreparationRun(
        project_id=pipeline_run.project_id,
        preparation_id=preparation.id,
        preparation_version_id=version.id,
        status=DatasetPreparationRunStatus.created,
        output_dataset_id=output_dataset.id,
        output_dataset_version_id=None,
        logs=f"Created from pipeline run #{pipeline_run.id}.\n",
        created_by=pipeline_run.created_by,
    )
    db.add(prep_run)
    db.flush()

    for pin in pins:
        db.add(
            DatasetPreparationRunInput(
                run_id=prep_run.id,
                project_id=pipeline_run.project_id,
                node_id=pin["node_id"],
                dataset_id=pin["dataset_id"],
                dataset_version_id=pin["dataset_version_id"],
                version_strategy=pin["version_strategy"],
            )
        )
    db.flush()

    validate_run_for_queue(db, prep_run, preparation)
    prep_run.status = DatasetPreparationRunStatus.running
    prep_run.started_at = datetime.now(timezone.utc)
    prep_run.logs = (prep_run.logs or "") + "Executing inside pipeline run.\n"
    db.flush()

    execute_claimed_preparation_run(db, prep_run)
    if (
        prep_run.status != DatasetPreparationRunStatus.succeeded
        or prep_run.output_dataset_version_id is None
    ):
        raise RuntimeError("Dataset Preparation did not produce an output DatasetVersion.")

    output_version = db.get(DatasetVersion, prep_run.output_dataset_version_id)
    if output_version is None or output_version.dataset_id != output_dataset.id:
        raise RuntimeError("Dataset Preparation output DatasetVersion could not be loaded.")

    frame = datasets.load_dataset_version_dataframe(output_version)
    return {
        "dataframe": frame,
        "dataset_id": output_dataset.id,
        "dataset_version_id": output_version.id,
        "preparation_id": preparation.id,
        "preparation_version_id": version.id,
        "preparation_run_id": prep_run.id,
    }
