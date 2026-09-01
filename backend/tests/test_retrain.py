from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import (
    AuditLog,
    Base,
    JobStatus,
    Project,
    ProjectMembership,
    ProjectRole,
    RetrainTrigger,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage
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
TEST_VIEWER_PASSWORD = secrets.token_urlsafe(24)

CSV_V1 = (
    b"a,b,target\n"
    b"1,2,0\n2,3,0\n3,4,1\n4,5,1\n5,6,1\n6,7,0\n"
    b"7,8,1\n8,9,0\n9,1,1\n10,2,0\n"
)
CSV_V2 = (
    b"a,b,target\n"
    b"11,12,0\n12,13,1\n13,14,0\n14,15,1\n15,16,0\n16,17,1\n"
    b"17,18,0\n18,19,1\n19,20,0\n20,21,1\n"
)
CSV_BAD_COLUMNS = b"x,y,z\n1,2,3\n4,5,6\n"


@pytest.fixture(autouse=True)
def setup_retrain_tests(monkeypatch):
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
        )
        db.add_all([admin, viewer])
        db.flush()
        project = Project(name="retrain-project", created_by=admin.id)
        db.add(project)
        db.flush()
        db.add(
            ProjectMembership(
                project_id=project.id,
                user_id=viewer.id,
                role=ProjectRole.VIEWER,
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


@pytest.fixture
def viewer_headers(client):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "viewer@example.com", "password": TEST_VIEWER_PASSWORD},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
def project_id():
    with TestingSessionLocal() as db:
        return db.scalar(select(Project.id).where(Project.name == "retrain-project"))


def _upload_dataset(client, auth_headers, project_id, csv: bytes, name: str = "iris"):
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (f"{name}.csv", csv, "text/csv")},
        data={"name": name},
    )
    assert response.status_code == 201
    payload = response.json()
    return payload["id"], payload["version"]["id"]


def _create_job(client, auth_headers, project_id, dataset_id, version_id, **extra):
    body = {
        "name": extra.pop("name", "baseline"),
        "dataset_id": dataset_id,
        "dataset_version_id": version_id,
        "target_column": "target",
        "feature_columns": ["a", "b"],
        **extra,
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=body,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _mark_succeeded(job_id: int, *, mlflow_run_id: str = "source-run", model_uri: str = "runs:/source/model"):
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        job.status = JobStatus.succeeded
        job.mlflow_run_id = mlflow_run_id
        job.model_uri = model_uri
        job.metrics_json = '{"accuracy": 0.9}'
        db.commit()


def test_retrain_from_succeeded_job_copies_config(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        algorithm="logistic_regression",
        hyperparameters={"C": 0.5},
        random_seed=17,
    )
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={
            "dataset_version_id": version_v2,
            "name": "baseline-retrain-v2",
        },
    )
    assert retrain.status_code == 201, retrain.text
    payload = retrain.json()
    assert payload["name"] == "baseline-retrain-v2"
    assert payload["dataset_id"] == dataset_id
    assert payload["dataset_version_id"] == version_v2
    assert payload["split_id"] is None
    assert payload["target_column"] == "target"
    assert payload["algorithm"] == "logistic_regression"
    assert payload["hyperparameters"] == {"C": 0.5}
    assert payload["random_seed"] == 17
    assert payload["status"] == "pending"
    assert payload["mlflow_run_id"] is None
    assert payload["model_uri"] is None
    assert payload["metrics"] == {}
    assert payload["retry_count"] == 0
    assert payload["retrain_source_job_id"] == source["id"]
    assert payload["is_retrain"] is True
    assert payload["parent_job_id"] is None


def test_retrain_rejects_non_succeeded_source(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "should-fail"},
    )
    assert response.status_code == 409


def test_retrain_rejects_other_project_source(client, auth_headers, project_id):
    other = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"other-{secrets.token_hex(3)}"},
    )
    other_id = other.json()["id"]
    dataset_id, version_id = _upload_dataset(client, auth_headers, other_id, CSV_V1)
    source = _create_job(client, auth_headers, other_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    denied = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "cross-project"},
    )
    assert denied.status_code == 404


