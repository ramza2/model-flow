from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import Base, ModelLifecycle, ModelVersion, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.schemas.v1 import ModelRegisterRequest
from app.services import inference, mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}


@pytest.fixture(autouse=True)
def setup_v1(monkeypatch):
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
        lambda bucket,
        key,
        data,
        content_type="application/octet-stream": OBJECT_STORE.__setitem__(
            (bucket, key), data
        ),
    )
    monkeypatch.setattr(
        storage,
        "download_bytes",
        lambda bucket, key: OBJECT_STORE[(bucket, key)],
    )
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    with TestingSessionLocal() as db:
        db.add(
            User(
                email="admin@example.com",
                full_name="Admin",
                password_hash=hash_password("password123"),
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
        json={"email": "admin@example.com", "password": "password123"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_v1_health_auth_and_security_headers(client, auth_headers):
    health = client.get("/api/v1/health")
    assert health.status_code == 200
    assert health.json()["version"] == "1.0.0-rc"
    assert health.headers["x-content-type-options"] == "nosniff"
    assert health.headers["x-frame-options"] == "DENY"
    assert health.headers["x-request-id"]

    me = client.get("/api/v1/auth/me", headers=auth_headers)
    assert me.status_code == 200
    assert me.json()["email"] == "admin@example.com"

    unauthenticated = client.get("/api/v1/projects")
    assert unauthenticated.status_code == 401
    assert set(unauthenticated.json()) == {"detail", "hint"}


def test_logout_revokes_token(client, auth_headers):
    assert client.get("/api/v1/auth/me", headers=auth_headers).status_code == 200

    logout = client.post("/api/v1/auth/logout", headers=auth_headers)
    assert logout.status_code == 200
    assert "all access tokens" in logout.json()["hint"].lower()

    revoked = client.get("/api/v1/auth/me", headers=auth_headers)
    assert revoked.status_code == 401
    assert revoked.json()["detail"] == "Token has been revoked."


def test_login_accepts_local_bootstrap_email_format(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@modelflow.local", "password": "not-the-password"},
    )
    assert response.status_code == 401


def test_login_lockout(client, monkeypatch):
    monkeypatch.setattr(settings, "login_max_failures", 2)
    monkeypatch.setattr(settings, "login_lockout_minutes", 5)
    payload = {"email": "admin@example.com", "password": "wrong"}
    assert client.post("/api/v1/auth/login", json=payload).status_code == 401
    assert client.post("/api/v1/auth/login", json=payload).status_code == 401
    locked = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": "password123"},
    )
    assert locked.status_code == 423
    assert "temporarily locked" in locked.json()["detail"]


def test_dataset_versions_quality_split_job_and_pipeline(
    client,
    auth_headers,
):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "v1-test"},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]
    csv = b"a,b,target\n1,2,0\n2,3,0\n3,4,1\n4,5,1\n5,6,1\n6,7,0\n"
    first = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("sample.csv", csv, "text/csv")},
    )
    second = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("sample.csv", csv + b"7,8,1\n", "text/csv")},
    )
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["latest_version"] == 2
    dataset_id = first.json()["id"]
    dataset_version_id = first.json()["version"]["id"]

    rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "target-present",
            "rules": [{"type": "not_null", "column": "target"}],
        },
    )
    check = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{dataset_version_id}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": rule.json()["id"]},
    )
    assert check.status_code == 201
    assert check.json()["result"] == "PASS"

    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{dataset_version_id}/splits",
        headers=auth_headers,
        json={},
    )
    assert split.status_code == 201
    job = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "train",
            "dataset_id": dataset_id,
            "dataset_version_id": dataset_version_id,
            "split_id": split.json()["id"],
            "target_column": "target",
        },
    )
    assert job.status_code == 201
    assert job.json()["status"] == "pending"

    pipeline = client.post(
        f"/api/v1/projects/{project_id}/pipelines",
        headers=auth_headers,
        json={
            "name": "pipeline",
            "graph": {
                "nodes": [{"id": "load"}, {"id": "train"}],
                "edges": [{"source": "load", "target": "train"}],
            },
        },
    )
    assert pipeline.status_code == 201
    invalid = client.post(
        f"/api/v1/projects/{project_id}/pipelines/{pipeline.json()['id']}/versions",
        headers=auth_headers,
        json={
            "graph": {
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [
                    {"source": "a", "target": "b"},
                    {"source": "b", "target": "a"},
                ],
            }
        },
    )
    assert invalid.status_code == 400
    assert "cycle" in invalid.json()["hint"]


