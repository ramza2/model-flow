from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    PipelineVersion,
    ProjectMembership,
    ProjectRole,
    User,
)
from app.db.session import get_db
from app.main import app
from app.services import mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)
VIEWER_PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_api(monkeypatch):
    Base.metadata.create_all(engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(registry_service, "_mlflow_logged_feature_schema", lambda run_id: [])
    with TestingSessionLocal() as db:
        admin = User(
            email="admin@example.com",
            full_name="Admin",
            password_hash=hash_password(TEST_ADMIN_PASSWORD),
            is_active=True,
            is_system_admin=True,
        )
        viewer = User(
            email="viewer@example.com",
            full_name="Viewer",
            password_hash=hash_password(VIEWER_PASSWORD),
            is_active=True,
        )
        db.add_all([admin, viewer])
        db.commit()
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


MINIMAL_GRAPH = {
    "nodes": [{"id": "n1", "type": "notification", "data": {"node_type": "notification"}}],
    "edges": [],
}


def _login(client, email: str, password: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def auth_headers(client):
    return _login(client, "admin@example.com", TEST_ADMIN_PASSWORD)


def _create_project(client, auth_headers, *, viewer: bool = False) -> int:
    response = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"sched-{secrets.token_hex(4)}", "description": ""},
    )
    assert response.status_code == 201
    project_id = response.json()["id"]
    if viewer:
        with TestingSessionLocal() as db:
            viewer_user = db.scalar(select(User).where(User.email == "viewer@example.com"))
            db.add(
                ProjectMembership(
                    project_id=project_id,
                    user_id=viewer_user.id,
                    role=ProjectRole.VIEWER,
                )
            )
            db.commit()
    return project_id


def _published_pipeline(client, auth_headers, project_id: int) -> tuple[int, int]:
    created = client.post(
        f"/api/v1/projects/{project_id}/pipelines",
        headers=auth_headers,
        json={"name": "pipe", "description": ""},
    )
    assert created.status_code == 201
    pipeline_id = created.json()["id"]
    saved = client.post(
        f"/api/v1/projects/{project_id}/pipelines/{pipeline_id}/versions",
        headers=auth_headers,
        json={"graph": MINIMAL_GRAPH},
    )
    assert saved.status_code == 201
    published = client.post(
        f"/api/v1/projects/{project_id}/pipelines/{pipeline_id}/publish",
        headers=auth_headers,
    )
    assert published.status_code == 200
    with TestingSessionLocal() as db:
        version = db.scalar(
            select(PipelineVersion).where(PipelineVersion.pipeline_id == pipeline_id)
        )
        return pipeline_id, version.id


def test_schedule_crud_and_run_now(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    pipeline_id, version_id = _published_pipeline(client, auth_headers, project_id)
    create = client.post(
        f"/api/v1/projects/{project_id}/schedules",
        headers=auth_headers,
        json={
            "name": "weekly pipeline",
            "description": "test",
            "target_type": "pipeline_run",
            "target_config": {
                "pipeline_id": pipeline_id,
                "parameters": {},
                "fail_policy": "stop",
            },
            "cron_expression": "0 9 * * 1",
            "timezone": "Asia/Seoul",
            "is_enabled": True,
        },
    )
    assert create.status_code == 201, create.text
    schedule = create.json()
    assert "pipeline_version_id" in schedule["target_config"]
    schedule_id = schedule["id"]

    listed = client.get(f"/api/v1/projects/{project_id}/schedules", headers=auth_headers)
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    run_now = client.post(
        f"/api/v1/projects/{project_id}/schedules/{schedule_id}/run-now",
        headers=auth_headers,
    )
    assert run_now.status_code == 202
    runs = client.get(
        f"/api/v1/projects/{project_id}/schedules/{schedule_id}/runs",
        headers=auth_headers,
    )
    assert runs.status_code == 200
    assert len(runs.json()) >= 1

    disabled = client.post(
        f"/api/v1/projects/{project_id}/schedules/{schedule_id}/disable",
        headers=auth_headers,
    )
    assert disabled.status_code == 200
    assert disabled.json()["is_enabled"] is False

    deleted = client.delete(
        f"/api/v1/projects/{project_id}/schedules/{schedule_id}",
        headers=auth_headers,
    )
    assert deleted.status_code == 409


def test_invalid_cron_rejected(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    pipeline_id, _ = _published_pipeline(client, auth_headers, project_id)
    response = client.post(
        f"/api/v1/projects/{project_id}/schedules",
        headers=auth_headers,
        json={
            "name": "bad cron",
            "target_type": "pipeline_run",
            "target_config": {"pipeline_id": pipeline_id},
            "cron_expression": "invalid cron",
            "timezone": "UTC",
        },
    )
    assert response.status_code == 400


def test_viewer_cannot_create_schedule(client, auth_headers):
    project_id = _create_project(client, auth_headers, viewer=True)
    viewer_headers = _login(client, "viewer@example.com", VIEWER_PASSWORD)
    pipeline_id, _ = _published_pipeline(client, auth_headers, project_id)
    read = client.get(f"/api/v1/projects/{project_id}/schedules", headers=viewer_headers)
    assert read.status_code == 200
    write = client.post(
        f"/api/v1/projects/{project_id}/schedules",
        headers=viewer_headers,
        json={
            "name": "denied",
            "target_type": "pipeline_run",
            "target_config": {"pipeline_id": pipeline_id},
            "cron_expression": "0 * * * *",
            "timezone": "UTC",
        },
    )
    assert write.status_code == 403


def test_unpublished_pipeline_rejected(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    created = client.post(
        f"/api/v1/projects/{project_id}/pipelines",
        headers=auth_headers,
        json={"name": "draft", "description": ""},
    )
    pipeline_id = created.json()["id"]
    response = client.post(
        f"/api/v1/projects/{project_id}/schedules",
        headers=auth_headers,
        json={
            "name": "draft schedule",
            "target_type": "pipeline_run",
            "target_config": {"pipeline_id": pipeline_id},
            "cron_expression": "0 * * * *",
            "timezone": "UTC",
        },
    )
    assert response.status_code == 400
