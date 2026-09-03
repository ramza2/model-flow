"""API coverage for read-only historical PipelineVersion lookup."""

from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_pipeline_version_read_tests(monkeypatch):
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
    monkeypatch.setattr(
        storage,
        "download_bytes",
        lambda bucket, key: b"",
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
                email="admin@example.com",
                full_name="Admin",
                password_hash=hash_password(PASSWORD),
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
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": PASSWORD},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def test_get_pipeline_version_returns_exact_stored_graph(client, auth_headers):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "pipeline-version-read"},
    ).json()
    graph_v1 = {
        "nodes": [
            {
                "id": "load",
                "position": {"x": 0, "y": 0},
                "data": {"node_type": "notification", "label": "Notify", "config": {}},
            }
        ],
        "edges": [],
    }
    pipeline = client.post(
        f"/api/v1/projects/{project['id']}/pipelines",
        headers=auth_headers,
        json={"name": "versioned", "graph": graph_v1},
    ).json()
    assert pipeline["version"]["version"] == 1
    version_id = pipeline["version"]["id"]

    graph_v2 = {
        "nodes": [
            {
                "id": "load",
                "position": {"x": 0, "y": 0},
                "data": {"node_type": "notification", "label": "Notify", "config": {}},
            },
            {
                "id": "second",
                "position": {"x": 200, "y": 0},
                "data": {"node_type": "notification", "label": "Second", "config": {}},
            },
        ],
        "edges": [{"source": "load", "target": "second", "data": {"branch": "always"}}],
    }
    saved = client.post(
        f"/api/v1/projects/{project['id']}/pipelines/{pipeline['id']}/versions",
        headers=auth_headers,
        json={"graph": graph_v2},
    )
    assert saved.status_code == 201

    historical = client.get(
        f"/api/v1/projects/{project['id']}/pipeline-versions/{version_id}",
        headers=auth_headers,
    )
    assert historical.status_code == 200
    body = historical.json()
    assert body["id"] == version_id
    assert body["version"] == 1
    assert body["pipeline_id"] == pipeline["id"]
    assert len(body["graph"]["nodes"]) == 1
    assert body["graph"]["nodes"][0]["id"] == "load"

    latest = client.get(
        f"/api/v1/projects/{project['id']}/pipelines/{pipeline['id']}",
        headers=auth_headers,
    ).json()
    assert latest["version"]["version"] == 2
    assert len(latest["version"]["graph"]["nodes"]) == 2


def test_get_pipeline_version_missing_and_cross_project(client, auth_headers):
    project_a = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "pipeline-version-a"},
    ).json()
    project_b = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "pipeline-version-b"},
    ).json()
    pipeline = client.post(
        f"/api/v1/projects/{project_a['id']}/pipelines",
        headers=auth_headers,
        json={
            "name": "scoped",
            "graph": {
                "nodes": [
                    {
                        "id": "n1",
                        "position": {"x": 0, "y": 0},
                        "data": {"node_type": "notification", "config": {}},
                    }
                ],
                "edges": [],
            },
        },
    ).json()
    version_id = pipeline["version"]["id"]

    missing = client.get(
        f"/api/v1/projects/{project_a['id']}/pipeline-versions/999999",
        headers=auth_headers,
    )
    assert missing.status_code == 404

    cross = client.get(
        f"/api/v1/projects/{project_b['id']}/pipeline-versions/{version_id}",
        headers=auth_headers,
    )
    assert cross.status_code == 404


def test_get_pipeline_version_requires_auth(client):
    response = client.get("/api/v1/projects/1/pipeline-versions/1")
    assert response.status_code in {401, 403}
