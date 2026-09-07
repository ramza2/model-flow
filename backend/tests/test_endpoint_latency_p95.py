"""Regression: endpoint latency_p95_ms must include the current request.

SessionLocal uses autoflush=False. Without an explicit flush before the p95
SELECT, the newly added InferenceStat is invisible and the first successful
prediction leaves latency_p95_ms at 0.0 until the next request.
"""

from __future__ import annotations

import json
import secrets
import time as real_time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.api.v1.endpoints as endpoints_mod
from app.core.security import hash_password
from app.db.models import Base, Endpoint, InferenceStat, ModelLifecycle, ModelVersion, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference, mlflow_service, registry_service, storage


class _ControlledTime:
    """Replace only endpoints.py's `time` binding; leave process-global time alone."""

    def __init__(self, latency_ms: float):
        self._values = [0.0, latency_ms / 1000.0]
        self._index = 0

    def perf_counter(self) -> float:
        if self._index < len(self._values):
            value = self._values[self._index]
            self._index += 1
            return value
        return real_time.perf_counter()

    def __getattr__(self, name: str):
        return getattr(real_time, name)

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
# Match production SessionLocal: autoflush=False is required to reproduce the bug.
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)
ADMIN_EMAIL = "p95-admin@example.com"


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
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
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _project(client, headers, name: str) -> int:
    response = client.post("/api/v1/projects", headers=headers, json={"name": name})
    assert response.status_code == 201
    return response.json()["id"]


def _seed_ready_endpoint(project_id: int, name: str = "p95-ep") -> int:
    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name=f"model-{name}",
            version="1",
            lifecycle=ModelLifecycle.PRODUCTION,
            mlflow_model_name=f"project-{project_id}-{name}",
            mlflow_version="1",
            mlflow_run_id=f"run-{name}",
            model_uri=f"models:/{name}/1",
            gates_passed=True,
            gate_results_json=json.dumps({"passed": True}),
            metadata_json=json.dumps(
                {"feature_schema": [{"name": "supply_temp", "dtype": "double"}]}
            ),
        )
        db.add(model)
        db.flush()
        endpoint = Endpoint(
            project_id=project_id,
            name=name,
            model_name=model.name,
            model_version="1",
            model_version_id=model.id,
            model_uri=model.model_uri,
            status="ready",
            feature_schema_json=json.dumps(
                [{"name": "supply_temp", "dtype": "double"}]
            ),
            created_by=1,
        )
        db.add(endpoint)
        db.commit()
        db.refresh(endpoint)
        return endpoint.id


def _patch_predict_latency(monkeypatch, latency_ms: float):
    """Make endpoints._record_prediction measure exactly latency_ms."""
    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    monkeypatch.setattr(inference, "predict", lambda *a, **k: [0.42])
    monkeypatch.setattr(endpoints_mod, "time", _ControlledTime(latency_ms))


def _get_endpoint(client, headers, endpoint_id: int) -> dict:
    response = client.get(f"/api/v1/endpoints/{endpoint_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_first_successful_prediction_updates_latency_p95_immediately(
    client, auth_headers, monkeypatch
):
    project_id = _project(client, auth_headers, "p95-first")
    endpoint_id = _seed_ready_endpoint(project_id)
    _patch_predict_latency(monkeypatch, 25.0)

    predict = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 72.4}]},
    )
    assert predict.status_code == 200, predict.text

    body = _get_endpoint(client, auth_headers, endpoint_id)
    assert body["request_count"] == 1
    assert body["success_count"] == 1
    assert body["latency_p95_ms"] == pytest.approx(25.0, abs=0.01)
    assert body["latency_p95_ms"] != 0.0


def test_second_successful_prediction_includes_both_latencies_in_p95(
    client, auth_headers, monkeypatch
):
    project_id = _project(client, auth_headers, "p95-second")
    endpoint_id = _seed_ready_endpoint(project_id)

    _patch_predict_latency(monkeypatch, 17.4)
    first = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 70.0}]},
    )
    assert first.status_code == 200, first.text
    after_first = _get_endpoint(client, auth_headers, endpoint_id)
    assert after_first["request_count"] == 1
    assert after_first["latency_p95_ms"] == pytest.approx(17.4, abs=0.01)

    _patch_predict_latency(monkeypatch, 16.4)
    second = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 71.0}]},
    )
    assert second.status_code == 200, second.text
    after_second = _get_endpoint(client, auth_headers, endpoint_id)
    assert after_second["request_count"] == 2
    assert after_second["success_count"] == 2
    # Sorted latencies [16.4, 17.4]; index = min(1, int(2*0.95)=1) → 17.4
    assert after_second["latency_p95_ms"] == pytest.approx(17.4, abs=0.01)


def test_handled_failure_persists_latency_for_next_p95(
    client, auth_headers, monkeypatch
):
    """Failure path commits InferenceStat; next success p95 must see both rows."""
    project_id = _project(client, auth_headers, "p95-fail")
    endpoint_id = _seed_ready_endpoint(project_id)

    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    monkeypatch.setattr(endpoints_mod, "time", _ControlledTime(40.0))

    def _boom(*_a, **_k):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(inference, "predict", _boom)
    failed = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 72.4}]},
    )
    assert failed.status_code == 400, failed.text

    with TestingSessionLocal() as db:
        stats = list(
            db.scalars(
                select(InferenceStat).where(InferenceStat.endpoint_id == endpoint_id)
            ).all()
        )
        assert len(stats) == 1
        assert stats[0].success is False
        assert stats[0].latency_ms == pytest.approx(40.0, abs=0.01)

    after_fail = _get_endpoint(client, auth_headers, endpoint_id)
    assert after_fail["request_count"] == 1
    assert after_fail["error_count"] == 1
    # Existing policy: failure path does not recompute latency_p95_ms.
    assert after_fail["latency_p95_ms"] == pytest.approx(0.0, abs=0.01)

    _patch_predict_latency(monkeypatch, 25.0)
    ok = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 72.4}]},
    )
    assert ok.status_code == 200, ok.text
    after_ok = _get_endpoint(client, auth_headers, endpoint_id)
    assert after_ok["request_count"] == 2
    assert after_ok["success_count"] == 1
    # Sorted [25.0, 40.0]; index = min(1, int(1.9)=1) → 40.0 (includes failure latency)
    assert after_ok["latency_p95_ms"] == pytest.approx(40.0, abs=0.01)