def test_retrain_rejects_other_dataset_version(client, auth_headers, project_id):
    dataset_a_id, version_a = _upload_dataset(client, auth_headers, project_id, CSV_V1, name="ds-a")
    dataset_b_id, version_b = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="ds-b")
    source = _create_job(client, auth_headers, project_id, dataset_a_id, version_a)
    _mark_succeeded(source["id"])
    denied = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_b, "name": "wrong-dataset"},
    )
    assert denied.status_code == 400


def test_retrain_rejects_missing_target_column(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, bad_version = _upload_dataset(client, auth_headers, project_id, CSV_BAD_COLUMNS, name="iris")
    denied = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": bad_version, "name": "missing-target"},
    )
    assert denied.status_code == 422


def test_retrain_allows_matching_split_and_rejects_foreign_split(client, auth_headers, project_id):
    dataset_id, version_v1 = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    split_v1 = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_v1}/splits",
        headers=auth_headers,
        json={},
    ).json()
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_v1,
        split_id=split_v1["id"],
    )
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    split_v2 = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_v2}/splits",
        headers=auth_headers,
        json={},
    ).json()

    denied = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={
            "dataset_version_id": version_v2,
            "split_id": split_v1["id"],
            "name": "wrong-split",
        },
    )
    assert denied.status_code == 400

    allowed = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={
            "dataset_version_id": version_v2,
            "split_id": split_v2["id"],
            "name": "matching-split",
        },
    )
    assert allowed.status_code == 201
    assert allowed.json()["split_id"] == split_v2["id"]
    assert allowed.json()["dataset_version_id"] == version_v2


def test_retrain_does_not_copy_source_split_by_default(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={},
    ).json()
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        split_id=split["id"],
    )
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "no-split-copy"},
    )
    assert retrain.status_code == 201
    assert retrain.json()["split_id"] is None


def test_retrain_lineage_list_filter(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "child"},
    ).json()
    listed = client.get(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        params={"retrain_source_job_id": source["id"]},
    )
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()] == [retrain["id"]]


def test_retrain_worker_produces_new_mlflow_run(
    client, auth_headers, project_id, monkeypatch, tmp_path
):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"], mlflow_run_id="source-run-1", model_uri="runs:/source-run-1/model")
    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "worker-retrain"},
    ).json()
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    runner.process_job(type("Claim", (), {"id": retrain["id"]})())
    with TestingSessionLocal() as db:
        child = db.get(TrainingJob, retrain["id"])
        source_row = db.get(TrainingJob, source["id"])
        assert child.status == JobStatus.succeeded, child.error_message
        assert child.mlflow_run_id
        assert child.model_uri
        assert child.mlflow_run_id != source_row.mlflow_run_id
        assert source_row.mlflow_run_id == "source-run-1"
        assert source_row.model_uri == "runs:/source-run-1/model"


def test_mlflow_logs_retrain_lineage(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    csv_bytes = CSV_V1
    result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=21,
            project_id=1,
            job_name="retrain-lineage",
            target_column="target",
            algorithm="random_forest",
            hyperparameters={"n_estimators": 5, "max_depth": 2},
            csv_bytes=csv_bytes,
            experiment_name="retrain-exp",
            dataset_version_id=99,
            retrain_source_job_id=7,
            feature_columns=["a", "b"],
        )
    )
    assert result.params["retrain_source_job_id"] == "7"
    assert result.params["dataset_version_id"] == "99"


def test_retrain_requires_train_write(client, viewer_headers, project_id, auth_headers):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    denied = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=viewer_headers,
        json={"dataset_version_id": version_id, "name": "viewer-denied"},
    )
    assert denied.status_code == 403


def test_retrain_writes_audit_event(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "audited"},
    )
    assert retrain.status_code == 201
    with TestingSessionLocal() as db:
        audit = db.scalar(
            select(AuditLog).where(
                AuditLog.action == "training_job.retrain",
                AuditLog.resource_id == str(retrain.json()["id"]),
            )
        )
        assert audit is not None


