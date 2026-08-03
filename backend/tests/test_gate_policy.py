"""Server-managed Model Gate Policy — clients cannot override criteria."""

from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, ModelVersion, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference, mlflow_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_PASSWORD = secrets.token_urlsafe(24)
ADMIN_EMAIL = "gate-admin@example.com"


@pytest.fixture(autouse=True)
def setup_gate_policy(monkeypatch):
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
                email=ADMIN_EMAIL,
                full_name="Gate Admin",
                password_hash=hash_password(TEST_PASSWORD),
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
        json={"email": ADMIN_EMAIL, "password": TEST_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _project(client, headers) -> int:
    return client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": f"Gate Policy {secrets.token_hex(4)}", "description": "policy"},
    ).json()["id"]


def _relax_policy(client, headers, project_id: int, **extra) -> dict:
    payload = {
        "require_artifact": False,
        "require_schema": False,
        "require_model_load": False,
        "require_test_inference": False,
        "require_mlflow_project": False,
        "metric_name": "accuracy",
        "metric_minimum": 0.5,
        **extra,
    }
    response = client.patch(
        f"/api/v1/projects/{project_id}/gate-policies/active",
        headers=headers,
        json=payload,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _register(
    client,
    headers,
    project_id: int,
    monkeypatch,
    *,
    accuracy: float = 0.95,
    metadata: dict | None = None,
    expect_status: int = 201,
):
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "metrics": {"accuracy": accuracy, "f1": accuracy},
            "params": {"problem_type": "classification", "features": "a"},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "1"},
    )
    monkeypatch.setattr(
        inference,
        "load_model",
        lambda uri: type("M", (), {"predict": staticmethod(lambda frame: [0])})(),
    )
    body = {
        "name": f"gated-{secrets.token_hex(3)}",
        "run_id": f"run-{secrets.token_hex(4)}",
        "metadata": metadata
        if metadata is not None
        else {"feature_schema": [{"name": "a", "dtype": "float", "example": 1.0}]},
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/models/register",
        headers=headers,
        json=body,
    )
    assert response.status_code == expect_status, response.text
    return response


def test_metadata_gates_rejected_with_422(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers)
    for payload in (
        {"gates": {"accuracy": {"min": 0.01}}},
        {"test_instance": {"a": 1}},
        {"metric_threshold": 0.01},
        {"max_inference_latency_ms": 99999},
    ):
        response = _register(
            client,
            auth_headers,
            project_id,
            monkeypatch,
            metadata=payload,
            expect_status=422,
        )
        assert "gate" in response.text.lower() or "forbidden" in response.text.lower()


