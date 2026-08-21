from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    DataImportJob,
    Dataset,
    DatasetVersion,
    JobStatus,
    ProjectMembership,
    ProjectRole,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)
TEST_VIEWER_PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(engine)
    _rate_windows.clear()
    monkeypatch.setattr(
        mlflow_service,
        "ensure_experiment",
        lambda name: f"experiment-{name.removeprefix('project-')}",
    )

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
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
            password_hash=hash_password(TEST_VIEWER_PASSWORD),
            is_active=True,
            is_system_admin=False,
        )
        db.add_all([admin, viewer])
        db.commit()
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


def _login(client: TestClient, email: str, password: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def auth_headers(client):
    return _login(client, "admin@example.com", TEST_ADMIN_PASSWORD)


@pytest.fixture
def viewer_headers(client):
    return _login(client, "viewer@example.com", TEST_VIEWER_PASSWORD)


def _project(client: TestClient, headers: dict[str, str]) -> int:
    response = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"name": f"ds-ops-{secrets.token_hex(4)}", "description": "lifecycle"},
    )
    assert response.status_code == 201
    return response.json()["id"]


def _create_source(
    client: TestClient,
    headers: dict[str, str],
    project_id: int,
    *,
    name: str = "warehouse",
    source_type: str = "postgres",
) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/data-sources",
        headers=headers,
        json={
            "name": name,
            "source_type": source_type,
            "config": {"host": "postgres-source", "port": 5432, "database": "db", "user": "u"},
            "secrets": {"password": "super-secret-password"},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert "password" not in json.dumps(body).lower() or "super-secret-password" not in json.dumps(body)
    assert body["has_secrets"] is True
    return body


def test_activate_deactivate_idempotent_and_inactive_blocks(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id)
    source_id = source["id"]

    deactivated = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/deactivate",
        headers=auth_headers,
    )
    assert deactivated.status_code == 200
    assert deactivated.json()["is_active"] is False

    again = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/deactivate",
        headers=auth_headers,
    )
    assert again.status_code == 200
    assert again.json()["is_active"] is False

    blocked_import = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/import",
        headers=auth_headers,
        json={"dataset_name": "x", "table_or_query": "public.t"},
    )
    assert blocked_import.status_code == 409

    blocked_test = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/test",
        headers=auth_headers,
    )
    assert blocked_test.status_code == 409

    activated = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/activate",
        headers=auth_headers,
    )
    assert activated.status_code == 200
    assert activated.json()["is_active"] is True

    active_again = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/activate",
        headers=auth_headers,
    )
    assert active_again.status_code == 200
    assert active_again.json()["is_active"] is True

    reopened = client.post(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}/import",
        headers=auth_headers,
        json={"dataset_name": "after-activate", "table_or_query": "public.t"},
    )
    assert reopened.status_code == 202
    assert reopened.json()["status"] == "pending"


