from __future__ import annotations

import json
import secrets

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import Base, JobStatus, Project, TrainingJob, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage
from app.services.algorithm_catalog import normalize_problem_type_for_targets
from app.services.prediction_serialization import (
    assign_batch_prediction_columns,
    serialize_predictions,
)
from app.services.retrain_service import build_job_create_from_source
from app.services.training import SklearnTrainingRunner, TrainingJobContext
from app.services import pipeline_engine

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
PASSWORD = secrets.token_urlsafe(24)

CSV_SINGLE = (
    b"a,b,target\n"
    b"1,2,0\n2,3,0\n3,4,1\n4,5,1\n5,6,1\n6,7,0\n"
    b"7,8,1\n8,9,0\n9,1,1\n10,2,0\n"
)
CSV_MULTI = (
    b"a,b,price,demand\n"
    b"1,2,10.0,5.0\n2,3,11.0,6.0\n3,4,12.0,7.0\n4,5,13.0,8.0\n5,6,14.0,9.0\n"
    b"6,7,15.0,10.0\n7,8,16.0,11.0\n8,9,17.0,12.0\n9,1,18.0,13.0\n10,2,19.0,14.0\n"
)
CSV_MULTI_BINARY = (
    b"a,b,t1,t2\n"
    b"1,2,0,1\n2,3,1,0\n3,4,0,1\n4,5,1,0\n5,6,0,1\n6,7,1,0\n"
    b"7,8,0,1\n8,9,1,0\n9,1,0,1\n10,2,1,0\n"
)
CSV_MULTI_BOOL = (
    b"a,b,flag_a,flag_b\n"
    b"1,2,True,False\n2,3,False,True\n3,4,True,False\n4,5,False,True\n5,6,True,False\n"
    b"6,7,False,True\n7,8,True,False\n8,9,False,True\n9,1,True,False\n10,2,False,True\n"
)
CSV_MULTI_INT_CONTINUOUS = (
    b"a,b,count_a,count_b\n"
    b"1,2,100,200\n2,3,110,210\n3,4,120,220\n4,5,130,230\n5,6,140,240\n"
    b"6,7,150,250\n7,8,160,260\n8,9,170,270\n9,1,180,280\n10,2,190,290\n"
)


@pytest.fixture(autouse=True)
def setup_edge_case_tests(monkeypatch):
    Base.metadata.create_all(engine)
    OBJECT_STORE.clear()
    _rate_windows.clear()

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(
        storage,
        "upload_bytes",
        lambda bucket, key, data, content_type="application/octet-stream": OBJECT_STORE.__setitem__(
            (bucket, key), data
        ),
    )
    monkeypatch.setattr(
        storage,
        "download_bytes",
        lambda bucket, key: OBJECT_STORE[(bucket, key)],
    )
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        registry_service,
        "_mlflow_logged_feature_schema",
        lambda run_id: [],
    )
    with TestingSessionLocal() as db:
        admin = User(
            email="admin@example.com",
            full_name="Admin",
            password_hash=hash_password(PASSWORD),
            is_active=True,
            is_system_admin=True,
        )
        db.add(admin)
        db.flush()
        project = Project(name="edge-case-project", created_by=admin.id)
        db.add(project)
        db.commit()
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": PASSWORD},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
def project_id():
    with TestingSessionLocal() as db:
        return db.scalar(select(Project.id).where(Project.name == "edge-case-project"))


def _upload(client, auth_headers, project_id, csv: bytes, name: str = "dataset"):
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (f"{name}.csv", csv, "text/csv")},
        data={"name": name},
    )
    assert response.status_code == 201
    payload = response.json()
    return payload["id"], payload["version"]["id"]


