"""Service API Key management + external inference authentication tests."""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    AuditLog,
    Base,
    Endpoint,
    ModelLifecycle,
    ModelVersion,
    ProjectMembership,
    ProjectRole,
    ServiceApiKey,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference, mlflow_service, registry_service, storage
from app.services.service_api_keys import hash_service_api_key

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_PASSWORD = secrets.token_urlsafe(24)
ADMIN_EMAIL = "svc-admin@example.com"


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


def _login(client, email: str = ADMIN_EMAIL, password: str = TEST_PASSWORD):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def auth_headers(client):
    return _login(client)


def _project(client, headers, name: str) -> int:
    response = client.post(
        "/api/v1/projects", headers=headers, json={"name": name}
    )
    assert response.status_code == 201
    return response.json()["id"]


def _seed_endpoint(project_id: int, name: str, *, status: str = "ready") -> int:
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
            status=status,
            feature_schema_json=json.dumps(
                [{"name": "supply_temp", "dtype": "double"}]
            ),
            created_by=1,
        )
        db.add(endpoint)
        db.commit()
        db.refresh(endpoint)
        return endpoint.id


def _create_key(client, headers, project_id: int, **body):
    payload = {"name": body.pop("name", "erp-key"), **body}
    response = client.post(
        f"/api/v1/projects/{project_id}/service-api-keys",
        headers=headers,
        json=payload,
    )
    return response


def _assert_no_plaintext(payload: dict, forbidden: str | None = None) -> None:
    assert "key" not in payload
    assert "key_hash" not in payload
    blob = json.dumps(payload, default=str)
    assert "key_hash" not in blob
    if forbidden:
        assert forbidden not in blob


def test_create_key_returns_plaintext_once_and_stores_hash(client, auth_headers):
    project_id = _project(client, auth_headers, "svc-create")
    endpoint_id = _seed_endpoint(project_id, "ep-a")
    response = _create_key(
        client, auth_headers, project_id, name="erp-production", endpoint_id=endpoint_id
    )
    assert response.status_code == 201, response.text
    body = response.json()
    plaintext = body["key"]
    assert plaintext.startswith("mfk_")
    assert body["key_prefix"].startswith("mfk_")
    assert body["key_prefix"] in plaintext
    assert body["endpoint_id"] == endpoint_id
    assert body["is_active"] is True
    assert body["last_used_at"] is None
    assert body["revoked_at"] is None

    with TestingSessionLocal() as db:
        row = db.get(ServiceApiKey, body["id"])
        assert row is not None
        assert row.key_hash != plaintext
        assert row.key_hash == hash_service_api_key(plaintext)
        assert plaintext not in (row.key_prefix, row.key_hash, row.name)

    listed = client.get(
        f"/api/v1/projects/{project_id}/service-api-keys",
        headers=auth_headers,
    )
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    _assert_no_plaintext(listed.json()[0], forbidden=plaintext)

    with TestingSessionLocal() as db:
        audits = db.scalars(
            select(AuditLog).where(AuditLog.action == "service_api_key.create")
        ).all()
        assert audits
        for audit in audits:
            joined = " ".join(
                filter(
                    None,
                    [audit.before_summary, audit.after_summary, audit.failure_reason],
                )
            )
            assert plaintext not in joined
            assert "key_hash" not in joined or "***" in joined


def test_create_rejects_past_expires_and_foreign_endpoint(client, auth_headers):
    project_a = _project(client, auth_headers, "svc-exp-a")
    project_b = _project(client, auth_headers, "svc-exp-b")
    endpoint_b = _seed_endpoint(project_b, "ep-b")
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    bad_exp = _create_key(
        client, auth_headers, project_a, name="expired", expires_at=past
    )
    assert bad_exp.status_code == 422

    foreign = _create_key(
        client,
        auth_headers,
        project_a,
        name="cross",
        endpoint_id=endpoint_b,
    )
    assert foreign.status_code == 404


def test_revoke_blocks_external_predict_and_is_idempotent(
    client, auth_headers, monkeypatch
):
    project_id = _project(client, auth_headers, "svc-revoke")
    endpoint_id = _seed_endpoint(project_id, "ep-rev")
    created = _create_key(client, auth_headers, project_id, endpoint_id=endpoint_id)
    assert created.status_code == 201
    plaintext = created.json()["key"]
    key_id = created.json()["id"]
    key_prefix = created.json()["key_prefix"]

    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    monkeypatch.setattr(inference, "predict", lambda *a, **k: [0.5])

    ok = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 75}]},
    )
    assert ok.status_code == 200
    assert "predictions" in ok.json()
    assert "model_uri" not in ok.json()

    revoked = client.post(
        f"/api/v1/projects/{project_id}/service-api-keys/{key_id}/revoke",
        headers=auth_headers,
    )
    assert revoked.status_code == 200
    assert revoked.json()["is_active"] is False
    assert revoked.json()["revoked_at"] is not None
    _assert_no_plaintext(revoked.json(), forbidden=plaintext)

    denied = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 75}]},
    )
    assert denied.status_code == 401
    assert denied.json()["detail"] == "Invalid service API key."

    again = client.post(
        f"/api/v1/projects/{project_id}/service-api-keys/{key_id}/revoke",
        headers=auth_headers,
    )
    assert again.status_code == 200
    assert again.json()["key_prefix"] == key_prefix