def test_legacy_retrain_endpoint_returns_202_and_response_shape(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={
            "source_job_id": source["id"],
            "dataset_version_id": version_v2,
            "name": "legacy-retrain-v2",
        },
    )
    assert response.status_code == 202, response.text
    payload = response.json()
    assert set(payload.keys()) == {"trigger", "training_job", "registry_lifecycle"}
    assert payload["registry_lifecycle"] is None

    trigger = payload["trigger"]
    assert trigger["project_id"] == project_id
    assert trigger["trigger_type"] == "manual"
    assert trigger["config"]["source_job_id"] == source["id"]
    assert trigger["config"]["dataset_version_id"] == version_v2
    assert trigger["last_triggered_at"] is not None
    assert trigger["created_training_job_id"] == payload["training_job"]["id"]

    job = payload["training_job"]
    assert job["name"] == "legacy-retrain-v2"
    assert job["dataset_version_id"] == version_v2
    assert job["retrain_source_job_id"] == source["id"]
    assert job["is_retrain"] is True
    assert job["parent_job_id"] is None
    assert job["status"] == "pending"


def test_legacy_retrain_creates_retrain_trigger_record(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])

    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={"source_job_id": source["id"], "dataset_version_id": version_id},
    )
    assert response.status_code == 202
    trigger_id = response.json()["trigger"]["id"]
    job_id = response.json()["training_job"]["id"]

    with TestingSessionLocal() as db:
        trigger = db.get(RetrainTrigger, trigger_id)
        job = db.get(TrainingJob, job_id)
        assert trigger is not None
        assert trigger.created_training_job_id == job_id
        assert job.retrain_source_job_id == source["id"]
        assert job.parent_job_id is None


def test_legacy_retrain_rejects_non_succeeded_source(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={"source_job_id": source["id"], "dataset_version_id": version_id},
    )
    assert response.status_code == 409


def test_legacy_retrain_defaults_name_and_dataset_version(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        name="baseline-job",
    )
    _mark_succeeded(source["id"])

    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={"source_job_id": source["id"]},
    )
    assert response.status_code == 202, response.text
    payload = response.json()
    assert payload["training_job"]["name"] == "baseline-job (retrain)"
    assert payload["training_job"]["dataset_version_id"] == version_id


def test_legacy_retrain_accepts_dataset_version_in_overrides(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={
            "source_job_id": source["id"],
            "overrides": {"dataset_version_id": version_v2},
        },
    )
    assert response.status_code == 202
    assert response.json()["training_job"]["dataset_version_id"] == version_v2


def test_legacy_retrain_writes_audit_event(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    response = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={"source_job_id": source["id"], "dataset_version_id": version_id},
    )
    assert response.status_code == 202
    trigger_id = response.json()["trigger"]["id"]
    with TestingSessionLocal() as db:
        audit = db.scalar(
            select(AuditLog).where(
                AuditLog.action == "retrain.trigger",
                AuditLog.resource_id == str(trigger_id),
            )
        )
        assert audit is not None


def test_legacy_and_canonical_retrain_share_lineage_semantics(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    legacy = client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json={
            "source_job_id": source["id"],
            "dataset_version_id": version_v2,
            "name": "legacy-child",
        },
    )
    canonical = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "canonical-child"},
    )
    assert legacy.status_code == 202
    assert canonical.status_code == 201

    legacy_job = legacy.json()["training_job"]
    canonical_job = canonical.json()
    for job in (legacy_job, canonical_job):
        assert job["retrain_source_job_id"] == source["id"]
        assert job["parent_job_id"] is None
        assert job["is_retrain"] is True
        assert job["mlflow_run_id"] is None
        assert job["model_uri"] is None
        assert job["status"] == "pending"


def _legacy_retrain(client, auth_headers, project_id, source_id, **payload):
    body = {"source_job_id": source_id, **payload}
    return client.post(
        f"/api/v1/projects/{project_id}/retrain",
        headers=auth_headers,
        json=body,
    )


def _succeeded_source_with_description(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        name="described-source",
        algorithm="logistic_regression",
        hyperparameters={"C": 0.5},
        random_seed=17,
    )
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, source["id"])
        job.description = "Source job notes"
        db.commit()
    _mark_succeeded(source["id"])
    return source, dataset_id, version_id


