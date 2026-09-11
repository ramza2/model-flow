"""Unit tests for Phase 2-C dataset preparation materialization helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

import pandas as pd
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import (
    Base,
    Dataset,
    DatasetPreparation,
    DatasetPreparationRun,
    DatasetPreparationRunInput,
    DatasetPreparationRunStatus,
    DatasetPreparationVersion,
    DatasetVersion,
    Project,
)
from app.services.dataset_preparation_materialization import (
    build_parquet_artifact,
    ensure_run_output_dataset_pinned,
    preparation_upstream_lineage,
    safe_preparation_filename,
    serialize_frame_to_parquet_bytes,
    validate_run_for_queue,
)


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture()
def db():
    Base.metadata.create_all(engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


def _seed_project(db) -> Project:
    project = Project(name="P", description="")
    db.add(project)
    db.flush()
    return project


def _seed_dataset(db, project_id: int, name: str = "ds") -> Dataset:
    dataset = Dataset(project_id=project_id, name=name, description="")
    db.add(dataset)
    db.flush()
    return dataset


def _seed_version(db, dataset: Dataset, version: int = 1) -> DatasetVersion:
    row = DatasetVersion(
        dataset_id=dataset.id,
        project_id=dataset.project_id,
        version=version,
        object_key=f"key-{dataset.id}-v{version}",
        original_filename=f"{dataset.name}.csv",
        format="csv",
        row_count=1,
        column_count=1,
        columns_json='["a"]',
        dtypes_json='{"a":"int64"}',
        stats_json="{}",
        preview_json='[{"a":1}]',
        source_type="upload",
    )
    db.add(row)
    dataset.latest_version = version
    db.flush()
    return row


def _simple_graph(dataset_id: int, dataset_version_id: int) -> dict:
    return {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset_version_id,
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [{"id": "e1", "source": "src", "target": "out"}],
    }


def test_serialize_and_filename_helpers():
    frame = pd.DataFrame({"x": [1, 2]})
    blob = serialize_frame_to_parquet_bytes(frame)
    assert blob == build_parquet_artifact(frame)
    assert list(pd.read_parquet(BytesIO(blob))["x"]) == [1, 2]
    assert safe_preparation_filename("Clean Name", 7) == "Clean Name-run-7.parquet"


def test_ensure_run_output_dataset_pinned_legacy(db):
    project = _seed_project(db)
    source = _seed_dataset(db, project.id, "source")
    output = _seed_dataset(db, project.id, "output")
    version = _seed_version(db, source)
    prep = DatasetPreparation(
        project_id=project.id,
        name="Prep",
        description="",
        output_dataset_id=output.id,
        latest_version=1,
    )
    db.add(prep)
    db.flush()
    prep_version = DatasetPreparationVersion(
        preparation_id=prep.id,
        project_id=project.id,
        version=1,
        graph_json="{}",
    )
    db.add(prep_version)
    db.flush()
    run = DatasetPreparationRun(
        project_id=project.id,
        preparation_id=prep.id,
        preparation_version_id=prep_version.id,
        status=DatasetPreparationRunStatus.created,
        output_dataset_id=None,
    )
    db.add(run)
    db.flush()

    pinned = ensure_run_output_dataset_pinned(db, run, prep)
    assert pinned == output.id
    assert run.output_dataset_id == output.id

    # Already pinned path
    assert ensure_run_output_dataset_pinned(db, run, prep) == output.id


def test_ensure_run_output_dataset_pinned_requires_config(db):
    project = _seed_project(db)
    prep = DatasetPreparation(
        project_id=project.id,
        name="Prep",
        description="",
        output_dataset_id=None,
        latest_version=0,
    )
    db.add(prep)
    db.flush()
    prep_version = DatasetPreparationVersion(
        preparation_id=prep.id,
        project_id=project.id,
        version=1,
        graph_json="{}",
    )
    db.add(prep_version)
    db.flush()
    run = DatasetPreparationRun(
        project_id=project.id,
        preparation_id=prep.id,
        preparation_version_id=prep_version.id,
        status=DatasetPreparationRunStatus.created,
    )
    db.add(run)
    db.flush()
    with pytest.raises(ValueError, match="Configure an output dataset"):
        ensure_run_output_dataset_pinned(db, run, prep)


def test_validate_run_for_queue_rejects_output_as_source(db):
    import json

    project = _seed_project(db)
    dataset = _seed_dataset(db, project.id, "both")
    version = _seed_version(db, dataset)
    prep = DatasetPreparation(
        project_id=project.id,
        name="Prep",
        description="",
        output_dataset_id=dataset.id,
        latest_version=1,
    )
    db.add(prep)
    db.flush()
    prep_version = DatasetPreparationVersion(
        preparation_id=prep.id,
        project_id=project.id,
        version=1,
        graph_json=json.dumps(_simple_graph(dataset.id, version.id)),
    )
    db.add(prep_version)
    db.flush()
    run = DatasetPreparationRun(
        project_id=project.id,
        preparation_id=prep.id,
        preparation_version_id=prep_version.id,
        status=DatasetPreparationRunStatus.created,
        output_dataset_id=dataset.id,
    )
    db.add(run)
    db.flush()
    db.add(
        DatasetPreparationRunInput(
            run_id=run.id,
            project_id=project.id,
            node_id="src",
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            version_strategy="fixed",
        )
    )
    db.flush()

    with pytest.raises(ValueError, match="Output dataset cannot also be used"):
        validate_run_for_queue(db, run, prep)


def test_validate_run_for_queue_happy_path(db):
    import json

    project = _seed_project(db)
    source = _seed_dataset(db, project.id, "source")
    output = _seed_dataset(db, project.id, "output")
    version = _seed_version(db, source)
    prep = DatasetPreparation(
        project_id=project.id,
        name="Prep",
        description="",
        output_dataset_id=output.id,
        latest_version=1,
    )
    db.add(prep)
    db.flush()
    prep_version = DatasetPreparationVersion(
        preparation_id=prep.id,
        project_id=project.id,
        version=1,
        graph_json=json.dumps(_simple_graph(source.id, version.id)),
    )
    db.add(prep_version)
    db.flush()
    run = DatasetPreparationRun(
        project_id=project.id,
        preparation_id=prep.id,
        preparation_version_id=prep_version.id,
        status=DatasetPreparationRunStatus.created,
        output_dataset_id=None,
    )
    db.add(run)
    db.flush()
    db.add(
        DatasetPreparationRunInput(
            run_id=run.id,
            project_id=project.id,
            node_id="src",
            dataset_id=source.id,
            dataset_version_id=version.id,
            version_strategy="fixed",
        )
    )
    db.flush()

    validate_run_for_queue(db, run, prep)
    assert run.output_dataset_id == output.id


def test_preparation_upstream_lineage(db):
    project = _seed_project(db)
    source = _seed_dataset(db, project.id, "source")
    output = _seed_dataset(db, project.id, "output")
    source_version = _seed_version(db, source)
    out_version = _seed_version(db, output, version=1)
    prep = DatasetPreparation(
        project_id=project.id,
        name="Prep",
        description="",
        output_dataset_id=output.id,
        latest_version=1,
    )
    db.add(prep)
    db.flush()
    prep_version = DatasetPreparationVersion(
        preparation_id=prep.id,
        project_id=project.id,
        version=1,
        graph_json="{}",
    )
    db.add(prep_version)
    db.flush()
    run = DatasetPreparationRun(
        project_id=project.id,
        preparation_id=prep.id,
        preparation_version_id=prep_version.id,
        status=DatasetPreparationRunStatus.succeeded,
        output_dataset_id=output.id,
        output_dataset_version_id=out_version.id,
        finished_at=datetime.now(timezone.utc),
    )
    db.add(run)
    db.flush()
    db.add(
        DatasetPreparationRunInput(
            run_id=run.id,
            project_id=project.id,
            node_id="src",
            dataset_id=source.id,
            dataset_version_id=source_version.id,
            version_strategy="fixed",
        )
    )
    db.flush()

    lineage = preparation_upstream_lineage(db, out_version)
    assert lineage is not None
    assert lineage["preparation"] == {"id": prep.id, "name": "Prep"}
    assert lineage["preparation_version"] == {"id": prep_version.id, "version": 1}
    assert lineage["preparation_run"] == {"id": run.id, "status": "succeeded"}
    assert lineage["input_versions"] == [
        {
            "node_id": "src",
            "dataset_id": source.id,
            "dataset_name": "source",
            "dataset_version_id": source_version.id,
            "version": 1,
        }
    ]
    assert preparation_upstream_lineage(db, source_version) is None
