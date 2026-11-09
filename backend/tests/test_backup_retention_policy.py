"""Admin backup-retention API: persisted settings, RBAC and input safety."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import AuditLog, Base, SystemSetting, User
from app.db.session import get_db
from app.main import app
from app.services import backup_retention

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture
def client():
    Base.metadata.create_all(engine)

    def override_db():
        with TestSession() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    with TestSession() as db:
        db.add_all([
            User(email="backup-admin@example.com", full_name="Admin", password_hash=hash_password("a-strong-password-123"), is_active=True, is_system_admin=True),
            User(email="backup-viewer@example.com", full_name="Viewer", password_hash=hash_password("a-strong-password-123"), is_active=True, is_system_admin=False),
        ])
        db.commit()
    yield TestClient(app)
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


def login(client: TestClient, email: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": "a-strong-password-123"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_default_save_persist_and_audit(client):
    headers = login(client, "backup-admin@example.com")
    url = "/api/v1/admin/backup-retention"
    response = client.get(url, headers=headers)
    assert response.status_code == 200
    assert response.json() == {"enabled": True, "days": 14, "minimum_verified_keep": 2}

    updated = client.put(url, headers=headers, json={"enabled": False, "days": 30})
    assert updated.status_code == 200
    assert updated.json() == {"enabled": False, "days": 30, "minimum_verified_keep": 2}
    assert client.get(url, headers=headers).json() == updated.json()

    with TestSession() as db:
        assert backup_retention.read_policy(db) == updated.json()
        assert json.loads(db.get(SystemSetting, backup_retention.ENABLED_KEY).value_json) is False
        assert db.scalar(select(AuditLog).where(AuditLog.action == "backup_retention_policy.update")) is not None


def test_backup_retention_rejects_invalid_parameters_without_changing_policy(client):
    headers = login(client, "backup-admin@example.com")
    url = "/api/v1/admin/backup-retention"
    for payload in [
        {"enabled": True, "days": 6}, {"enabled": True, "days": 366},
        {"enabled": True, "days": 14.5}, {"enabled": True, "days": "14"},
        {"enabled": 1, "days": 14},
    ]:
        assert client.put(url, headers=headers, json=payload).status_code == 422
    assert client.get(url, headers=headers).json()["days"] == 14


def test_backup_retention_is_system_admin_only(client):
    url = "/api/v1/admin/backup-retention"
    viewer = login(client, "backup-viewer@example.com")
    assert client.get(url).status_code == 401
    assert client.put(url, json={"enabled": False, "days": 30}).status_code == 401
    assert client.get(url, headers=viewer).status_code == 403
    assert client.put(url, headers=viewer, json={"enabled": False, "days": 30}).status_code == 403


def test_corrupt_persisted_policy_fails_closed(client):
    with TestSession() as db:
        db.add(SystemSetting(key=backup_retention.DAYS_KEY, value_json=json.dumps("14")))
        db.commit()
        with pytest.raises(ValueError, match="Invalid stored"):
            backup_retention.read_policy(db)
