"""Endpoint regressions proving runtime client wiring (Phase 8-A)."""

from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, Endpoint, InferenceStat, ModelLifecycle, ModelVersion, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference_client, mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)
ADMIN_EMAIL = "phase8a-admin@example.com"


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
        json={"email": ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _seed_model(project_id: int) -> int:
    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name="clf",
            version="1",
            lifecycle=ModelLifecycle.APPROVED,
            mlflow_model_name=f"project-{project_id}-clf",
            mlflow_version="1",
            model_uri=f"models:/project-{project_id}-clf/1",
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


def test_create_and_predict_use_runtime_client(client, auth_headers, monkeypatch):
    load_calls: list[str] = []
    predict_calls: list[tuple] = []

    def fake_check(uri: str):
        load_calls.append(uri)
        return {"ok": True, "input_features": []}

    def fake_predict(uri, instances, feature_schema=None, target_columns=None):
        predict_calls.append((uri, instances, feature_schema, target_columns))
        return [float(row["x"]) + 1 for row in instances]

    monkeypatch.setattr(inference_client, "check_model_loadable", fake_check)
    monkeypatch.setattr(inference_client, "predict", fake_predict)

    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "phase8a-endpoints"},
    )
    assert project.status_code == 201, project.text
    model_id = _seed_model(project.json()["id"])
    created = client.post(
        f"/api/v1/projects/{project.json()['id']}/endpoints",
        headers=auth_headers,
        json={
            "name": "ep",
            "model_version_id": model_id,
            "feature_schema": [{"name": "x", "dtype": "float"}],
        },
    )
    assert created.status_code == 201, created.text
    assert load_calls
    endpoint_id = created.json()["id"]

    predicted = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"x": 2.0}]},
    )
    assert predicted.status_code == 200, predicted.text
    body = predicted.json()
    assert body["predictions"] == [3.0]
    assert body["prediction_ids"]
    assert predict_calls

    with TestingSessionLocal() as db:
        endpoint = db.get(Endpoint, endpoint_id)
        assert endpoint.success_count == 1
        assert endpoint.request_count == 1
        stats = list(
            db.scalars(
                select(InferenceStat).where(InferenceStat.endpoint_id == endpoint_id)
            ).all()
        )
        assert len(stats) == 1
        assert stats[0].success is True


def test_predict_runtime_failure_preserves_public_contract(
    client, auth_headers, monkeypatch
):
    from app.core.config import settings

    monkeypatch.setattr(
        inference_client,
        "check_model_loadable",
        lambda uri: {"ok": True, "input_features": []},
    )

    def boom(*args, **kwargs):
        raise inference_client.InferenceRuntimeError("Inference runtime is unavailable.")

    monkeypatch.setattr(inference_client, "predict", boom)

    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "phase8a-fail"},
    )
    assert project.status_code == 201, project.text
    model_id = _seed_model(project.json()["id"])
    created = client.post(
        f"/api/v1/projects/{project.json()['id']}/endpoints",
        headers=auth_headers,
        json={
            "name": "ep",
            "model_version_id": model_id,
            "feature_schema": [{"name": "x", "dtype": "float"}],
        },
    )
    assert created.status_code == 201, created.text

    failed = client.post(
        f"/api/v1/endpoints/{created.json()['id']}/predict",
        headers=auth_headers,
        json={"instances": [{"x": 1.0}]},
    )
    assert failed.status_code == 400
    detail = json.dumps(failed.json())
    assert "Prediction failed" in detail
    assert "inference-runtime" not in detail
    token = settings.inference_service_token or ""
    assert token not in detail
    assert "MODELFLOW_INFERENCE" not in detail

    with TestingSessionLocal() as db:
        endpoint = db.get(Endpoint, created.json()["id"])
        assert endpoint.error_count == 1
        assert endpoint.request_count == 1
        stats = list(
            db.scalars(
                select(InferenceStat).where(
                    InferenceStat.endpoint_id == created.json()["id"]
                )
            ).all()
        )
        assert len(stats) == 1
        assert stats[0].success is False


def test_predict_input_error_is_422(client, auth_headers, monkeypatch):
    monkeypatch.setattr(
        inference_client,
        "check_model_loadable",
        lambda uri: {"ok": True, "input_features": []},
    )

    def bad_input(*args, **kwargs):
        raise inference_client.InferenceRuntimeInputError(
            "Feature 'x' must be numeric for model type 'double'."
        )

    monkeypatch.setattr(inference_client, "predict", bad_input)
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "phase8a-422"},
    )
    assert project.status_code == 201, project.text
    model_id = _seed_model(project.json()["id"])
    created = client.post(
        f"/api/v1/projects/{project.json()['id']}/endpoints",
        headers=auth_headers,
        json={
            "name": "ep",
            "model_version_id": model_id,
            "feature_schema": [{"name": "x", "dtype": "float"}],
        },
    )
    assert created.status_code == 201, created.text
    response = client.post(
        f"/api/v1/endpoints/{created.json()['id']}/predict",
        headers=auth_headers,
        json={"instances": [{"x": "nope"}]},
    )
    assert response.status_code == 422
