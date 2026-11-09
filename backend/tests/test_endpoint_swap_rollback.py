"""Endpoint model swap / rollback regressions (RBAC, confirmable flow, failures)."""

from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, ModelLifecycle, ModelVersion, ProjectMembership, ProjectRole, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference_client, mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
TEST_PASSWORD = secrets.token_urlsafe(24)
ADMIN_EMAIL = "swap-admin@example.com"
VIEWER_EMAIL = "swap-viewer@example.com"
ENGINEER_EMAIL = "swap-engineer@example.com"


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(engine)
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
        lambda bucket, key, data, content_type="application/octet-stream": None,
    )
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        registry_service,
        "_mlflow_logged_feature_schema",
        lambda run_id: [],
    )
    with TestingSessionLocal() as db:
        db.add(
            User(
                email=ADMIN_EMAIL,
                full_name="Admin",
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


def _login(client: TestClient, email: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": TEST_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def auth_headers(client):
    return _login(client, ADMIN_EMAIL)


def _seed_model(
    project_id: int,
    *,
    name: str = "clf",
    version: str = "1",
    lifecycle: ModelLifecycle = ModelLifecycle.APPROVED,
) -> int:
    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name=name,
            version=version,
            lifecycle=lifecycle,
            mlflow_model_name=f"project-{project_id}-{name}",
            mlflow_version=version,
            model_uri=f"models:/project-{project_id}-{name}/{version}",
            metadata_json=json.dumps(
                {"feature_schema": [{"name": "x", "dtype": "float"}]}
            ),
            metrics_json=json.dumps({"accuracy": 0.9}),
            gates_passed=True,
        )
        db.add(model)
        db.commit()
        db.refresh(model)
        return model.id


def _create_project_and_endpoint(client, auth_headers, monkeypatch, name: str = "ep"):
    monkeypatch.setattr(
        inference_client,
        "check_model_loadable",
        lambda uri: {"ok": True, "input_features": []},
    )
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": name},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["id"]
    model_id = _seed_model(project_id, name="base", version="1")
    created = client.post(
        f"/api/v1/projects/{project_id}/endpoints",
        headers=auth_headers,
        json={
            "name": "serving",
            "model_version_id": model_id,
            "feature_schema": [{"name": "x", "dtype": "float"}],
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["previous_model_version"] is None
    assert body["previous_model_uri"] is None
    assert body["can_rollback"] is False
    return project_id, body, model_id


def _add_member(project_id: int, email: str, role: ProjectRole) -> None:
    with TestingSessionLocal() as db:
        user = User(
            email=email,
            full_name=email,
            password_hash=hash_password(TEST_PASSWORD),
            is_active=True,
            is_system_admin=False,
        )
        db.add(user)
        db.flush()
        db.add(
            ProjectMembership(
                project_id=project_id,
                user_id=user.id,
                role=role,
            )
        )
        db.commit()


def test_swap_exposes_previous_model_and_rollback_restores(
    client, auth_headers, monkeypatch
):
    project_id, endpoint, first_model_id = _create_project_and_endpoint(
        client, auth_headers, monkeypatch, name="swap-happy"
    )
    second_model_id = _seed_model(
        project_id, name="next", version="2", lifecycle=ModelLifecycle.PRODUCTION
    )
    load_uris: list[str] = []

    def fake_check(uri: str):
        load_uris.append(uri)
        return {"ok": True, "input_features": []}

    monkeypatch.setattr(inference_client, "check_model_loadable", fake_check)

    swapped = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/swap",
        headers=auth_headers,
        json={"model_version_id": second_model_id},
    )
    assert swapped.status_code == 200, swapped.text
    after_swap = swapped.json()
    assert after_swap["model_version_id"] == second_model_id
    assert after_swap["model_name"] == "next"
    assert after_swap["model_version"] == "2"
    assert after_swap["previous_model_version"] == endpoint["model_version"]
    assert after_swap["previous_model_uri"] == endpoint["model_uri"]
    assert after_swap["can_rollback"] is True
    assert load_uris[-1].endswith("/2")

    listed = client.get(
        f"/api/v1/projects/{project_id}/endpoints",
        headers=auth_headers,
    )
    assert listed.status_code == 200
    listed_row = next(item for item in listed.json() if item["id"] == endpoint["id"])
    assert listed_row["can_rollback"] is True
    assert listed_row["previous_model_version"] == endpoint["model_version"]

    rolled = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/rollback",
        headers=auth_headers,
    )
    assert rolled.status_code == 200, rolled.text
    after_rollback = rolled.json()
    assert after_rollback["model_version_id"] == first_model_id
    assert after_rollback["model_name"] == "base"
    assert after_rollback["model_version"] == "1"
    assert after_rollback["previous_model_version"] == "2"
    assert after_rollback["can_rollback"] is True


def test_rollback_without_previous_returns_409(client, auth_headers, monkeypatch):
    _, endpoint, _ = _create_project_and_endpoint(
        client, auth_headers, monkeypatch, name="swap-no-prev"
    )
    response = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/rollback",
        headers=auth_headers,
    )
    assert response.status_code == 409
    assert "rollback" in json.dumps(response.json()).lower()


def test_swap_rejects_candidate_model(client, auth_headers, monkeypatch):
    project_id, endpoint, _ = _create_project_and_endpoint(
        client, auth_headers, monkeypatch, name="swap-candidate"
    )
    candidate_id = _seed_model(
        project_id, name="cand", version="9", lifecycle=ModelLifecycle.CANDIDATE
    )
    response = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/swap",
        headers=auth_headers,
        json={"model_version_id": candidate_id},
    )
    assert response.status_code == 409
    assert "approved or production" in json.dumps(response.json()).lower()