def test_pipeline_node_arbitrary_gates_rejected_on_save(client, auth_headers):
    project_id = _project(client, auth_headers)
    pipeline_id = client.post(
        f"/api/v1/projects/{project_id}/pipelines",
        headers=auth_headers,
        json={
            "name": "gate-bypass",
            "description": "",
            "graph": {"nodes": [{"id": "n1", "type": "dataset_load", "data": {}}], "edges": []},
        },
    ).json()["id"]
    graph = {
        "nodes": [
            {
                "id": "a",
                "type": "approval_request",
                "position": {"x": 0, "y": 0},
                "data": {
                    "label": "Approve",
                    "config": {"gates": {"accuracy": {"min": 0.01}}},
                },
            }
        ],
        "edges": [],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/pipelines/{pipeline_id}/versions",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert response.status_code == 400
    assert "gate" in response.text.lower() or "forbidden" in response.text.lower()


def test_low_metric_fails_regardless_of_client_intent(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers)
    _relax_policy(client, auth_headers, project_id)
    response = _register(
        client,
        auth_headers,
        project_id,
        monkeypatch,
        accuracy=0.1,
        metadata={"note": "please pass", "feature_schema": [{"name": "a"}]},
    )
    body = response.json()
    assert body["gates_passed"] is False
    results = body["gate_results"]
    assert results["computed_by"] == "server"
    assert results["policy_id"]
    assert results["policy_version"] >= 1
    assert any(
        g["type"] == "metric_threshold" and g["passed"] is False
        for g in results["results"]
    )


def test_project_admin_policy_change_applies_to_new_evaluation(
    client, auth_headers, monkeypatch
):
    project_id = _project(client, auth_headers)
    active = client.get(
        f"/api/v1/projects/{project_id}/gate-policies/active", headers=auth_headers
    ).json()
    assert active["version"] == 1

    updated = _relax_policy(
        client,
        auth_headers,
        project_id,
        metric_name="accuracy",
        metric_minimum=0.99,
    )
    assert updated["version"] == 2
    assert updated["metric_minimum"] == 0.99

    response = _register(
        client, auth_headers, project_id, monkeypatch, accuracy=0.95
    )
    assert response.json()["gates_passed"] is False
    results = response.json()["gate_results"]
    assert results["policy_version"] == 2
    assert results["computed_by"] == "server"


def test_non_admin_roles_cannot_update_gate_policy(client, auth_headers):
    project_id = _project(client, auth_headers)

    for role in ("VIEWER", "DATA_SCIENTIST", "ML_ENGINEER"):
        email = f"{role.lower()}-{secrets.token_hex(2)}@example.com"
        created = client.post(
            "/api/v1/users",
            headers=auth_headers,
            json={
                "email": email,
                "password": TEST_PASSWORD,
                "full_name": role,
            },
        )
        assert created.status_code == 201, created.text
        member = client.post(
            f"/api/v1/projects/{project_id}/members",
            headers=auth_headers,
            json={"user_id": created.json()["id"], "role": role},
        )
        assert member.status_code == 201, member.text
        login = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": TEST_PASSWORD},
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        response = client.patch(
            f"/api/v1/projects/{project_id}/gate-policies/active",
            headers=headers,
            json={"metric_minimum": 0.01},
        )
        assert response.status_code == 403, response.text


def test_cross_project_gate_policy_reference_rejected(client, auth_headers):
    project_a = _project(client, auth_headers)
    project_b = _project(client, auth_headers)
    policy_b = client.get(
        f"/api/v1/projects/{project_b}/gate-policies/active", headers=auth_headers
    ).json()

    pipeline_id = client.post(
        f"/api/v1/projects/{project_a}/pipelines",
        headers=auth_headers,
        json={
            "name": "cross-policy",
            "description": "",
            "graph": {
                "nodes": [{"id": "n1", "type": "dataset_load", "data": {}}],
                "edges": [],
            },
        },
    ).json()["id"]
    graph = {
        "nodes": [
            {
                "id": "a",
                "type": "approval_request",
                "position": {"x": 0, "y": 0},
                "data": {
                    "label": "Approve",
                    "config": {"gate_policy_id": policy_b["id"]},
                },
            }
        ],
        "edges": [],
    }
    response = client.post(
        f"/api/v1/projects/{project_a}/pipelines/{pipeline_id}/versions",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert response.status_code == 400
    assert "another project" in response.text.lower() or "gate" in response.text.lower()


def test_evaluate_gates_records_policy_provenance(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers)
    _relax_policy(client, auth_headers, project_id, metric_minimum=0.5)
    model = _register(client, auth_headers, project_id, monkeypatch, accuracy=0.95).json()
    response = client.post(
        f"/api/v1/projects/{project_id}/models/{model['id']}/evaluate-gates",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    results = response.json()["gate_results"]
    assert results["policy_id"]
    assert results["policy_version"] >= 1
    assert results["computed_by"] == "server"


def test_pipeline_execution_rejects_inline_gates(client, auth_headers, monkeypatch):
    """Even if a graph somehow stored gates, execution must refuse."""
    from app.db.models import JobStatus, PipelineRun
    from app.services.pipeline_engine import _execute_node

    project_id = _project(client, auth_headers)
    _relax_policy(client, auth_headers, project_id)
    model = _register(
        client, auth_headers, project_id, monkeypatch, accuracy=0.95
    ).json()

    with TestingSessionLocal() as db:
        row = db.get(ModelVersion, model["id"])
        assert row is not None
        run = PipelineRun(
            project_id=project_id,
            pipeline_id=1,
            pipeline_version_id=1,
            status=JobStatus.running,
            parameters_json="{}",
            node_states_json="{}",
            created_by=1,
        )
        db.add(run)
        db.flush()
        with pytest.raises(ValueError, match="gate criteria"):
            _execute_node(
                db,
                run,
                "approval_request",
                {"gates": {"accuracy": {"min": 0.01}}},
                {"model_version": row},
            )