def test_auth_boundary_jwt_vs_service_key(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers, "svc-boundary")
    endpoint_id = _seed_endpoint(project_id, "ep-bound")
    created = _create_key(client, auth_headers, project_id, endpoint_id=endpoint_id)
    plaintext = created.json()["key"]

    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    monkeypatch.setattr(inference, "predict", lambda *a, **k: [1])

    # A: User JWT → internal predict PASS
    internal = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 70}]},
    )
    assert internal.status_code == 200
    assert "model_uri" in internal.json()

    # B: Service key → external predict PASS
    external = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 70}]},
    )
    assert external.status_code == 200
    assert "model_uri" not in external.json()

    # C: Service key → internal predict 401
    cross_internal = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 70}]},
    )
    assert cross_internal.status_code == 401

    # D: User JWT → external predict 401
    cross_external = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"supply_temp": 70}]},
    )
    assert cross_external.status_code == 401
    assert cross_external.json()["detail"] == "Invalid service API key."


def test_project_and_endpoint_scope(client, auth_headers, monkeypatch):
    project_a = _project(client, auth_headers, "svc-scope-a")
    project_b = _project(client, auth_headers, "svc-scope-b")
    ep_a1 = _seed_endpoint(project_a, "a1")
    ep_a2 = _seed_endpoint(project_a, "a2")
    ep_b1 = _seed_endpoint(project_b, "b1")

    project_key = _create_key(client, auth_headers, project_a, name="project-scoped")
    assert project_key.status_code == 201
    project_plaintext = project_key.json()["key"]
    assert project_key.json()["endpoint_id"] is None

    endpoint_key = _create_key(
        client, auth_headers, project_a, name="ep-scoped", endpoint_id=ep_a1
    )
    endpoint_plaintext = endpoint_key.json()["key"]

    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    monkeypatch.setattr(inference, "predict", lambda *a, **k: [0])

    def predict(key: str, endpoint_id: int) -> int:
        return client.post(
            f"/api/v1/inference/endpoints/{endpoint_id}/predict",
            headers={"Authorization": f"Bearer {key}"},
            json={"instances": [{"supply_temp": 1}]},
        ).status_code

    assert predict(project_plaintext, ep_a1) == 200
    assert predict(project_plaintext, ep_a2) == 200
    assert predict(project_plaintext, ep_b1) == 403

    assert predict(endpoint_plaintext, ep_a1) == 200
    assert predict(endpoint_plaintext, ep_a2) == 403
    assert predict(endpoint_plaintext, ep_b1) == 403


def test_last_used_at_only_after_auth_and_scope(client, auth_headers, monkeypatch):
    project_a = _project(client, auth_headers, "svc-last-a")
    project_b = _project(client, auth_headers, "svc-last-b")
    ep_a = _seed_endpoint(project_a, "last-a", status="stopped")
    ep_b = _seed_endpoint(project_b, "last-b")
    created = _create_key(
        client, auth_headers, project_a, name="last-used", endpoint_id=ep_a
    )
    plaintext = created.json()["key"]
    key_id = created.json()["id"]

    def last_used():
        with TestingSessionLocal() as db:
            return db.get(ServiceApiKey, key_id).last_used_at

    assert last_used() is None

    # Invalid key — no change
    client.post(
        f"/api/v1/inference/endpoints/{ep_a}/predict",
        headers={"Authorization": "Bearer mfk_deadbeef_not-a-real-secret"},
        json={"instances": [{"supply_temp": 1}]},
    )
    assert last_used() is None

    # Valid key, wrong project endpoint — no change
    wrong = client.post(
        f"/api/v1/inference/endpoints/{ep_b}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 1}]},
    )
    assert wrong.status_code == 403
    assert last_used() is None

    # Valid key + correct scope + stopped endpoint → 409 but last_used_at updates
    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    stopped = client.post(
        f"/api/v1/inference/endpoints/{ep_a}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 1}]},
    )
    assert stopped.status_code == 409
    first_used = last_used()
    assert first_used is not None

    # Start endpoint and succeed
    with TestingSessionLocal() as db:
        ep = db.get(Endpoint, ep_a)
        ep.status = "ready"
        db.commit()
    monkeypatch.setattr(inference, "predict", lambda *a, **k: [9])
    ok = client.post(
        f"/api/v1/inference/endpoints/{ep_a}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 75}]},
    )
    assert ok.status_code == 200
    assert last_used() is not None


