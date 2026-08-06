from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, ModelLifecycle, ModelVersion, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference, mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_PASSWORD = secrets.token_urlsafe(24)
ADMIN_EMAIL = "rbac-admin@example.com"


@pytest.fixture(autouse=True)
def setup_rbac(monkeypatch):
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
    monkeypatch.setattr(
        mlflow_service,
        "ensure_experiment",
        lambda name: f"experiment-{name.removeprefix('project-')}",
    )
    with TestingSessionLocal() as db:
        db.add(
            User(
                email=ADMIN_EMAIL,
                full_name="RBAC System Admin",
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


def login(client: TestClient, email: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": TEST_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def world(client: TestClient):
    admin_headers = login(client, ADMIN_EMAIL)
    users: dict[str, dict] = {}
    for role in ("PROJECT_ADMIN", "ML_ENGINEER", "DATA_SCIENTIST", "VIEWER"):
        email = f"{role.lower()}@example.com"
        response = client.post(
            "/api/v1/users",
            headers=admin_headers,
            json={
                "email": email,
                "password": TEST_PASSWORD,
                "full_name": role.replace("_", " ").title(),
            },
        )
        assert response.status_code == 201, response.text
        users[role] = response.json()

    project_a = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": "RBAC Project A"},
    ).json()
    project_b = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": "RBAC Project B"},
    ).json()

    for role, user in users.items():
        response = client.post(
            f"/api/v1/projects/{project_a['id']}/members",
            headers=admin_headers,
            json={"user_id": user["id"], "role": role},
        )
        assert response.status_code == 201, response.text

    csv = b"feature,target\n1,0\n2,1\n"
    dataset_a = client.post(
        f"/api/v1/projects/{project_a['id']}/datasets",
        headers=admin_headers,
        files={"file": ("a.csv", csv, "text/csv")},
    ).json()
    dataset_b = client.post(
        f"/api/v1/projects/{project_b['id']}/datasets",
        headers=admin_headers,
        files={"file": ("b.csv", csv, "text/csv")},
    ).json()

    return {
        "admin_headers": admin_headers,
        "users": users,
        "headers": {
            role: login(client, user["email"]) for role, user in users.items()
        },
        "project_a": project_a,
        "project_b": project_b,
        "dataset_a": dataset_a,
        "dataset_b": dataset_b,
    }


def test_cross_project_access_is_forbidden_and_resource_binding_is_not_found(
    client, world
):
    viewer_headers = world["headers"]["VIEWER"]
    project_a_id = world["project_a"]["id"]
    project_b_id = world["project_b"]["id"]

    non_member = client.get(
        f"/api/v1/projects/{project_b_id}/datasets",
        headers=viewer_headers,
    )
    assert non_member.status_code == 403

    wrong_project_resource = client.get(
        f"/api/v1/projects/{project_a_id}/datasets/{world['dataset_b']['id']}",
        headers=viewer_headers,
    )
    assert wrong_project_resource.status_code == 404


def test_viewer_is_read_only_and_denial_is_audited(client, world):
    project_id = world["project_a"]["id"]
    viewer = world["users"]["VIEWER"]
    viewer_headers = world["headers"]["VIEWER"]

    assert (
        client.get(
            f"/api/v1/projects/{project_id}/datasets",
            headers=viewer_headers,
        ).status_code
        == 200
    )
    denied = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=viewer_headers,
        files={"file": ("denied.csv", b"x,target\n1,0\n", "text/csv")},
    )
    assert denied.status_code == 403

    audit = client.get(
        "/api/v1/admin/audit?action=authorization.denied",
        headers=world["admin_headers"],
    )
    assert audit.status_code == 200
    denial = next(row for row in audit.json() if row["user_id"] == viewer["id"])
    assert denial["success"] is False
    assert denial["resource_id"] == str(project_id)
    assert denial["failure_reason"] == "project_permission_required"
    assert denial["after"]["required_permission"] == "data:write"


