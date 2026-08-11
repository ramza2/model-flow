from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    DataImportJob,
    DataSource,
    DataSourceType,
    Dataset,
    JobStatus,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)


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
    with TestingSessionLocal() as db:
        db.add(
            User(
                email="admin@example.com",
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
        json={"email": "admin@example.com", "password": TEST_ADMIN_PASSWORD},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_get_and_list_data_import_jobs(client, auth_headers):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "import-jobs", "description": ""},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]

    with TestingSessionLocal() as db:
        source = DataSource(
            project_id=project_id,
            name="pg",
            source_type=DataSourceType.postgres,
            config_json=json.dumps({"host": "postgres-source", "port": 5432}),
            is_active=True,
        )
        db.add(source)
        db.flush()
        dataset = Dataset(project_id=project_id, name="imported")
        db.add(dataset)
        db.flush()
        job = DataImportJob(
            project_id=project_id,
            data_source_id=source.id,
            dataset_id=dataset.id,
            query_or_table="public.customers",
            status=JobStatus.succeeded,
        )
        db.add(job)
        db.commit()
        job_id = job.id
        source_id = source.id

    listed = client.get(
        f"/api/v1/projects/{project_id}/data-import-jobs",
        headers=auth_headers,
    )
    assert listed.status_code == 200
    assert any(row["id"] == job_id for row in listed.json())

    detail = client.get(
        f"/api/v1/projects/{project_id}/data-import-jobs/{job_id}",
        headers=auth_headers,
    )
    assert detail.status_code == 200
    body = detail.json()
    assert body["status"] == "succeeded"
    assert body["table_or_query"] == "public.customers"
    assert body["data_source_id"] == source_id
