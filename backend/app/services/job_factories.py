"""Shared job/run creation for API handlers and the automation scheduler."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    BatchInferenceJob,
    DataImportJob,
    DataSource,
    Dataset,
    DatasetVersion,
    Endpoint,
    JobStatus,
    ModelVersion,
    Pipeline,
    PipelineRun,
    PipelineStatus,
    PipelineVersion,
)
from app.services import pipeline_engine


def _loads(value: str | None) -> dict[str, Any]:
    try:
        result = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return result if isinstance(result, dict) else {}


def resolve_dataset(
    db: Session,
    *,
    project_id: int,
    dataset_id: int | None = None,
    dataset_name: str | None = None,
    created_by: int | None = None,
) -> Dataset:
    if dataset_id is not None:
        dataset = db.get(Dataset, dataset_id)
        if dataset is None or dataset.project_id != project_id:
            raise ValueError("Target dataset was not found in this project.")
        return dataset
    if not dataset_name or not dataset_name.strip():
        raise ValueError("Dataset name or dataset_id is required.")
    dataset = db.scalar(
        select(Dataset).where(
            Dataset.project_id == project_id,
            func.lower(Dataset.name) == dataset_name.strip().lower(),
        )
    )
    if dataset is not None:
        return dataset
    dataset = Dataset(
        project_id=project_id,
        name=dataset_name.strip(),
        created_by=created_by,
    )
    db.add(dataset)
    db.flush()
    return dataset


def create_data_import_job(
    db: Session,
    *,
    project_id: int,
    data_source_id: int,
    dataset_id: int,
    query_or_table: str,
    created_by: int | None,
) -> DataImportJob:
    source = db.get(DataSource, data_source_id)
    dataset = db.get(Dataset, dataset_id)
    if source is None or source.project_id != project_id:
        raise ValueError("Data source was not found in this project.")
    if not source.is_active:
        raise ValueError("Data source is inactive.")
    if dataset is None or dataset.project_id != project_id:
        raise ValueError("Target dataset was not found in this project.")
    job = DataImportJob(
        project_id=project_id,
        data_source_id=source.id,
        dataset_id=dataset.id,
        query_or_table=query_or_table,
        status=JobStatus.pending,
        created_by=created_by,
    )
    db.add(job)
    db.flush()
    return job


def resolve_dataset_version_for_batch(
    db: Session,
    *,
    project_id: int,
    dataset_id: int,
    strategy: str,
    fixed_version_id: int | None,
) -> DatasetVersion:
    dataset = db.get(Dataset, dataset_id)
    if dataset is None or dataset.project_id != project_id:
        raise ValueError("Dataset was not found in this project.")
    if strategy == "fixed":
        if fixed_version_id is None:
            raise ValueError("Fixed dataset version strategy requires dataset_version_id.")
        version = db.get(DatasetVersion, fixed_version_id)
        if version is None or version.project_id != project_id or version.dataset_id != dataset.id:
            raise ValueError("Dataset version was not found for this dataset.")
        return version
    if strategy != "latest":
        raise ValueError("dataset_version_strategy must be 'latest' or 'fixed'.")
    version = db.scalar(
        select(DatasetVersion)
        .where(DatasetVersion.dataset_id == dataset.id)
        .order_by(DatasetVersion.version.desc())
        .limit(1)
    )
    if version is None:
        raise ValueError("Dataset has no versions to run batch inference against.")
    return version


def create_batch_inference_job(
    db: Session,
    *,
    project_id: int,
    dataset_version_id: int,
    endpoint_id: int | None,
    model_version_id: int | None,
    result_format: str,
    created_by: int | None,
) -> BatchInferenceJob:
    version = db.get(DatasetVersion, dataset_version_id)
    if version is None or version.project_id != project_id:
        raise ValueError("Dataset version was not found in this project.")
    if endpoint_id is not None:
        endpoint = db.get(Endpoint, endpoint_id)
        if endpoint is None or endpoint.project_id != project_id:
            raise ValueError("Endpoint was not found in this project.")
    if model_version_id is not None:
        model_version = db.get(ModelVersion, model_version_id)
        if model_version is None or model_version.project_id != project_id:
            raise ValueError("Model version was not found in this project.")
    if endpoint_id is None and model_version_id is None:
        raise ValueError("Provide endpoint_id or model_version_id.")
    job = BatchInferenceJob(
        project_id=project_id,
        dataset_version_id=version.id,
        endpoint_id=endpoint_id,
        model_version_id=model_version_id,
        result_format=result_format,
        status=JobStatus.pending,
        created_by=created_by,
    )
    db.add(job)
    db.flush()
    return job


def resolve_published_pipeline_version(
    db: Session,
    *,
    project_id: int,
    pipeline_id: int,
    pipeline_version_id: int | None = None,
) -> tuple[Pipeline, PipelineVersion]:
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None or pipeline.project_id != project_id:
        raise ValueError("Pipeline was not found in this project.")
    if pipeline.status != PipelineStatus.published:
        raise ValueError("Pipeline must be published before scheduling runs.")
    if pipeline_version_id is not None:
        version = db.get(PipelineVersion, pipeline_version_id)
        if version is None or version.pipeline_id != pipeline.id:
            raise ValueError("Pipeline version was not found for this pipeline.")
        return pipeline, version
    version = db.scalar(
        select(PipelineVersion)
        .where(PipelineVersion.pipeline_id == pipeline.id)
        .order_by(PipelineVersion.version.desc())
        .limit(1)
    )
    if version is None:
        raise ValueError("Pipeline has no published version.")
    return pipeline, version


def create_pipeline_run(
    db: Session,
    *,
    project_id: int,
    pipeline_id: int,
    pipeline_version_id: int,
    parameters: dict[str, Any] | None = None,
    fail_policy: str = "stop",
    scheduled_for=None,
    created_by: int | None,
) -> PipelineRun:
    pipeline, version = resolve_published_pipeline_version(
        db,
        project_id=project_id,
        pipeline_id=pipeline_id,
        pipeline_version_id=pipeline_version_id,
    )
    graph = _loads(version.graph_json)
    validation = pipeline_engine.validate_graph(graph)
    if not validation["valid"]:
        raise ValueError("; ".join(validation["errors"]))
    graph_nodes = graph.get("nodes", [])
    node_states = {
        str(node["id"]): pipeline_engine.initial_node_state(node) for node in graph_nodes
    }
    run = PipelineRun(
        project_id=project_id,
        pipeline_id=pipeline.id,
        pipeline_version_id=version.id,
        status=JobStatus.pending,
        parameters_json=json.dumps(parameters or {}),
        node_states_json=json.dumps(node_states),
        fail_policy=fail_policy,
        scheduled_for=scheduled_for,
        created_by=created_by,
    )
    db.add(run)
    db.flush()
    return run
