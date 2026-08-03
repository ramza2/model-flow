"""Registry approval-gate schema / test-inference coverage."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import (
    Base,
    Dataset,
    DatasetVersion,
    JobStatus,
    ModelLifecycle,
    ModelVersion,
    Project,
    TrainingJob,
)
from app.services import gate_policy, inference, mlflow_service, registry_service

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture(autouse=True)
def _db(monkeypatch):
    Base.metadata.create_all(engine)
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "artifacts": [{"path": "model", "is_dir": True}],
            "params": {},
            "metrics": {},
        },
    )
    monkeypatch.setattr(
        registry_service,
        "_mlflow_logged_feature_schema",
        lambda run_id: [],
    )
    yield
    Base.metadata.drop_all(engine)


def _seed_project(db) -> Project:
    project = Project(name="registry-schema", description="")
    db.add(project)
    db.flush()
    gate_policy.ensure_default_gate_policy(db, project.id)
    return project


def _seed_lineage(
    db,
    project: Project,
    *,
    run_id: str = "run-mixed-1",
    with_preview: bool = True,
):
    dataset = Dataset(
        project_id=project.id,
        name="sensors",
        description="",
        object_key="datasets/sensors.csv",
    )
    db.add(dataset)
    db.flush()
    preview = (
        [
            {
                "site_id": "plant-a",
                "measured_at": "2024-06-01T12:00:00",
                "supply_temp": 42.5,
            }
        ]
        if with_preview
        else []
    )
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project.id,
        version=1,
        object_key="datasets/sensors/v1.csv",
        original_filename="sensors.csv",
        row_count=3,
        column_count=4,
        columns_json=json.dumps(
            ["site_id", "measured_at", "supply_temp", "target_value"]
        ),
        dtypes_json=json.dumps(
            {
                "site_id": "object",
                "measured_at": "object",
                "supply_temp": "float64",
                "target_value": "float64",
            }
        ),
        preview_json=json.dumps(preview),
    )
    db.add(version)
    db.flush()
    job = TrainingJob(
        project_id=project.id,
        dataset_id=dataset.id,
        dataset_version_id=version.id,
        name="ridge-mixed",
        target_column="target_value",
        problem_type="regression",
        algorithm="ridge",
        feature_columns_json=json.dumps(
            ["site_id", "measured_at", "supply_temp"]
        ),
        status=JobStatus.succeeded,
        mlflow_run_id=run_id,
        model_uri=f"runs:/{run_id}/model",
        metrics_json=json.dumps({"rmse": 0.2, "r2": 0.9}),
    )
    db.add(job)
    db.flush()
    return dataset, version, job


class _PredictModel:
    def __init__(self):
        self.last_frame = None

    def predict(self, frame):
        self.last_frame = frame
        assert list(frame.columns) == ["site_id", "measured_at", "supply_temp"]
        assert frame.iloc[0]["site_id"] == "" or isinstance(
            frame.iloc[0]["site_id"], str
        )
        assert isinstance(frame.iloc[0]["supply_temp"], (int, float))
        return [1.0]


def _gate_map(summary: dict) -> dict:
    return {item["type"]: item for item in summary["results"]}


def test_generated_value_dtype_defaults():
    assert registry_service._generated_value({"dtype": "object"}) == ""
    assert registry_service._generated_value({"dtype": "string"}) == ""
    assert registry_service._generated_value({"dtype": "float64"}) == 0.0
    assert registry_service._generated_value({"dtype": "int64"}) == 0
    assert registry_service._generated_value({"dtype": "bool"}) is False
    assert (
        registry_service._generated_value({"dtype": "datetime64[ns]"})
        == "2024-01-01T00:00:00"
    )


def test_feature_schema_enriches_missing_dtypes_from_dataset():
    with SessionLocal() as db:
        project = _seed_project(db)
        _, version, job = _seed_lineage(db, project)
        row = ModelVersion(
            project_id=project.id,
            name="regressor",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project.id}-regressor",
            mlflow_version="1",
            mlflow_run_id=job.mlflow_run_id,
            model_uri=f"models:/project-{project.id}-regressor/1",
            metrics_json=job.metrics_json,
            metadata_json=json.dumps(
                {
                    "artifact_path": "model",
                    "feature_schema": [
                        {"name": "site_id", "required": True},
                        {"name": "measured_at", "required": True},
                        {"name": "supply_temp", "required": True},
                    ],
                }
            ),
            training_job_id=job.id,
            dataset_version_id=version.id,
        )
        db.add(row)
        db.flush()

        schema, source, resolved = registry_service._feature_schema(
            db, row, json.loads(row.metadata_json), job
        )
        assert source == "metadata"
        assert resolved is not None and resolved.id == version.id
        by_name = {field["name"]: field for field in schema}
        assert by_name["site_id"]["dtype"] == "object"
        assert by_name["measured_at"]["dtype"] == "object"
        assert by_name["supply_temp"]["dtype"] == "float64"


def test_registration_feature_schema_includes_dtypes():
    with SessionLocal() as db:
        project = _seed_project(db)
        _, version, job = _seed_lineage(db, project)
        schema = registry_service.build_registration_feature_schema(
            db,
            feature_names=["site_id", "measured_at", "supply_temp"],
            job=job,
            dataset_version_id=version.id,
            mlflow_run_id=job.mlflow_run_id,
        )
        assert schema == [
            {"name": "site_id", "required": True, "dtype": "object"},
            {"name": "measured_at", "required": True, "dtype": "object"},
            {"name": "supply_temp", "required": True, "dtype": "float64"},
        ]


def test_evaluate_gates_uses_dataset_preview_sample(monkeypatch):
    model = _PredictModel()
    monkeypatch.setattr(inference, "load_model", lambda uri: model)

    with SessionLocal() as db:
        project = _seed_project(db)
        _, version, job = _seed_lineage(db, project, with_preview=True)
        row = ModelVersion(
            project_id=project.id,
            name="regressor",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project.id}-regressor",
            mlflow_version="1",
            mlflow_run_id=job.mlflow_run_id,
            model_uri=f"models:/project-{project.id}-regressor/1",
            metrics_json=job.metrics_json,
            metadata_json=json.dumps(
                {
                    "artifact_path": "model",
                    "problem_type": "regression",
                    "feature_schema": [
                        {"name": "site_id", "required": True},
                        {"name": "measured_at", "required": True},
                        {"name": "supply_temp", "required": True},
                    ],
                }
            ),
            training_job_id=job.id,
            dataset_version_id=version.id,
        )
        db.add(row)
        db.flush()

        summary = registry_service.evaluate_gates(db, row)
        gates = _gate_map(summary)
        assert summary["passed"] is True
        assert gates["test_inference"]["passed"] is True
        assert gates["test_inference"]["observed"]["sample_source"] == "dataset"
        latency = gates["inference_latency"]["observed"]["latency_ms"]
        assert isinstance(latency, (int, float))
        assert latency <= 5000
        assert model.last_frame.iloc[0]["site_id"] == "plant-a"
        assert float(model.last_frame.iloc[0]["supply_temp"]) == 42.5


def test_evaluate_gates_schema_sample_without_preview(monkeypatch):
    model = _PredictModel()
    monkeypatch.setattr(inference, "load_model", lambda uri: model)

    with SessionLocal() as db:
        project = _seed_project(db)
        _, version, job = _seed_lineage(db, project, with_preview=False)
        row = ModelVersion(
            project_id=project.id,
            name="regressor",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project.id}-regressor",
            mlflow_version="1",
            mlflow_run_id=job.mlflow_run_id,
            model_uri=f"models:/project-{project.id}-regressor/1",
            metrics_json=job.metrics_json,
            metadata_json=json.dumps(
                {
                    "artifact_path": "model",
                    "problem_type": "regression",
                    "feature_schema": [
                        {"name": "site_id", "required": True},
                        {"name": "measured_at", "required": True},
                        {"name": "supply_temp", "required": True},
                    ],
                }
            ),
            training_job_id=job.id,
            dataset_version_id=version.id,
        )
        db.add(row)
        db.flush()

        summary = registry_service.evaluate_gates(db, row)
        gates = _gate_map(summary)
        assert summary["passed"] is True
        assert gates["test_inference"]["passed"] is True
        assert gates["test_inference"]["observed"]["sample_source"] == "schema"
        assert model.last_frame.iloc[0]["site_id"] == ""
        assert model.last_frame.iloc[0]["measured_at"] == ""
        assert model.last_frame.iloc[0]["supply_temp"] == 0.0
        latency = gates["inference_latency"]["observed"]["latency_ms"]
        assert isinstance(latency, (int, float)) and latency <= 5000

        # Enriched dtypes persisted for re-validation.
        stored = json.loads(row.metadata_json)["feature_schema"]
        assert {field["name"]: field["dtype"] for field in stored} == {
            "site_id": "object",
            "measured_at": "object",
            "supply_temp": "float64",
        }


def test_backfill_lineage_on_reevaluation(monkeypatch):
    model = _PredictModel()
    monkeypatch.setattr(inference, "load_model", lambda uri: model)

    with SessionLocal() as db:
        project = _seed_project(db)
        _, version, job = _seed_lineage(db, project, run_id="run-orphan")
        # Legacy registration: no training_job_id / dataset_version_id, name-only schema.
        row = ModelVersion(
            project_id=project.id,
            name="regressor",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project.id}-regressor",
            mlflow_version="1",
            mlflow_run_id="run-orphan",
            model_uri=f"models:/project-{project.id}-regressor/1",
            metrics_json=json.dumps({"rmse": 0.1, "r2": 0.95}),
            metadata_json=json.dumps(
                {
                    "artifact_path": "model",
                    "problem_type": "regression",
                    "feature_schema": [
                        {"name": "site_id", "required": True},
                        {"name": "measured_at", "required": True},
                        {"name": "supply_temp", "required": True},
                    ],
                }
            ),
        )
        db.add(row)
        db.flush()
        assert row.training_job_id is None
        assert row.dataset_version_id is None

        summary = registry_service.evaluate_gates(db, row)
        assert summary["passed"] is True
        assert row.training_job_id == job.id
        assert row.dataset_version_id == version.id


def test_classification_gate_still_passes(monkeypatch):
    class Classifier:
        def predict(self, frame):
            assert frame.to_dict(orient="records") == [{"feature": 1.25}]
            return [1]

    monkeypatch.setattr(inference, "load_model", lambda uri: Classifier())

    with SessionLocal() as db:
        project = _seed_project(db)
        row = ModelVersion(
            project_id=project.id,
            name="classifier",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project.id}-classifier",
            mlflow_version="1",
            mlflow_run_id="run-cls",
            model_uri=f"models:/project-{project.id}-classifier/1",
            metrics_json=json.dumps({"accuracy": 0.9}),
            metadata_json=json.dumps(
                {
                    "artifact_path": "model",
                    "problem_type": "classification",
                    "feature_schema": [
                        {"name": "feature", "dtype": "float", "example": 1.25}
                    ],
                }
            ),
        )
        db.add(row)
        db.flush()
        summary = registry_service.evaluate_gates(db, row)
        assert summary["passed"] is True
        assert {item["type"] for item in summary["results"]} >= {
            "test_inference",
            "inference_latency",
            "metric_threshold",
        }


def test_register_from_run_links_training_job(monkeypatch):
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "3"},
    )
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "params": {
                "features": "site_id,measured_at,supply_temp",
                "problem_type": "regression",
            },
            "metrics": {"rmse": 0.15, "r2": 0.88},
            "tags": {},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )

    with SessionLocal() as db:
        project = _seed_project(db)
        _, version, job = _seed_lineage(db, project, run_id="run-register")
        row = registry_service.register_from_run(
            db,
            project_id=project.id,
            run_id="run-register",
            model_name="sensor-model",
        )
        assert row.training_job_id == job.id
        assert row.dataset_version_id == version.id
        schema = json.loads(row.metadata_json)["feature_schema"]
        assert {field["name"]: field.get("dtype") for field in schema} == {
            "site_id": "object",
            "measured_at": "object",
            "supply_temp": "float64",
        }