def test_register_rejects_client_gates_and_runs_server_evaluation(
    client, auth_headers, monkeypatch
):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "registry-test"},
    ).json()

    assert "gates_passed" not in ModelRegisterRequest.model_fields
    assert "gate_results" not in ModelRegisterRequest.model_fields
    rejected = client.post(
        f"/api/v1/projects/{project['id']}/models/register",
        headers=auth_headers,
        json={
            "name": "classifier",
            "run_id": "run-1",
            "gates_passed": True,
            "gate_results": {"passed": True, "computed_by": "client"},
        },
    )
    assert rejected.status_code == 422

    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "metrics": {"accuracy": 0.9},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "1"},
    )
    evaluated: list[int] = []

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
        evaluated.append(row.id)
        return summary

    monkeypatch.setattr(registry_service, "evaluate_gates", fake_evaluate)
    registered = client.post(
        f"/api/v1/projects/{project['id']}/models/register",
        headers=auth_headers,
        json={
            "name": "classifier",
            "run_id": "run-1",
            "metadata": {"feature_schema": ["feature"]},
        },
    )
    assert registered.status_code == 201
    assert registered.json()["gates_passed"] is True
    assert registered.json()["gate_results"]["computed_by"] == "server"
    assert evaluated == [registered.json()["id"]]


def test_server_evaluate_gates_computes_required_checks(
    client, auth_headers, monkeypatch
):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "gate-evaluation-test"},
    ).json()

    class LoadedModel:
        def predict(self, frame):
            assert frame.to_dict(orient="records") == [{"feature": 1.25}]
            return [1]

    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(inference, "load_model", lambda uri: LoadedModel())

    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project["id"],
            name="classifier",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project['id']}-classifier",
            mlflow_version="1",
            mlflow_run_id="run-1",
            model_uri=f"models:/project-{project['id']}-classifier/1",
            metrics_json=json.dumps({"accuracy": 0.9}),
            metadata_json=json.dumps(
                {
                    "artifact_path": "model",
                    "feature_schema": [
                        {"name": "feature", "dtype": "float", "example": 1.25}
                    ],
                }
            ),
        )
        db.add(model)
        db.flush()

        summary = registry_service.evaluate_gates(db, model)

        assert summary["passed"] is True
        assert summary["computed_by"] == "server"
        assert summary["gate_version"] == "1"
        assert {result["type"] for result in summary["results"]} == {
            "mlflow_project",
            "artifact_exists",
            "load_model",
            "schema_present",
            "test_inference",
            "metric_threshold",
            "inference_latency",
        }
        assert model.gates_passed is True
        assert model.lifecycle == ModelLifecycle.CANDIDATE


def test_approve_requires_server_gates(client, auth_headers, monkeypatch):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "approval-test"},
    ).json()
    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project["id"],
            name="classifier",
            version="1",
            lifecycle=ModelLifecycle.PENDING_APPROVAL,
            mlflow_model_name=f"project-{project['id']}-classifier",
            mlflow_version="1",
            model_uri=f"models:/project-{project['id']}-classifier/1",
            gates_passed=True,
            gate_results_json=json.dumps(
                {"passed": True, "computed_by": "client", "gate_version": "1"}
            ),
        )
        db.add(model)
        db.commit()
        db.refresh(model)
        model_id = model.id

    blocked = client.post(
        f"/api/v1/projects/{project['id']}/models/{model_id}/approve",
        headers=auth_headers,
        json={"comment": "reviewed"},
    )
    assert blocked.status_code == 409
    assert "server evaluation" in blocked.json()["detail"].lower()

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
    evaluated = client.post(
        f"/api/v1/projects/{project['id']}/models/{model_id}/evaluate-gates",
        headers=auth_headers,
    )
    assert evaluated.status_code == 200
    assert evaluated.json()["gate_results"]["computed_by"] == "server"

    approved = client.post(
        f"/api/v1/projects/{project['id']}/models/{model_id}/approve",
        headers=auth_headers,
        json={"comment": "reviewed"},
    )
    assert approved.status_code == 200
    assert approved.json()["lifecycle"] == "APPROVED"