def test_permanent_delete_unused_source(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id, name="unused")
    source_id = source["id"]

    deleted = client.delete(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert deleted.status_code == 200
    assert "permanently deleted" in deleted.json()["detail"].lower()

    listed = client.get(f"/api/v1/projects/{project_id}/data-sources", headers=auth_headers)
    assert listed.status_code == 200
    assert all(row["id"] != source_id for row in listed.json())

    missing = client.get(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert missing.status_code == 404


def test_permanent_delete_blocked_by_import_job(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id, name="used-job")
    source_id = source["id"]

    with TestingSessionLocal() as db:
        dataset = Dataset(project_id=project_id, name="ds", created_by=1)
        db.add(dataset)
        db.flush()
        db.add(
            DataImportJob(
                project_id=project_id,
                data_source_id=source_id,
                dataset_id=dataset.id,
                query_or_table="public.t",
                status=JobStatus.failed,
                error_message="missing table",
                created_by=1,
            )
        )
        db.commit()

    blocked = client.delete(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert blocked.status_code == 409
    assert "import history" in blocked.json()["detail"].lower()
    assert "deactivate" in (blocked.json().get("hint") or "").lower()

    still = client.get(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert still.status_code == 200
    assert still.json()["id"] == source_id


def test_permanent_delete_blocked_by_dataset_version(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id, name="used-version")
    source_id = source["id"]

    with TestingSessionLocal() as db:
        dataset = Dataset(project_id=project_id, name="imported", created_by=1)
        db.add(dataset)
        db.flush()
        db.add(
            DatasetVersion(
                dataset_id=dataset.id,
                project_id=project_id,
                version=1,
                object_key="k",
                original_filename="f.csv",
                source_type="postgres",
                data_source_id=source_id,
                created_by=1,
            )
        )
        db.commit()

    blocked = client.delete(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert blocked.status_code == 409

    still = client.get(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert still.status_code == 200


def test_viewer_cannot_mutate_data_sources(client, auth_headers, viewer_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id)
    source_id = source["id"]

    with TestingSessionLocal() as db:
        admin = db.scalar(select(User).where(User.email == "admin@example.com"))
        viewer = db.scalar(select(User).where(User.email == "viewer@example.com"))
        assert admin and viewer
        # Ensure viewer membership as VIEWER
        existing = db.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == viewer.id,
            )
        )
        if existing:
            existing.role = ProjectRole.VIEWER
        else:
            db.add(
                ProjectMembership(
                    project_id=project_id,
                    user_id=viewer.id,
                    role=ProjectRole.VIEWER,
                )
            )
        db.commit()

    for method, path in [
        ("POST", f"/api/v1/projects/{project_id}/data-sources/{source_id}/activate"),
        ("POST", f"/api/v1/projects/{project_id}/data-sources/{source_id}/deactivate"),
        ("DELETE", f"/api/v1/projects/{project_id}/data-sources/{source_id}"),
        ("POST", f"/api/v1/projects/{project_id}/data-sources/{source_id}/test"),
    ]:
        response = client.request(method, path, headers=viewer_headers)
        assert response.status_code == 403, path


def test_cross_project_isolation_for_lifecycle(client, auth_headers):
    project_a = _project(client, auth_headers)
    project_b = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_a)
    source_id = source["id"]

    for method, path in [
        ("GET", f"/api/v1/projects/{project_b}/data-sources/{source_id}"),
        ("GET", f"/api/v1/projects/{project_b}/data-sources/{source_id}/schemas"),
        ("POST", f"/api/v1/projects/{project_b}/data-sources/{source_id}/activate"),
        ("POST", f"/api/v1/projects/{project_b}/data-sources/{source_id}/deactivate"),
        ("DELETE", f"/api/v1/projects/{project_b}/data-sources/{source_id}"),
        (
            "POST",
            f"/api/v1/projects/{project_b}/data-sources/{source_id}/import",
        ),
    ]:
        kwargs = {"headers": auth_headers}
        if method == "POST" and path.endswith("/import"):
            kwargs["json"] = {"dataset_name": "x", "table_or_query": "public.t"}
        response = client.request(method, path, **kwargs)
        assert response.status_code in {403, 404}, path


def test_delete_audit_excludes_secrets(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id, name="audited")
    source_id = source["id"]

    deleted = client.delete(
        f"/api/v1/projects/{project_id}/data-sources/{source_id}",
        headers=auth_headers,
    )
    assert deleted.status_code == 200

    with TestingSessionLocal() as db:
        from app.db.models import AuditLog

        rows = db.scalars(
            select(AuditLog)
            .where(AuditLog.action == "data_source.delete")
            .order_by(AuditLog.id.desc())
        ).all()
        assert rows
        blob = " ".join(
            [
                (row.before_summary or "")
                + (row.after_summary or "")
                + (row.failure_reason or "")
                for row in rows[:5]
            ]
        )
        assert "super-secret-password" not in blob
        assert "secret_encrypted" not in blob


def _assert_no_secret_leak(payload: object, *secret_fragments: str) -> None:
    blob = json.dumps(payload)
    for fragment in secret_fragments:
        assert fragment not in blob


def test_postgres_dsn_url_backward_compat(client, auth_headers):
    from app.api.v1.data_sources import _connection_url, _secret_dict
    from app.db.models import AuditLog, DataSource

    project_id = _project(client, auth_headers)
    dsn_token = secrets.token_urlsafe(12)
    original_dsn = f"postgresql://compat_user:{dsn_token}@legacy-dsn-host:5432/compat_db"
    replacement_token = secrets.token_urlsafe(12)
    replacement_dsn = f"postgresql://compat_user:{replacement_token}@legacy-dsn-host:5432/compat_db"

    created = client.post(
        f"/api/v1/projects/{project_id}/data-sources",
        headers=auth_headers,
        json={
            "name": "legacy-dsn",
            "source_type": "postgres",
            "config": {},
            "secrets": {"dsn": original_dsn},
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["connection_mode"] == "connection_url"
    assert body["has_secrets"] is True
    assert body["config"] == {}
    _assert_no_secret_leak(body, dsn_token, original_dsn, "legacy-dsn-host")

    fetched = client.get(
        f"/api/v1/projects/{project_id}/data-sources/{body['id']}",
        headers=auth_headers,
    )
    assert fetched.status_code == 200
    fetched_body = fetched.json()
    assert fetched_body["connection_mode"] == "connection_url"
    _assert_no_secret_leak(fetched_body, dsn_token, original_dsn, "legacy-dsn-host")

    renamed = client.patch(
        f"/api/v1/projects/{project_id}/data-sources/{body['id']}",
        headers=auth_headers,
        json={"name": "legacy-dsn-renamed", "config": {}, "secrets": {}},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "legacy-dsn-renamed"
    assert renamed.json()["connection_mode"] == "connection_url"
    _assert_no_secret_leak(renamed.json(), dsn_token, original_dsn)

    with TestingSessionLocal() as db:
        row = db.get(DataSource, body["id"])
        assert row is not None
        stored = _secret_dict(row)
        assert stored.get("dsn") == original_dsn
        assert _connection_url(row) == original_dsn

    replaced = client.patch(
        f"/api/v1/projects/{project_id}/data-sources/{body['id']}",
        headers=auth_headers,
        json={
            "config": {},
            "secrets": {"dsn": replacement_dsn},
            "clear_secrets": ["password", "url"],
        },
    )
    assert replaced.status_code == 200
    assert replaced.json()["connection_mode"] == "connection_url"
    _assert_no_secret_leak(replaced.json(), dsn_token, replacement_token, replacement_dsn)

    with TestingSessionLocal() as db:
        row = db.get(DataSource, body["id"])
        assert row is not None
        stored = _secret_dict(row)
        assert stored.get("dsn") == replacement_dsn
        assert dsn_token not in json.dumps(stored)
        assert _connection_url(row) == replacement_dsn

    switched = client.patch(
        f"/api/v1/projects/{project_id}/data-sources/{body['id']}",
        headers=auth_headers,
        json={
            "config": {
                "host": "typed-host-after-switch",
                "port": 5432,
                "database": "typed_db",
                "user": "typed_user",
            },
            "secrets": {"password": "typed-secret"},
            "clear_secrets": ["dsn", "url"],
        },
    )
    assert switched.status_code == 200
    switched_body = switched.json()
    assert switched_body["connection_mode"] == "host_port"
    assert switched_body["config"]["host"] == "typed-host-after-switch"
    _assert_no_secret_leak(
        switched_body,
        dsn_token,
        replacement_token,
        "typed-secret",
        original_dsn,
        replacement_dsn,
    )

    with TestingSessionLocal() as db:
        row = db.get(DataSource, body["id"])
        assert row is not None
        stored = _secret_dict(row)
        assert "dsn" not in stored
        assert "url" not in stored
        assert stored.get("password") == "typed-secret"
        conn = _connection_url(row)
        assert "typed-host-after-switch" in conn
        assert "legacy-dsn-host" not in conn
        assert replacement_token not in conn

    back_to_url = client.patch(
        f"/api/v1/projects/{project_id}/data-sources/{body['id']}",
        headers=auth_headers,
        json={
            "config": {},
            "secrets": {"dsn": original_dsn},
            "clear_secrets": ["password", "url"],
        },
    )
    assert back_to_url.status_code == 200
    assert back_to_url.json()["connection_mode"] == "connection_url"
    _assert_no_secret_leak(back_to_url.json(), dsn_token, "typed-secret")

    with TestingSessionLocal() as db:
        row = db.get(DataSource, body["id"])
        assert row is not None
        stored = _secret_dict(row)
        assert stored.get("dsn") == original_dsn
        assert "password" not in stored
        assert _connection_url(row) == original_dsn

        audit_rows = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.resource_type == "data_source",
                AuditLog.resource_id == str(body["id"]),
            )
            .order_by(AuditLog.id.desc())
        ).all()
        assert audit_rows
        blob = " ".join(
            [
                (entry.before_summary or "")
                + (entry.after_summary or "")
                + (entry.failure_reason or "")
                for entry in audit_rows
            ]
        )
        assert dsn_token not in blob
        assert replacement_token not in blob
        assert "typed-secret" not in blob
        assert original_dsn not in blob


def test_create_with_url_secret_sets_connection_mode(client, auth_headers):
    project_id = _project(client, auth_headers)
    url_token = secrets.token_urlsafe(10)
    url_value = f"postgresql://u:{url_token}@url-only-host:5432/db"
    created = client.post(
        f"/api/v1/projects/{project_id}/data-sources",
        headers=auth_headers,
        json={
            "name": "url-source",
            "source_type": "postgres",
            "config": {"sslmode": "require"},
            "secrets": {"url": url_value},
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["connection_mode"] == "connection_url"
    assert body["config"] == {"sslmode": "require"}
    _assert_no_secret_leak(body, url_token, url_value, "url-only-host")


def test_clear_secrets_rejects_unknown_keys(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id)
    response = client.patch(
        f"/api/v1/projects/{project_id}/data-sources/{source['id']}",
        headers=auth_headers,
        json={"clear_secrets": ["not_a_secret"]},
    )
    assert response.status_code == 400
    assert "clear_secrets" in response.json()["detail"].lower()


def test_typed_source_reports_host_port_mode(client, auth_headers):
    project_id = _project(client, auth_headers)
    source = _create_source(client, auth_headers, project_id)
    assert source["connection_mode"] == "host_port"

