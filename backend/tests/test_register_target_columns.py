from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    Dataset,
    DatasetVersion,
    JobStatus,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_register_targets(monkeypatch):
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
    def fake_evaluate(db, row, *, actor_id=None, **_):
        summary = {
            "passed": True,
            "computed_by": "server",
            "gate_version": "1",
            "evaluated_at": "2026-07-31T00:00:00+00:00",
            "results": [],
        }
        row.gates_passed = True
        row.gate_results_json = json.dumps(summary)
        return summary

    monkeypatch.setattr(registry_service, "evaluate_gates", fake_evaluate)
    with TestingSessionLocal() as db:
        db.add(
            User(
                email="admin@example.com",
                full_name="Admin",
                password_hash=hash_password(TEST_ADMIN_PASSWORD),
                is_active=True,
                is_system_admin=True,
            )
        )
        db.commit()
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": TEST_ADMIN_PASSWORD},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def project_id(client, auth_headers):
    response = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "register-targets"},
    )
    assert response.status_code == 201
    return response.json()["id"]


def _seed_job(
    *,
    project_id: int,
    run_id: str,
    target_column: str,
    target_columns: list[str],
) -> TrainingJob:
    with TestingSessionLocal() as db:
        dataset = Dataset(
            project_id=project_id,
            name="targets",
            description="",
            object_key="datasets/targets.csv",
        )
        db.add(dataset)
        db.flush()
        version = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project_id,
            version=1,
            object_key="datasets/targets/v1.csv",
            original_filename="targets.csv",
            row_count=10,
            column_count=4,
            columns_json=json.dumps(["a", "b", *target_columns]),
            dtypes_json=json.dumps({name: "float64" for name in ["a", "b", *target_columns]}),
            preview_json=json.dumps([]),
        )
        db.add(version)
        db.flush()
        job = TrainingJob(
            project_id=project_id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="multi-job",
            target_column=target_column,
            target_columns_json=json.dumps(target_columns),
            problem_type="regression",
            algorithm="ridge",
            feature_columns_json=json.dumps(["a", "b"]),
            status=JobStatus.succeeded,
            mlflow_run_id=run_id,
            model_uri=f"runs:/{run_id}/model",
            metrics_json=json.dumps({"rmse": 0.2}),
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        return job


def test_register_from_training_job_preserves_multi_output_targets(
    client, auth_headers, project_id, monkeypatch
):
    job = _seed_job(
        project_id=project_id,
        run_id="run-multi-job",
        target_column="cooling_load",
        target_columns=["cooling_load", "power_usage"],
    )
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "params": {
                "features": "a,b",
                "problem_type": "regression",
                "target_columns": '["cooling_load","power_usage"]',
                "job_id": str(job.id),
            },
            "metrics": {"rmse": 0.2},
            "tags": {},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "1"},
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/models/register",
        headers=auth_headers,
        json={
            "name": "multi-output-model",
            "training_job_id": job.id,
        },
    )
    assert response.status_code == 201, response.text
    metadata = response.json()["metadata"]
    assert metadata["target_columns"] == ["cooling_load", "power_usage"]
    assert metadata["multi_output"] is True
    assert [field["name"] for field in metadata["output_schema"]] == [
        "cooling_load",
        "power_usage",
    ]


def test_register_from_run_id_resolves_job_and_preserves_targets(
    client, auth_headers, project_id, monkeypatch
):
    job = _seed_job(
        project_id=project_id,
        run_id="run-resolve-job",
        target_column="cooling_load",
        target_columns=["cooling_load", "power_usage"],
    )
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "params": {
                "features": "a,b",
                "problem_type": "regression",
                "target_columns": '["cooling_load","power_usage"]',
                "job_id": str(job.id),
            },
            "metrics": {"rmse": 0.25},
            "tags": {},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "2"},
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/models/register",
        headers=auth_headers,
        json={
            "name": "resolved-multi-output",
            "run_id": "run-resolve-job",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["training_job_id"] == job.id
    assert body["metadata"]["target_columns"] == ["cooling_load", "power_usage"]


def test_register_single_target_backward_compatible(
    client, auth_headers, project_id, monkeypatch
):
    job = _seed_job(
        project_id=project_id,
        run_id="run-single",
        target_column="target",
        target_columns=["target"],
    )
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "params": {
                "features": "a,b",
                "problem_type": "classification",
                "target_columns": '["target"]',
                "job_id": str(job.id),
            },
            "metrics": {"accuracy": 0.9},
            "tags": {},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "1"},
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/models/register",
        headers=auth_headers,
        json={
            "name": "single-target-model",
            "training_job_id": job.id,
        },
    )
    assert response.status_code == 201, response.text
    metadata = response.json()["metadata"]
    assert metadata["target_columns"] == ["target"]
    assert metadata["multi_output"] is False
