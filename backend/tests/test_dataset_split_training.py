from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import Base, DatasetSplit, JobStatus, TrainingJob, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage
from app.services.dataset_splits import content_sha256, split_config_signature
from app.services.training import SklearnTrainingRunner, TrainingJobContext
from app.workers import runner

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


@pytest.fixture(autouse=True)
def setup_split_tests(monkeypatch):
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


def _project_dataset(client, auth_headers, csv: bytes = CSV):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"split-{secrets.token_hex(4)}"},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]
    dataset = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("sample.csv", csv, "text/csv")},
    )
    assert dataset.status_code == 201
    return project_id, dataset.json()["id"], dataset.json()["version"]["id"]


def test_split_create_validation(client, auth_headers):
    project_id, _, version_id = _project_dataset(client, auth_headers)
    invalid_sum = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "train_ratio": 0.5,
            "val_ratio": 0.5,
            "test_ratio": 0.5,
            "random_seed": 1,
        },
    )
    assert invalid_sum.status_code == 422

    zero = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "train_ratio": 0.7,
            "val_ratio": 0.0,
            "test_ratio": 0.3,
            "random_seed": 1,
        },
    )
    assert zero.status_code == 422

    valid = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "train_ratio": 0.7,
            "val_ratio": 0.15,
            "test_ratio": 0.15,
            "random_seed": 42,
        },
    )
    assert valid.status_code == 201
    body = valid.json()
    assert body["config_signature"] == split_config_signature(0.7, 0.15, 0.15, 42)
    assert body["hashes"]["train"]
    assert body["hashes"]["validation"]
    assert body["hashes"]["test"]


def test_split_duplicate_prevention_and_reproducibility(client, auth_headers):
    project_id, _, version_id = _project_dataset(client, auth_headers)
    payload = {
        "name": "first",
        "train_ratio": 0.7,
        "val_ratio": 0.15,
        "test_ratio": 0.15,
        "random_seed": 42,
    }
    first = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json=payload,
    )
    assert first.status_code == 201
    first_body = first.json()
    keys_before = set(OBJECT_STORE.keys())

    second = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={**payload, "name": "second-attempt"},
    )
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["id"] == first_body["id"]
    assert second_body["hashes"] == first_body["hashes"]
    assert second_body["object_keys"] == first_body["object_keys"]
    assert set(OBJECT_STORE.keys()) == keys_before

    with TestingSessionLocal() as db:
        count = db.scalar(
            select(func.count()).select_from(DatasetSplit).where(
                DatasetSplit.dataset_version_id == version_id
            )
        )
    assert count == 1


def test_job_create_with_valid_and_invalid_split_id(client, auth_headers):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={},
    ).json()

    other = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "other-project"},
    )
    other_id = other.json()["id"]
    other_ds = client.post(
        f"/api/v1/projects/{other_id}/datasets",
        headers=auth_headers,
        files={"file": ("sample.csv", CSV, "text/csv")},
    )
    other_version = other_ds.json()["version"]["id"]
    other_split = client.post(
        f"/api/v1/projects/{other_id}/dataset-versions/{other_version}/splits",
        headers=auth_headers,
        json={},
    ).json()

    ok = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "with-split",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "algorithm": "random_forest",
            "train_ratio": 0.8,
            "val_ratio": 0.1,
            "test_ratio": 0.1,
            "random_seed": 999,
        },
    )
    assert ok.status_code == 201
    job = ok.json()
    assert job["split_id"] == split["id"]
    assert job["ratios"]["train"] == split["train_ratio"]
    assert job["ratios"]["validation"] == split["val_ratio"]
    assert job["ratios"]["test"] == split["test_ratio"]
    assert job["random_seed"] == split["random_seed"]

    wrong_project = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "bad-project-split",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": other_split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
        },
    )
    assert wrong_project.status_code == 404

    missing = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "missing-split",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": 999999,
            "target_column": "target",
            "feature_columns": ["a", "b"],
        },
    )
    assert missing.status_code == 404

    # Second version on same dataset — split from v1 must not attach to v2.
    v2 = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("sample.csv", CSV + b"11,3,1\n", "text/csv")},
    )
    assert v2.status_code == 201
    version_2 = v2.json()["version"]["id"]
    wrong_version = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "wrong-version-split",
            "dataset_id": dataset_id,
            "dataset_version_id": version_2,
            "split_id": split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
        },
    )
    assert wrong_version.status_code == 400
    assert "version" in wrong_version.json()["detail"].lower()

    with TestingSessionLocal() as db:
        queued = db.scalars(
            select(TrainingJob).where(TrainingJob.project_id == project_id)
        ).all()
    assert len(queued) == 1
    assert queued[0].split_id == split["id"]


