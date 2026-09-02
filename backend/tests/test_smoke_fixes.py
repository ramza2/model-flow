"""Tests for Phase 1.2 production smoke follow-up fixes."""

from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.registry import _resolve_approval_comment
from app.core.config import Settings
from app.core.security import hash_password
from app.db.models import Base, ModelLifecycle, ModelVersion, Project, User
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
PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_smoke_fix_tests(monkeypatch):
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


def _seed_project() -> int:
    with TestingSessionLocal() as db:
        project = Project(name="approval-comment-test", created_by=1)
        db.add(project)
        db.commit()
        db.refresh(project)
        return project.id


def _pending_model(project_id: int, comment: str) -> int:
    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name="multi-output-regressor",
            version="1",
            lifecycle=ModelLifecycle.PENDING_APPROVAL,
            mlflow_model_name=f"project-{project_id}-multi-output-regressor",
            mlflow_version="1",
            model_uri=f"models:/project-{project_id}-multi-output-regressor/1",
            approval_comment=comment,
            gates_passed=True,
            gate_results_json=json.dumps(
                {"passed": True, "computed_by": "server", "gate_version": "1", "results": []}
            ),
        )
        db.add(model)
        db.commit()
        db.refresh(model)
        return model.id


def test_resolve_approval_comment_preserves_existing_when_blank():
    assert _resolve_approval_comment("existing", None) == "existing"
    assert _resolve_approval_comment("existing", "") == "existing"
    assert _resolve_approval_comment("existing", "   ") == "existing"


def test_resolve_approval_comment_updates_when_non_empty():
    assert _resolve_approval_comment("existing", "updated") == "updated"


def test_approve_without_comment_preserves_existing_comment(client, auth_headers):
    project_id = _seed_project()
    model_id = _pending_model(project_id, "Phase 1.2 multi-output regression production smoke test")

    approved = client.post(
        f"/api/v1/projects/{project_id}/models/{model_id}/approve",
        headers=auth_headers,
        json={},
    )
    assert approved.status_code == 200
    assert approved.json()["approval_comment"] == (
        "Phase 1.2 multi-output regression production smoke test"
    )


def test_approve_with_new_comment_replaces_existing_comment(client, auth_headers):
    project_id = _seed_project()
    model_id = _pending_model(project_id, "original comment")

    approved = client.post(
        f"/api/v1/projects/{project_id}/models/{model_id}/approve",
        headers=auth_headers,
        json={"comment": "approved after review"},
    )
    assert approved.status_code == 200
    assert approved.json()["approval_comment"] == "approved after review"


def test_modelflow_git_sha_reads_environment(monkeypatch):
    monkeypatch.setenv("MODELFLOW_GIT_SHA", "15e66cab96a5c04477b6f6b8133d21595b85b4a0")
    assert Settings().git_sha == "15e66cab96a5c04477b6f6b8133d21595b85b4a0"


def test_modelflow_git_sha_defaults_to_unknown(monkeypatch):
    monkeypatch.delenv("MODELFLOW_GIT_SHA", raising=False)
    monkeypatch.delenv("GIT_SHA", raising=False)
    assert Settings().git_sha == "unknown"