def test_swap_load_failure_leaves_current_model(client, auth_headers, monkeypatch):
    project_id, endpoint, first_model_id = _create_project_and_endpoint(
        client, auth_headers, monkeypatch, name="swap-load-fail"
    )
    second_model_id = _seed_model(project_id, name="bad", version="3")

    def boom(uri: str):
        raise RuntimeError("cannot load")

    monkeypatch.setattr(inference_client, "check_model_loadable", boom)
    failed = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/swap",
        headers=auth_headers,
        json={"model_version_id": second_model_id},
    )
    assert failed.status_code == 502
    detail = client.get(
        f"/api/v1/endpoints/{endpoint['id']}",
        headers=auth_headers,
    )
    assert detail.status_code == 200
    body = detail.json()
    assert body["model_version_id"] == first_model_id
    assert body["can_rollback"] is False


def test_viewer_cannot_swap_or_rollback(client, auth_headers, monkeypatch):
    project_id, endpoint, _ = _create_project_and_endpoint(
        client, auth_headers, monkeypatch, name="swap-rbac"
    )
    second_model_id = _seed_model(project_id, name="next", version="2")
    _add_member(project_id, VIEWER_EMAIL, ProjectRole.VIEWER)
    viewer = _login(client, VIEWER_EMAIL)

    swap = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/swap",
        headers=viewer,
        json={"model_version_id": second_model_id},
    )
    assert swap.status_code == 403

    # Seed a rollback target as admin, then assert viewer still cannot rollback.
    monkeypatch.setattr(
        inference_client,
        "check_model_loadable",
        lambda uri: {"ok": True, "input_features": []},
    )
    swapped = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/swap",
        headers=auth_headers,
        json={"model_version_id": second_model_id},
    )
    assert swapped.status_code == 200, swapped.text
    rollback = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/rollback",
        headers=viewer,
    )
    assert rollback.status_code == 403


def test_ml_engineer_can_swap_and_rollback(client, auth_headers, monkeypatch):
    project_id, endpoint, first_model_id = _create_project_and_endpoint(
        client, auth_headers, monkeypatch, name="swap-engineer"
    )
    second_model_id = _seed_model(project_id, name="next", version="2")
    _add_member(project_id, ENGINEER_EMAIL, ProjectRole.ML_ENGINEER)
    engineer = _login(client, ENGINEER_EMAIL)
    monkeypatch.setattr(
        inference_client,
        "check_model_loadable",
        lambda uri: {"ok": True, "input_features": []},
    )

    swapped = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/swap",
        headers=engineer,
        json={"model_version_id": second_model_id},
    )
    assert swapped.status_code == 200, swapped.text
    assert swapped.json()["model_version_id"] == second_model_id

    rolled = client.post(
        f"/api/v1/endpoints/{endpoint['id']}/rollback",
        headers=engineer,
    )
    assert rolled.status_code == 200, rolled.text
    assert rolled.json()["model_version_id"] == first_model_id
