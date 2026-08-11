from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    Base,
    Dataset,
    DatasetVersion,
    Endpoint,
    ModelLifecycle,
    ModelVersion,
    Project,
    TrainingJob,
)
from app.services import inference


@pytest.fixture
def db(tmp_path):
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'prediction-sample.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with Session() as session:
        yield session
    Base.metadata.drop_all(engine)
    engine.dispose()


def _seed_lineage(
    db,
    *,
    feature_schema,
    preview,
    dtypes=None,
    via_training_job: bool = True,
):
    project = Project(name="prediction-sample")
    db.add(project)
    db.flush()
    dataset = Dataset(
        project_id=project.id,
        name="demand",
        object_key="demand.csv",
        latest_version=1,
    )
    db.add(dataset)
    db.flush()
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project.id,
        version=1,
        object_key="demand.csv",
        original_filename="demand.csv",
        format="csv",
        preview_json=json.dumps(preview),
        dtypes_json=json.dumps(dtypes or {}),
        columns_json=json.dumps(list((preview[0] if preview else {}).keys())),
    )
    db.add(version)
    db.flush()
    job = None
    if via_training_job:
        job = TrainingJob(
            project_id=project.id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="train",
            target_column="demand_level",
            feature_columns_json=json.dumps(
                [f if isinstance(f, str) else f["name"] for f in feature_schema]
            ),
        )
        db.add(job)
        db.flush()
    model = ModelVersion(
        project_id=project.id,
        name="demand-model",
        version="1",
        lifecycle=ModelLifecycle.PRODUCTION,
        mlflow_model_name="demand-model",
        mlflow_version="1",
        mlflow_run_id="run-1",
        model_uri="models:/demand-model/1",
        dataset_version_id=None if via_training_job else version.id,
        training_job_id=job.id if job else None,
        gates_passed=True,
        gate_results_json=json.dumps({"passed": True}),
        metadata_json="{}",
    )
    db.add(model)
    db.flush()
    endpoint = Endpoint(
        project_id=project.id,
        name="demand-ep",
        model_name=model.name,
        model_version=model.version,
        model_version_id=model.id,
        model_uri=model.model_uri,
        status="ready",
        feature_schema_json=json.dumps(feature_schema),
    )
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    return endpoint


def test_prediction_sample_uses_preview_feature_subset(db):
    preview = [
        {
            "site_id": "SITE_A",
            "measured_at": "2026-07-01T09:00:00",
            "supply_temp": 72.4,
            "humidity": 55.1,
            "demand_level": "HIGH",
        }
    ]
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp"],
        preview=preview,
        dtypes={
            "site_id": "object",
            "measured_at": "datetime64[ns]",
            "supply_temp": "float64",
            "humidity": "float64",
            "demand_level": "object",
        },
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {
        "site_id": "SITE_A",
        "measured_at": "2026-07-01T09:00:00",
        "supply_temp": 72.4,
    }
    assert "demand_level" not in sample
    assert "humidity" not in sample


def test_prediction_sample_legacy_string_schema(db):
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp"],
        preview=[
            {
                "site_id": "SITE_A",
                "measured_at": "2026-07-01T09:00:00",
                "supply_temp": 72.4,
                "demand_level": "HIGH",
            }
        ],
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample["site_id"] == "SITE_A"
    assert sample["measured_at"] == "2026-07-01T09:00:00"
    assert sample["supply_temp"] == 72.4


def test_prediction_sample_dtype_fallback_without_preview(db):
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp", "is_active"],
        preview=[],
        dtypes={
            "site_id": "object",
            "measured_at": "datetime64[ns]",
            "supply_temp": "float64",
            "is_active": "bool",
        },
        via_training_job=False,
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {
        "site_id": "sample",
        "measured_at": "2026-01-01T00:00:00",
        "supply_temp": 0.0,
        "is_active": False,
    }


def test_prediction_sample_without_lineage_does_not_fail(db):
    project = Project(name="orphan-ep")
    db.add(project)
    db.flush()
    endpoint = Endpoint(
        project_id=project.id,
        name="orphan",
        model_name="m",
        model_version="1",
        model_version_id=None,
        model_uri="models:/m/1",
        status="ready",
        feature_schema_json=json.dumps(
            [
                {"name": "site_id", "dtype": "object"},
                {"name": "supply_temp", "dtype": "float64", "example": 12.5},
            ]
        ),
    )
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {"site_id": "sample", "supply_temp": 12.5}


def test_string_schema_without_dtype_is_not_all_zeros(db):
    project = Project(name="zeros-regression")
    db.add(project)
    db.flush()
    endpoint = Endpoint(
        project_id=project.id,
        name="zeros",
        model_name="m",
        model_version="1",
        model_version_id=None,
        model_uri="models:/m/1",
        status="ready",
        feature_schema_json=json.dumps(["site_id", "measured_at", "supply_temp"]),
    )
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {
        "site_id": "sample",
        "measured_at": "sample",
        "supply_temp": "sample",
    }
    assert sample != {"site_id": 0, "measured_at": 0, "supply_temp": 0}


def test_validate_instances_still_accepts_legacy_string_schema():
    inference.validate_instances(
        [{"site_id": "SITE_A", "supply_temp": 1.0}],
        ["site_id", "supply_temp"],
    )
