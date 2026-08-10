from __future__ import annotations

import importlib.util
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, DatasetSplit, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage
from app.services.dataset_splits import split_config_signature

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "007_split_signature_hashes.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_007_split_signature_hashes", MIGRATION_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


migration = _load_migration()

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)

CSV = (
    b"a,b,target\n"
    b"1,2,0\n2,3,0\n3,4,1\n4,5,1\n5,6,1\n6,7,0\n"
    b"7,8,1\n8,9,0\n9,1,1\n10,2,0\n"
)


def test_backfill_keeps_canonical_across_dataset_versions():
    assigned = migration.assign_legacy_config_signatures(
        [
            (1, 11, 0.7, 0.15, 0.15, 42),
            (2, 12, 0.7, 0.15, 0.15, 42),
        ]
    )
    canonical = "0.700000:0.150000:0.150000:42"
    assert assigned == [(1, canonical), (2, canonical)]


def test_backfill_suffixes_only_within_same_dataset_version():
    assigned = migration.assign_legacy_config_signatures(
        [
            (10, 11, 0.7, 0.15, 0.15, 42),
            (11, 11, 0.7, 0.15, 0.15, 42),
            (12, 99, 0.7, 0.15, 0.15, 42),
        ]
    )
    canonical = "0.700000:0.150000:0.150000:42"
    assert assigned[0] == (10, canonical)
    assert assigned[1] == (11, f"{canonical}#legacy-11")
    assert assigned[2] == (12, canonical)


@pytest.fixture(autouse=True)
def setup_api(monkeypatch):
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
        lambda bucket,
        key,
        data,
        content_type="application/octet-stream": OBJECT_STORE.__setitem__(
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
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": TEST_ADMIN_PASSWORD},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def test_create_reuses_migrated_canonical_legacy_split(client, auth_headers):
    """Simulates a post-upgrade canonical signature on a legacy split row."""
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"mig-{secrets.token_hex(3)}"},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]
    dataset = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("sample.csv", CSV, "text/csv")},
    )
    assert dataset.status_code == 201
    dataset_id = dataset.json()["id"]
    version_id = dataset.json()["version"]["id"]
    canonical = split_config_signature(0.7, 0.15, 0.15, 42)

    with TestingSessionLocal() as db:
        row = DatasetSplit(
            project_id=project_id,
            dataset_version_id=version_id,
            name="legacy-migrated",
            train_ratio=0.7,
            val_ratio=0.15,
            test_ratio=0.15,
            random_seed=42,
            config_signature=canonical,
            train_object_key=f"legacy/{version_id}/train.csv",
            val_object_key=f"legacy/{version_id}/validation.csv",
            test_object_key=f"legacy/{version_id}/test.csv",
            train_hash="a" * 64,
            validation_hash="b" * 64,
            test_hash="c" * 64,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        legacy_id = row.id

    keys_before = set(OBJECT_STORE.keys())
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "name": "should-reuse",
            "train_ratio": 0.7,
            "val_ratio": 0.15,
            "test_ratio": 0.15,
            "random_seed": 42,
        },
    )
    assert created.status_code == 200
    assert created.json()["id"] == legacy_id
    assert created.json()["config_signature"] == canonical
    assert set(OBJECT_STORE.keys()) == keys_before

    with TestingSessionLocal() as db:
        count = db.scalar(
            select(func.count())
            .select_from(DatasetSplit)
            .where(DatasetSplit.dataset_version_id == version_id)
        )
    assert count == 1
    assert dataset.json()["id"] == dataset_id