def _seed_succeeded_job(
    *,
    target_column: str = "target",
    target_columns: list[str] | None = None,
    problem_type: str = "classification",
) -> TrainingJob:
    columns = target_columns or [target_column]
    with TestingSessionLocal() as db:
        project_id = db.scalar(select(Project.id).where(Project.name == "edge-case-project"))
        job = TrainingJob(
            project_id=project_id,
            dataset_id=1,
            dataset_version_id=1,
            name="source-job",
            target_column=columns[0],
            target_columns_json=json.dumps(columns),
            problem_type=problem_type,
            algorithm="random_forest",
            status=JobStatus.succeeded,
            hyperparameters_json="{}",
            preprocessing_json="{}",
            feature_columns_json='["a","b"]',
            metrics_config_json="[]",
            resource_json="{}",
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        return job


def test_clone_target_column_override_only():
    source = _seed_succeeded_job(target_column="old_target", target_columns=["old_target"])
    body = build_job_create_from_source(
        source,
        overrides={"target_column": "new_target"},
    )
    assert body.target_column == "new_target"
    assert body.target_columns == ["new_target"]


def test_legacy_retrain_target_column_override_only():
    source = _seed_succeeded_job(target_column="old_target", target_columns=["old_target"])
    body = build_job_create_from_source(
        source,
        default_name_suffix="retrain",
        overrides={"target_column": "new_target"},
    )
    assert body.target_column == "new_target"
    assert body.target_columns == ["new_target"]


def test_clone_target_columns_override_only():
    source = _seed_succeeded_job(
        target_column="price",
        target_columns=["price", "demand"],
        problem_type="regression",
    )
    body = build_job_create_from_source(
        source,
        overrides={"target_columns": ["alpha", "beta"]},
    )
    assert body.target_column == "alpha"
    assert body.target_columns == ["alpha", "beta"]


def test_clone_target_override_mismatch_rejected():
    source = _seed_succeeded_job(target_column="price", target_columns=["price"])
    with pytest.raises(Exception):
        build_job_create_from_source(
            source,
            overrides={"target_column": "alpha", "target_columns": ["beta"]},
        )


def test_multi_output_clone_without_override_keeps_targets():
    source = _seed_succeeded_job(
        target_column="price",
        target_columns=["price", "demand"],
        problem_type="regression",
    )
    body = build_job_create_from_source(source)
    assert body.target_columns == ["price", "demand"]
    assert body.target_column == "price"


def test_retry_keeps_targets(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    create = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "failed-multi",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_columns": ["price", "demand"],
            "problem_type": "regression",
            "algorithm": "ridge",
            "feature_columns": ["a", "b"],
        },
    )
    assert create.status_code == 201
    job_id = create.json()["id"]
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        job.status = JobStatus.failed
        db.commit()
    retry = client.post(
        f"/api/v1/projects/{project_id}/jobs/{job_id}/retry",
        headers=auth_headers,
    )
    assert retry.status_code == 201
    payload = retry.json()
    assert payload["target_columns"] == ["price", "demand"]
    assert payload["target_column"] == "price"


def _run_training(
    csv: bytes,
    *,
    target_columns: list[str],
    test_ratio: float,
    problem_type: str = "regression",
    algorithm: str = "ridge",
    monkeypatch,
    tmp_path,
) -> dict[str, float]:
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=21,
            project_id=1,
            job_name="metrics-test",
            target_column=target_columns[0],
            target_columns=target_columns,
            algorithm=algorithm,
            hyperparameters={},
            csv_bytes=csv,
            experiment_name="exp",
            problem_type=problem_type,
            feature_columns=["a", "b"],
            test_ratio=test_ratio,
            val_ratio=0.2,
            train_ratio=0.8 if test_ratio == 0 else 0.6,
        )
    )
    return result.metrics


def test_single_regression_test_ratio_zero_has_primary_metrics(monkeypatch, tmp_path):
    metrics = _run_training(
        CSV_MULTI,
        target_columns=["price"],
        test_ratio=0,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
    )
    assert "rmse" in metrics
    assert "mae" in metrics
    assert "r2" in metrics
    assert metrics["rmse"] == metrics["val_rmse"]


def test_multi_regression_test_ratio_zero_has_aggregate_metrics(monkeypatch, tmp_path):
    metrics = _run_training(
        CSV_MULTI,
        target_columns=["price", "demand"],
        test_ratio=0,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
    )
    assert "rmse" in metrics
    assert "mae" in metrics
    assert "r2" in metrics
    assert metrics["rmse"] == metrics["val_rmse"]


def test_regression_primary_metrics_prefer_test_when_present(monkeypatch, tmp_path):
    metrics = _run_training(
        CSV_MULTI,
        target_columns=["price"],
        test_ratio=0.2,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
    )
    assert metrics["rmse"] == metrics["test_rmse"]


def test_classification_test_ratio_zero_keeps_primary_accuracy(monkeypatch, tmp_path):
    metrics = _run_training(
        CSV_SINGLE,
        target_columns=["target"],
        test_ratio=0,
        problem_type="classification",
        algorithm="random_forest",
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
    )
    assert "accuracy" in metrics
    assert metrics["accuracy"] == metrics["val_accuracy"]


def test_multi_float_auto_resolves_regression():
    frame = pd.read_csv(pd.io.common.BytesIO(CSV_MULTI))
    assert (
        normalize_problem_type_for_targets("auto", frame, ["price", "demand"])
        == "regression"
    )


def test_multi_low_cardinality_int_auto_rejected():
    frame = pd.read_csv(pd.io.common.BytesIO(CSV_MULTI_BINARY))
    with pytest.raises(ValueError, match="Multi-output classification is not supported"):
        normalize_problem_type_for_targets("auto", frame, ["t1", "t2"])


def test_multi_boolean_auto_rejected():
    frame = pd.read_csv(pd.io.common.BytesIO(CSV_MULTI_BOOL))
    with pytest.raises(ValueError, match="Multi-output classification is not supported"):
        normalize_problem_type_for_targets("auto", frame, ["flag_a", "flag_b"])