def test_expiration_blocks_external_predict(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers, "svc-expire")
    endpoint_id = _seed_endpoint(project_id, "ep-exp")
    future = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    created = _create_key(
        client,
        auth_headers,
        project_id,
        name="future",
        endpoint_id=endpoint_id,
        expires_at=future,
    )
    assert created.status_code == 201
    plaintext = created.json()["key"]
    key_id = created.json()["id"]

    monkeypatch.setattr(inference, "validate_instances", lambda *a, **k: None)
    monkeypatch.setattr(inference, "predict", lambda *a, **k: [1])
    assert (
        client.post(
            f"/api/v1/inference/endpoints/{endpoint_id}/predict",
            headers={"Authorization": f"Bearer {plaintext}"},
            json={"instances": [{"supply_temp": 1}]},
        ).status_code
        == 200
    )

    with TestingSessionLocal() as db:
        row = db.get(ServiceApiKey, key_id)
        row.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()

    expired = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 1}]},
    )
    assert expired.status_code == 401
    assert expired.json()["detail"] == "Invalid service API key."


def test_external_predict_dtype_normalization(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers, "svc-dtype")
    endpoint_id = _seed_endpoint(project_id, "ep-dtype")
    plaintext = _create_key(
        client, auth_headers, project_id, endpoint_id=endpoint_id
    ).json()["key"]

    monkeypatch.setattr(
        inference,
        "predict",
        lambda uri, instances, feature_schema=None, target_columns=None: [
            {"ok": True, "value": instances[0]["supply_temp"]}
        ],
    )
    # JSON int for double schema should pass through existing normalization
    ok = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": 75}]},
    )
    assert ok.status_code == 200, ok.text

    bad = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {plaintext}"},
        json={"instances": [{"supply_temp": "hot"}]},
    )
    assert bad.status_code == 422


def test_permissions_for_key_management(client, auth_headers):
    project_id = _project(client, auth_headers, "svc-perms")
    endpoint_id = _seed_endpoint(project_id, "ep-perm")

    role_users = {
        ProjectRole.PROJECT_ADMIN: "pa@example.com",
        ProjectRole.ML_ENGINEER: "ml@example.com",
        ProjectRole.DATA_SCIENTIST: "ds@example.com",
        ProjectRole.VIEWER: "vw@example.com",
    }
    with TestingSessionLocal() as db:
        for role, email in role_users.items():
            user = User(
                email=email,
                full_name=role.value,
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

    for role, email in role_users.items():
        headers = _login(client, email=email)
        created = _create_key(
            client, headers, project_id, name=f"k-{role.value}", endpoint_id=endpoint_id
        )
        listed = client.get(
            f"/api/v1/projects/{project_id}/service-api-keys",
            headers=headers,
        )
        if role in {ProjectRole.PROJECT_ADMIN, ProjectRole.ML_ENGINEER}:
            assert created.status_code == 201, role
            assert listed.status_code == 200, role
            key_id = created.json()["id"]
            revoked = client.post(
                f"/api/v1/projects/{project_id}/service-api-keys/{key_id}/revoke",
                headers=headers,
            )
            assert revoked.status_code == 200, role
        else:
            assert created.status_code == 403, role
            assert listed.status_code == 403, role


def test_cross_project_key_isolation(client, auth_headers):
    project_a = _project(client, auth_headers, "svc-iso-a")
    project_b = _project(client, auth_headers, "svc-iso-b")
    created = _create_key(client, auth_headers, project_a, name="iso")
    key_id = created.json()["id"]

    listed_b = client.get(
        f"/api/v1/projects/{project_b}/service-api-keys",
        headers=auth_headers,
    )
    assert listed_b.status_code == 200
    assert listed_b.json() == []

    revoke_b = client.post(
        f"/api/v1/projects/{project_b}/service-api-keys/{key_id}/revoke",
        headers=auth_headers,
    )
    assert revoke_b.status_code == 404


def test_malformed_and_missing_service_keys_are_401(client, auth_headers):
    project_id = _project(client, auth_headers, "svc-malformed")
    endpoint_id = _seed_endpoint(project_id, "ep-mal")
    for token in ("", "not-a-key", "Bearer", "mfk_short_x", "mfk_abcdefgh_"):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = client.post(
            f"/api/v1/inference/endpoints/{endpoint_id}/predict",
            headers=headers,
            json={"instances": [{"supply_temp": 1}]},
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid service API key."