def test_legacy_retrain_applies_algorithm_override(client, auth_headers, project_id):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_id,
        overrides={
            "algorithm": "random_forest",
            "hyperparameters": {"n_estimators": 10, "max_depth": 3},
        },
    )
    assert response.status_code == 202, response.text
    assert response.json()["training_job"]["algorithm"] == "random_forest"


def test_legacy_retrain_applies_hyperparameters_override(client, auth_headers, project_id):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_id,
        overrides={"hyperparameters": {"C": 2.5}},
    )
    assert response.status_code == 202, response.text
    assert response.json()["training_job"]["hyperparameters"] == {"C": 2.5}


def test_legacy_retrain_applies_preprocessing_and_feature_columns_overrides(
    client, auth_headers, project_id
):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_id,
        overrides={
            "preprocessing": {"scale_numeric": True},
            "feature_columns": ["a"],
        },
    )
    assert response.status_code == 202, response.text
    job = response.json()["training_job"]
    assert job["preprocessing"] == {"scale_numeric": True}
    assert job["feature_columns"] == ["a"]


def test_legacy_retrain_applies_random_seed_and_ratio_overrides(client, auth_headers, project_id):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_id,
        overrides={
            "random_seed": 99,
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
        },
    )
    assert response.status_code == 202, response.text
    job = response.json()["training_job"]
    assert job["random_seed"] == 99
    assert job["ratios"]["train"] == 0.6
    assert job["ratios"]["validation"] == 0.2
    assert job["ratios"]["test"] == 0.2


def test_legacy_retrain_applies_split_id_override(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={},
    ).json()
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        split_id=split["id"],
    )
    _mark_succeeded(source["id"])
    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_id,
        overrides={"split_id": split["id"]},
    )
    assert response.status_code == 202, response.text
    assert response.json()["training_job"]["split_id"] == split["id"]


def test_legacy_retrain_top_level_dataset_version_id_precedence(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_v2,
        overrides={"dataset_version_id": version_id},
    )
    assert response.status_code == 202, response.text
    assert response.json()["training_job"]["dataset_version_id"] == version_v2


def test_legacy_retrain_rejects_other_logical_dataset_override(client, auth_headers, project_id):
    dataset_a_id, version_a = _upload_dataset(client, auth_headers, project_id, CSV_V1, name="ds-a")
    dataset_b_id, version_b = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="ds-b")
    source = _create_job(client, auth_headers, project_id, dataset_a_id, version_a)
    _mark_succeeded(source["id"])

    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_b,
        overrides={"dataset_id": dataset_b_id},
    )
    assert response.status_code == 400


def test_legacy_retrain_override_not_silently_ignored(client, auth_headers, project_id):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_id,
        overrides={"metrics_config": ["accuracy", "f1"]},
    )
    assert response.status_code == 202, response.text
    assert response.json()["training_job"]["metrics_config"] == ["accuracy", "f1"]
    assert response.json()["training_job"]["retrain_source_job_id"] == source["id"]
    assert response.json()["training_job"]["parent_job_id"] is None
    assert "trigger" in response.json()


def test_legacy_retrain_clears_stale_split_on_new_version_without_override(
    client, auth_headers, project_id
):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={},
    ).json()
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        split_id=split["id"],
    )
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    response = _legacy_retrain(
        client,
        auth_headers,
        project_id,
        source["id"],
        dataset_version_id=version_v2,
    )
    assert response.status_code == 202, response.text
    assert response.json()["training_job"]["split_id"] is None


def test_canonical_retrain_inherits_source_description_when_omitted(
    client, auth_headers, project_id
):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "inherits-description"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["description"] == "Source job notes"


def test_canonical_retrain_preserves_explicit_empty_description(client, auth_headers, project_id):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={
            "dataset_version_id": version_id,
            "name": "empty-description",
            "description": "",
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["description"] == ""


def test_canonical_retrain_does_not_accept_arbitrary_overrides(client, auth_headers, project_id):
    source, dataset_id, version_id = _succeeded_source_with_description(
        client, auth_headers, project_id
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={
            "dataset_version_id": version_id,
            "name": "no-overrides",
            "overrides": {"algorithm": "random_forest"},
        },
    )
    assert response.status_code == 422