def test_data_scientist_can_train_but_cannot_approve(client, world):
    project_id = world["project_a"]["id"]
    headers = world["headers"]["DATA_SCIENTIST"]
    dataset = world["dataset_a"]

    job = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=headers,
        json={
            "name": "data-scientist-job",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "feature_columns": ["feature"],
            "algorithm": "random_forest",
            "hyperparameters": {"n_estimators": 10, "max_depth": 3},
        },
    )
    assert job.status_code == 201, job.text

    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name="approval-test",
            version="1",
            lifecycle=ModelLifecycle.PENDING_APPROVAL,
            mlflow_model_name=f"project-{project_id}-approval-test",
            mlflow_version="1",
            mlflow_run_id="run-approval",
            model_uri=f"models:/project-{project_id}-approval-test/1",
            gates_passed=True,
            gate_results_json=json.dumps(
                {"passed": True, "computed_by": "server", "gate_version": "1"}
            ),
        )
        db.add(model)
        db.commit()
        db.refresh(model)
        model_id = model.id

    denied = client.post(
        f"/api/v1/projects/{project_id}/models/{model_id}/approve",
        headers=headers,
        json={"comment": "not authorized"},
    )
    assert denied.status_code == 403


def test_ml_engineer_can_register_and_create_endpoint(
    client, world, monkeypatch
):
    project_id = world["project_a"]["id"]
    headers = world["headers"]["ML_ENGINEER"]
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": f"experiment-{project_id}",
            "metrics": {"accuracy": 0.9},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "1"},
    )

    def pass_gates(db, row, *, actor_id=None, **_):
        summary = {
            "passed": True,
            "computed_by": "server",
            "gate_version": "1",
            "results": [],
        }
        row.gates_passed = True
        row.gate_results_json = json.dumps(summary)
        return summary

    monkeypatch.setattr(registry_service, "evaluate_gates", pass_gates)
    registered = client.post(
        f"/api/v1/projects/{project_id}/models/register",
        headers=headers,
        json={
            "name": "engineer-model",
            "run_id": "engineer-run",
            "metadata": {"feature_schema": ["feature"]},
        },
    )
    assert registered.status_code == 201, registered.text

    with TestingSessionLocal() as db:
        model = db.get(ModelVersion, registered.json()["id"])
        assert model is not None
        model.lifecycle = ModelLifecycle.APPROVED
        db.commit()

    monkeypatch.setattr(inference, "load_model", lambda uri: object())
    endpoint = client.post(
        f"/api/v1/projects/{project_id}/endpoints",
        headers=headers,
        json={
            "name": "engineer-endpoint",
            "model_version_id": registered.json()["id"],
        },
    )
    assert endpoint.status_code == 201, endpoint.text
    assert endpoint.json()["status"] == "ready"


def test_project_admin_manages_members_and_system_admin_bypasses_membership(
    client, world
):
    project_a_id = world["project_a"]["id"]
    project_b_id = world["project_b"]["id"]
    project_admin_headers = world["headers"]["PROJECT_ADMIN"]

    members = client.get(
        f"/api/v1/projects/{project_a_id}/members",
        headers=project_admin_headers,
    )
    assert members.status_code == 200
    assert {row["role"] for row in members.json()} >= {
        "PROJECT_ADMIN",
        "ML_ENGINEER",
        "DATA_SCIENTIST",
        "VIEWER",
    }

    extra = client.post(
        "/api/v1/users",
        headers=world["admin_headers"],
        json={
            "email": "extra-member@example.com",
            "password": TEST_PASSWORD,
            "full_name": "Extra Member",
        },
    ).json()
    added = client.post(
        f"/api/v1/projects/{project_a_id}/members",
        headers=project_admin_headers,
        json={"user_id": extra["id"], "role": "VIEWER"},
    )
    assert added.status_code == 201

    assert (
        client.get(
            f"/api/v1/projects/{project_b_id}",
            headers=world["admin_headers"],
        ).status_code
        == 200
    )
    assert (
        client.get("/api/v1/users", headers=world["admin_headers"]).status_code
        == 200
    )


def test_inactive_user_token_is_denied(client, world):
    viewer = world["users"]["VIEWER"]
    token_headers = world["headers"]["VIEWER"]
    deactivated = client.post(
        f"/api/v1/users/{viewer['id']}/deactivate",
        headers=world["admin_headers"],
    )
    assert deactivated.status_code == 200

    denied = client.get("/api/v1/auth/me", headers=token_headers)
    assert denied.status_code == 403
    assert "inactive" in denied.json()["detail"].lower()