def test_multi_boolean_explicit_regression_rejected():
    frame = pd.read_csv(pd.io.common.BytesIO(CSV_MULTI_BOOL))
    with pytest.raises(ValueError, match="cannot be boolean"):
        normalize_problem_type_for_targets("regression", frame, ["flag_a", "flag_b"])


def test_multi_integer_continuous_explicit_regression_allowed():
    frame = pd.read_csv(pd.io.common.BytesIO(CSV_MULTI_INT_CONTINUOUS))
    assert (
        normalize_problem_type_for_targets("regression", frame, ["count_a", "count_b"])
        == "regression"
    )


def test_pipeline_legacy_target_column_validation():
    graph = {
        "nodes": [
            {
                "id": "training-1",
                "data": {
                    "node_type": "training",
                    "config": {"target_column": "price", "algorithm": "ridge"},
                },
            }
        ],
        "edges": [],
    }
    result = pipeline_engine.validate_graph(graph, strict=True)
    assert any("missing required input ports" in err for err in result["errors"])


def test_pipeline_target_columns_multi_output_validation():
    graph = {
        "nodes": [
            {
                "id": "training-1",
                "data": {
                    "node_type": "training",
                    "config": {
                        "target_columns": ["price", "demand"],
                        "algorithm": "ridge",
                    },
                },
            }
        ],
        "edges": [],
    }
    result = pipeline_engine.validate_graph(graph, strict=True)
    assert result["valid"] is False
    assert not any("Target columns must be unique" in err for err in result["errors"])


def test_pipeline_duplicate_targets_rejected():
    graph = {
        "nodes": [
            {
                "id": "training-1",
                "data": {
                    "node_type": "training",
                    "config": {
                        "target_column": "price",
                        "target_columns": ["price", "price"],
                        "algorithm": "ridge",
                    },
                },
            }
        ],
        "edges": [],
    }
    result = pipeline_engine.validate_graph(graph, strict=True)
    assert any("unique" in err.lower() for err in result["errors"])


def test_pipeline_target_mismatch_rejected():
    graph = {
        "nodes": [
            {
                "id": "training-1",
                "data": {
                    "node_type": "training",
                    "config": {
                        "target_column": "price",
                        "target_columns": ["demand"],
                        "algorithm": "ridge",
                    },
                },
            }
        ],
        "edges": [],
    }
    result = pipeline_engine.validate_graph(graph, strict=True)
    assert any("must match" in err for err in result["errors"])


def test_clone_http_target_column_override(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_SINGLE)
    create = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "clone-source",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "algorithm": "random_forest",
        },
    )
    assert create.status_code == 201
    source_id = create.json()["id"]
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, source_id)
        job.status = JobStatus.succeeded
        db.commit()
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source_id}/clone",
        headers=auth_headers,
        json={"overrides": {"target_column": "target"}},
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["target_column"] == "target"
    assert payload["target_columns"] == ["target"]


def test_legacy_retrain_http_target_column_override(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_SINGLE)
    create = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "legacy-source",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "algorithm": "random_forest",
        },
    )
    assert create.status_code == 201
    source_id = create.json()["id"]
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, source_id)
        job.status = JobStatus.succeeded
        db.commit()
    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={
            "source_job_id": source_id,
            "dataset_version_id": version_id,
            "name": "legacy-override",
            "overrides": {"target_column": "target"},
        },
    )
    assert response.status_code == 202, response.text
    job = response.json()["training_job"]
    assert job["target_column"] == "target"
    assert job["target_columns"] == ["target"]


def test_assign_batch_prediction_columns_collision():
    frame = pd.DataFrame({"prediction": [1], "a": [2]})
    with pytest.raises(ValueError, match="prediction"):
        assign_batch_prediction_columns(frame, [3.0], target_columns=None)
    multi = pd.DataFrame({"prediction_demand": [1], "a": [2]})
    with pytest.raises(ValueError, match="prediction_demand"):
        assign_batch_prediction_columns(
            multi,
            [{"price": 1.0, "demand": 2.0}],
            target_columns=["price", "demand"],
        )


def test_serialize_single_1d_output():
    assert serialize_predictions(np.array([1.2, 3.4]), target_columns=["price"]) == [1.2, 3.4]


def test_serialize_single_n1_output():
    assert serialize_predictions(
        np.array([[1.2], [3.4]]),
        target_columns=["price"],
    ) == [1.2, 3.4]


def test_serialize_known_multi_output_width_mismatch():
    with pytest.raises(ValueError, match="does not match"):
        serialize_predictions(
            np.array([[1.2, 3.4, 5.6]]),
            target_columns=["price", "demand"],
        )


def test_serialize_generic_2d_fallback_without_targets():
    assert serialize_predictions(np.array([[1.2, 3.4], [5.6, 7.8]])) == [[1.2, 3.4], [5.6, 7.8]]