def test_worker_uses_saved_split_artifacts_and_skips_runtime_split(
    client, auth_headers, monkeypatch, tmp_path
):
    pytest.importorskip("mlflow")
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={"train_ratio": 0.7, "val_ratio": 0.15, "test_ratio": 0.15, "random_seed": 42},
    ).json()
    job_resp = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "saved-split-job",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "algorithm": "random_forest",
            "hyperparameters": {"n_estimators": 5, "max_depth": 2},
        },
    )
    assert job_resp.status_code == 201
    job_id = job_resp.json()["id"]

    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)

    split_calls = {"train_test_split": 0}
    real_split = __import__("app.services.training", fromlist=["_split"])._split

    def guarded_split(*args, **kwargs):
        split_calls["train_test_split"] += 1
        return real_split(*args, **kwargs)

    monkeypatch.setattr("app.services.training._split", guarded_split)

    runner.process_job(type("Claim", (), {"id": job_id})())

    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        assert job.status == JobStatus.succeeded, job.error_message
        assert job.split_id == split["id"]
        assert "saved dataset split" in (job.logs or "").lower()
        assert split_calls["train_test_split"] == 0
        assert "split_id" in (job.metrics_json or "") or job.mlflow_run_id

    # Confirm training used the exact saved artifact bytes via integrity path.
    train_key = (settings.minio_datasets_bucket, split["object_keys"]["train"])
    assert train_key in OBJECT_STORE
    assert content_sha256(OBJECT_STORE[train_key]) == split["hashes"]["train"]


def test_worker_legacy_runtime_split_path(client, auth_headers, monkeypatch, tmp_path):
    pytest.importorskip("mlflow")
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    job_resp = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "runtime-split-job",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "algorithm": "random_forest",
            "hyperparameters": {"n_estimators": 5, "max_depth": 2},
        },
    )
    assert job_resp.status_code == 201
    assert job_resp.json()["split_id"] is None
    job_id = job_resp.json()["id"]

    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)

    split_calls = {"count": 0}
    real_split = __import__("app.services.training", fromlist=["_split"])._split

    def counting_split(*args, **kwargs):
        split_calls["count"] += 1
        return real_split(*args, **kwargs)

    monkeypatch.setattr("app.services.training._split", counting_split)
    runner.process_job(type("Claim", (), {"id": job_id})())

    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        assert job.status == JobStatus.succeeded, job.error_message
        assert job.split_id is None
    assert split_calls["count"] == 1


def test_worker_missing_split_artifact_fails_without_fallback(
    client, auth_headers, monkeypatch
):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={},
    ).json()
    job_resp = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "broken-artifact",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
        },
    )
    job_id = job_resp.json()["id"]
    train_key = split["object_keys"]["train"]
    OBJECT_STORE.pop((settings.minio_datasets_bucket, train_key), None)

    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    split_calls = {"count": 0}
    real_split = __import__("app.services.training", fromlist=["_split"])._split

    def counting_split(*args, **kwargs):
        split_calls["count"] += 1
        return real_split(*args, **kwargs)

    monkeypatch.setattr("app.services.training._split", counting_split)
    runner.process_job(type("Claim", (), {"id": job_id})())

    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        assert job.status == JobStatus.failed
        assert "could not be read" in (job.error_message or "").lower() or "missing" in (
            job.error_message or ""
        ).lower() or "artifact" in (job.error_message or "").lower()
    assert split_calls["count"] == 0


def test_mlflow_logs_split_lineage(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    train = b"a,b,target\n1,2,0\n2,3,0\n3,4,1\n4,5,1\n"
    val = b"a,b,target\n5,6,1\n6,7,0\n"
    test = b"a,b,target\n7,8,1\n8,9,0\n"
    result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=9,
            project_id=1,
            job_name="lineage",
            target_column="target",
            algorithm="random_forest",
            hyperparameters={"n_estimators": 5, "max_depth": 2},
            experiment_name="lineage-exp",
            train_bytes=train,
            validation_bytes=val,
            test_bytes=test,
            split_id=44,
            dataset_version_id=12,
            train_ratio=0.5,
            val_ratio=0.25,
            test_ratio=0.25,
            random_seed=7,
            split_train_hash=content_sha256(train),
            split_validation_hash=content_sha256(val),
            split_test_hash=content_sha256(test),
            train_object_key="train.csv",
            validation_object_key="val.csv",
            test_object_key="test.csv",
            feature_columns=["a", "b"],
        )
    )
    assert result.params["split_id"] == "44"
    assert result.params["dataset_version_id"] == "12"
    assert result.params["split_train_ratio"] == "0.5"
    assert result.params["split_validation_ratio"] == "0.25"
    assert result.params["split_test_ratio"] == "0.25"
    assert result.params["split_random_seed"] == "7"
    assert result.params["split_train_hash"] == content_sha256(train)


def test_retry_preserves_split_id(client, auth_headers):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={},
    ).json()
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "retry-me",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "max_retries": 2,
        },
    )
    job_id = created.json()["id"]
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        job.status = JobStatus.failed
        job.error_message = "boom"
        db.commit()

    retry = client.post(
        f"/api/v1/projects/{project_id}/jobs/{job_id}/retry",
        headers=auth_headers,
    )
    assert retry.status_code == 201
    assert retry.json()["split_id"] == split["id"]
    assert retry.json()["parent_job_id"] == job_id
