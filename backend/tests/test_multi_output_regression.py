from __future__ import annotations

import json
import secrets

import numpy as np
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
from app.services.prediction_serialization import serialize_predictions
from app.services.target_columns import (
    canonicalize_job_targets,
    effective_target_columns_from_job,
    loads_target_columns_json,
)
from app.services.training import SklearnTrainingRunner, TrainingJobContext
from app.workers import runner

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
CSV_MULTI_NULL = (
    b"a,b,price,demand\n"
    b"1,2,10.0,5.0\n2,3,11.0,\n3,4,12.0,7.0\n4,5,13.0,8.0\n5,6,14.0,9.0\n"
    b"6,7,15.0,10.0\n7,8,16.0,11.0\n8,9,17.0,12.0\n9,1,18.0,13.0\n10,2,19.0,14.0\n"
)


@pytest.fixture(autouse=True)
def setup_multi_output_tests(monkeypatch):
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
        project = Project(name="multi-output-project", created_by=admin.id)
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
        return db.scalar(select(Project.id).where(Project.name == "multi-output-project"))


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


def _create_job(client, auth_headers, project_id, dataset_id, version_id, **extra):
    body = {
        "name": extra.pop("name", "baseline"),
        "dataset_id": dataset_id,
        "dataset_version_id": version_id,
        "feature_columns": ["a", "b"],
        **extra,
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=body,
    )
    return response


def test_canonicalize_job_targets_helpers():
    primary, effective = canonicalize_job_targets("price", ["price", "demand"])
    assert primary == "price"
    assert effective == ["price", "demand"]
    with pytest.raises(Exception):
        canonicalize_job_targets("price", ["demand"])


def test_legacy_target_column_create(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_SINGLE)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_column="target",
        algorithm="random_forest",
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["target_column"] == "target"
    assert payload["target_columns"] == ["target"]


def test_target_columns_create(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_columns=["price", "demand"],
        algorithm="ridge",
        problem_type="regression",
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["target_column"] == "price"
    assert payload["target_columns"] == ["price", "demand"]


def test_target_mismatch_rejected(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_column="price",
        target_columns=["demand"],
        algorithm="ridge",
        problem_type="regression",
    )
    assert response.status_code == 422


def test_duplicate_targets_rejected(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_columns=["price", "price"],
        algorithm="ridge",
        problem_type="regression",
    )
    assert response.status_code == 422


def test_feature_target_overlap_rejected(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_columns=["price", "demand"],
        feature_columns=["a", "price"],
        algorithm="ridge",
        problem_type="regression",
    )
    assert response.status_code == 422


def test_multi_output_classification_rejected(client, auth_headers, project_id):
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_columns=["price", "demand"],
        problem_type="classification",
        algorithm="random_forest",
    )
    assert response.status_code == 422


def test_existing_row_target_columns_json_fallback():
    with TestingSessionLocal() as db:
        job = TrainingJob(
            project_id=1,
            dataset_id=1,
            name="legacy",
            target_column="price",
            target_columns_json="[]",
            algorithm="ridge",
            status=JobStatus.pending,
        )
        db.add(job)
        db.flush()
        assert effective_target_columns_from_job(job) == ["price"]
        assert loads_target_columns_json(job.target_columns_json) == []


@pytest.mark.parametrize(
    "algorithm",
    ["ridge", "random_forest_regressor", "gradient_boosting_regressor"],
)
def test_multi_output_training_algorithms(
    client, auth_headers, project_id, monkeypatch, tmp_path, algorithm
):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    response = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_columns=["price", "demand"],
        algorithm=algorithm,
        problem_type="regression",
    )
    assert response.status_code == 201, response.text
    job_id = response.json()["id"]
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    runner.process_job(type("Claim", (), {"id": job_id})())
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        assert job.status == JobStatus.succeeded, job.error_message
        metrics = json.loads(job.metrics_json or "{}")
        assert "rmse" in metrics
        assert "val_target_0_rmse" in metrics
        assert job.target_columns_json
        assert json.loads(job.target_columns_json) == ["price", "demand"]


def test_multi_output_training_drops_null_rows(monkeypatch, tmp_path):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=11,
            project_id=1,
            job_name="null-drop",
            target_column="price",
            target_columns=["price", "demand"],
            algorithm="ridge",
            hyperparameters={},
            csv_bytes=CSV_MULTI_NULL,
            experiment_name="exp",
            problem_type="regression",
            feature_columns=["a", "b"],
        )
    )
    assert result.mlflow_run_id
    assert result.params["output_count"] == "2"
    assert result.params["target_columns"] == '["price", "demand"]'


def test_serialize_predictions_contract():
    single = serialize_predictions(np.array([1.2, 3.4]), target_columns=None)
    assert single == [1.2, 3.4]
    multi = serialize_predictions(
        np.array([[1.2, 3.4], [5.6, 7.8]]),
        target_columns=["price", "demand"],
    )
    assert multi == [{"price": 1.2, "demand": 3.4}, {"price": 5.6, "demand": 7.8}]


def test_retrain_inherits_target_columns(client, auth_headers, project_id, monkeypatch, tmp_path):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    dataset_id, version_id = _upload(client, auth_headers, project_id, CSV_MULTI)
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_columns=["price", "demand"],
        algorithm="ridge",
        problem_type="regression",
    ).json()
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, source["id"])
        job.status = JobStatus.succeeded
        db.commit()
    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "retrained"},
    )
    assert retrain.status_code == 201, retrain.text
    payload = retrain.json()
    assert payload["target_columns"] == ["price", "demand"]
    assert payload["retrain_source_job_id"] == source["id"]
