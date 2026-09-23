"""Phase 5.1 continued / incremental training tests."""

from __future__ import annotations

import secrets
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import (
    Base,
    JobStatus,
    ModelLifecycle,
    Project,
    ProjectMembership,
    ProjectRole,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage
from app.services.algorithm_catalog import get_algorithm, list_algorithms
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
CSV_V2_NEW_CLASS = (
    b"a,b,target\n"
    b"11,12,0\n12,13,1\n13,14,2\n14,15,1\n15,16,0\n16,17,2\n"
    b"17,18,0\n18,19,1\n19,20,2\n20,21,1\n"
)
CSV_REG_V1 = (
    b"a,b,target\n"
    b"1,2,1.0\n2,3,2.0\n3,4,3.0\n4,5,4.0\n5,6,5.0\n6,7,6.0\n"
    b"7,8,7.0\n8,9,8.0\n9,1,9.0\n10,2,10.0\n"
)
CSV_REG_V2 = (
    b"a,b,target\n"
    b"11,12,11.0\n12,13,12.0\n13,14,13.0\n14,15,14.0\n15,16,15.0\n"
    b"16,17,16.0\n17,18,17.0\n18,19,18.0\n19,20,19.0\n20,21,20.0\n"
)
CSV_BAD_COLUMNS = b"x,y,z\n1,2,3\n4,5,6\n"


@pytest.fixture(autouse=True)
def setup_continued_tests(monkeypatch):
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
        project = Project(name="continued-project", created_by=admin.id)
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
        return db.scalar(select(Project.id).where(Project.name == "continued-project"))


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
        "name": extra.pop("name", "baseline-sgd"),
        "dataset_id": dataset_id,
        "dataset_version_id": version_id,
        "target_column": "target",
        "feature_columns": ["a", "b"],
        "algorithm": extra.pop("algorithm", "sgd_classifier"),
        **extra,
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=body,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _mark_succeeded(
    job_id: int,
    *,
    mlflow_run_id: str = "source-run",
    model_uri: str = "runs:/source/model",
):
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id)
        job.status = JobStatus.succeeded
        job.mlflow_run_id = mlflow_run_id
        job.model_uri = model_uri
        job.metrics_json = '{"accuracy": 0.9}'
        db.commit()


def test_algorithm_capability_partial_fit():
    sgd_c = get_algorithm("sgd_classifier")
    sgd_r = get_algorithm("sgd_regressor")
    assert sgd_c is not None and sgd_c.supports_continued_training
    assert sgd_c.continued_training_strategy == "partial_fit"
    assert sgd_r is not None and sgd_r.supports_continued_training
    assert sgd_r.continued_training_strategy == "partial_fit"
    for algo_id in (
        "logistic_regression",
        "random_forest",
        "gradient_boosting",
        "ridge",
        "random_forest_regressor",
        "gradient_boosting_regressor",
    ):
        spec = get_algorithm(algo_id)
        assert spec is not None
        assert spec.supports_continued_training is False
        assert spec.continued_training_strategy == "unsupported"
    catalog = {row["id"]: row for row in list_algorithms()}
    assert catalog["sgd_classifier"]["supports_continued_training"] is True
    assert catalog["sgd_classifier"]["continued_training_strategy"] == "partial_fit"


def test_fresh_sgd_classifier_and_regressor(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    cls_result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=1,
            project_id=1,
            job_name="fresh-sgd-cls",
            target_column="target",
            algorithm="sgd_classifier",
            hyperparameters={"max_iter": 200},
            csv_bytes=CSV_V1,
            experiment_name="sgd-exp",
            feature_columns=["a", "b"],
        )
    )
    assert cls_result.mlflow_run_id
    assert "accuracy" in cls_result.metrics
    reg_result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=2,
            project_id=1,
            job_name="fresh-sgd-reg",
            target_column="target",
            algorithm="sgd_regressor",
            hyperparameters={"max_iter": 200},
            csv_bytes=CSV_REG_V1,
            experiment_name="sgd-exp",
            problem_type="regression",
            feature_columns=["a", "b"],
        )
    )
    assert reg_result.mlflow_run_id
    assert "rmse" in reg_result.metrics or "r2" in reg_result.metrics


def test_continue_from_succeeded_sgd(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    continued = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "sgd-continued-v2"},
    )
    assert continued.status_code == 201, continued.text
    payload = continued.json()
    assert payload["continued_from_job_id"] == source["id"]
    assert payload["is_continued_training"] is True
    assert payload["training_mode"] == "continued"
    assert payload["retrain_source_job_id"] is None
    assert payload["is_retrain"] is False
    assert payload["parent_job_id"] is None
    assert payload["algorithm"] == "sgd_classifier"
    assert payload["dataset_version_id"] == version_v2
    assert payload["status"] == "pending"
    assert payload["mlflow_run_id"] is None
    assert payload["model_uri"] is None


def test_continue_rejects_unsupported_algorithm(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        algorithm="random_forest",
        hyperparameters={"n_estimators": 10},
    )
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "should-fail"},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    text = detail if isinstance(detail, str) else str(detail)
    assert "does not support continued training" in text or "Full Retrain" in text


def test_continue_rejects_not_succeeded(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "should-fail"},
    )
    assert response.status_code == 409


def test_continue_rejects_missing_model_uri(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, source["id"])
        job.status = JobStatus.succeeded
        job.mlflow_run_id = "run-1"
        job.model_uri = None
        db.commit()
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "should-fail"},
    )
    assert response.status_code == 409


def test_continue_rejects_same_and_older_version(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    same = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "same-v"},
    )
    assert same.status_code == 422
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    # Create a continued child on v2, then try continuing from source onto an
    # older logical version by using a different dataset's version — covered below.
    # Older: create v3 then attempt continue from a job on v3 using v2.
    child = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "child-v2"},
    ).json()
    _mark_succeeded(child["id"])
    older = client.post(
        f"/api/v1/projects/{project_id}/jobs/{child['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_id, "name": "older"},
    )
    assert older.status_code == 422
    assert "older" in older.json()["detail"].lower() or "Full Retrain" in older.json()["detail"]


def test_continue_rejects_different_dataset(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    other_id, other_version = _upload_dataset(
        client, auth_headers, project_id, CSV_V2, name="other-ds"
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": other_version, "name": "diff-ds"},
    )
    assert response.status_code == 422
    assert "same Dataset" in response.json()["detail"] or "different dataset" in response.json()[
        "detail"
    ].lower()


def test_continue_rejects_schema_incompatible(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    # Upload incompatible columns under same dataset name to get newer version.
    bad = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("iris.csv", CSV_BAD_COLUMNS, "text/csv")},
        data={"name": "iris"},
    )
    assert bad.status_code == 201
    version_bad = bad.json()["version"]["id"]
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_bad, "name": "bad-schema"},
    )
    assert response.status_code == 422


def test_continue_rejects_multi_output(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(
        client,
        auth_headers,
        project_id,
        b"a,b,t1,t2\n1,2,0,1\n2,3,1,0\n3,4,0,1\n4,5,1,0\n5,6,0,1\n6,7,1,0\n"
        b"7,8,0,1\n8,9,1,0\n9,1,0,1\n10,2,1,0\n",
        name="multi",
    )
    # Multi-output SGD is unsupported at catalog level; create via DB mutation.
    source = _create_job(
        client,
        auth_headers,
        project_id,
        dataset_id,
        version_id,
        target_column="t1",
        feature_columns=["a", "b"],
    )
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, source["id"])
        job.target_columns_json = '["t1","t2"]'
        job.status = JobStatus.succeeded
        job.mlflow_run_id = "run-mo"
        job.model_uri = "runs:/run-mo/model"
        db.commit()
    _, version_v2 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        b"a,b,t1,t2\n11,12,0,1\n12,13,1,0\n13,14,0,1\n14,15,1,0\n15,16,0,1\n"
        b"16,17,1,0\n17,18,0,1\n18,19,1,0\n19,20,0,1\n20,21,1,0\n",
        name="multi",
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "mo-fail"},
    )
    assert response.status_code == 422
    assert "single-output" in response.json()["detail"].lower()


def test_lineage_separation_retry_retrain_continue(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")

    retrain = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retrain",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "full-retrain"},
    ).json()
    assert retrain["retrain_source_job_id"] == source["id"]
    assert retrain["continued_from_job_id"] is None
    assert retrain["training_mode"] == "full_retrain"

    continued = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "continued"},
    ).json()
    assert continued["continued_from_job_id"] == source["id"]
    assert continued["retrain_source_job_id"] is None
    assert continued["training_mode"] == "continued"

    with TestingSessionLocal() as db:
        failed = db.get(TrainingJob, source["id"])
        failed.status = JobStatus.failed
        db.commit()
    retry = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/retry",
        headers=auth_headers,
    ).json()
    assert retry["parent_job_id"] == source["id"]
    assert retry["retrain_source_job_id"] is None
    assert retry["continued_from_job_id"] is None


def test_continue_list_filter(client, auth_headers, project_id):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    child = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "child"},
    ).json()
    listed = client.get(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        params={"continued_from_job_id": source["id"]},
    )
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()] == [child["id"]]


def test_continue_requires_train_write(client, viewer_headers, project_id, auth_headers):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    denied = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=viewer_headers,
        json={"dataset_version_id": version_v2, "name": "denied"},
    )
    assert denied.status_code == 403


def test_continued_training_partial_fit_and_frozen_preprocessing(
    tmp_path, monkeypatch
):
    pytest.importorskip("mlflow")
    import mlflow.sklearn
    from sklearn.pipeline import Pipeline

    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    fresh = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=10,
            project_id=1,
            job_name="sgd-source",
            target_column="target",
            algorithm="sgd_classifier",
            hyperparameters={"max_iter": 200},
            csv_bytes=CSV_V1,
            experiment_name="continued-exp",
            feature_columns=["a", "b"],
            dataset_version_id=1,
        )
    )
    source_pipeline = mlflow.sklearn.load_model(fresh.model_uri)
    assert isinstance(source_pipeline, Pipeline)
    preprocessing = source_pipeline.named_steps["preprocessing"]
    estimator = source_pipeline.named_steps["estimator"]

    transform_called = {"count": 0}
    partial_fit_called = {"count": 0}

    original_transform = preprocessing.transform
    original_partial_fit = estimator.partial_fit

    def tracking_transform(*args, **kwargs):
        transform_called["count"] += 1
        return original_transform(*args, **kwargs)

    def tracking_partial_fit(*args, **kwargs):
        partial_fit_called["count"] += 1
        return original_partial_fit(*args, **kwargs)

    preprocessing.transform = tracking_transform
    estimator.partial_fit = tracking_partial_fit
    preprocessing.fit = MagicMock(
        side_effect=AssertionError("preprocessing.fit must not be called")
    )
    preprocessing.fit_transform = MagicMock(
        side_effect=AssertionError("preprocessing.fit_transform must not be called")
    )
    estimator.fit = MagicMock(
        side_effect=AssertionError("estimator.fit must not be called")
    )

    # Re-log mutated-in-memory pipeline is unnecessary; monkeypatch load_model.
    monkeypatch.setattr(
        mlflow.sklearn,
        "load_model",
        lambda uri: source_pipeline,
    )

    continued = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=15,
            project_id=1,
            job_name="sgd-continued",
            target_column="target",
            algorithm="sgd_classifier",
            hyperparameters={"max_iter": 200},
            csv_bytes=CSV_V2,
            experiment_name="continued-exp",
            feature_columns=["a", "b"],
            dataset_version_id=2,
            continued_from_job_id=10,
            continued_from_mlflow_run_id=fresh.mlflow_run_id,
            continued_from_model_uri=fresh.model_uri,
        )
    )
    assert continued.mlflow_run_id != fresh.mlflow_run_id
    assert continued.model_uri != fresh.model_uri
    assert continued.params["training_mode"] == "continued"
    assert continued.params["continued_from_job_id"] == "10"
    assert transform_called["count"] >= 1
    assert partial_fit_called["count"] == 1
    preprocessing.fit.assert_not_called()
    preprocessing.fit_transform.assert_not_called()
    estimator.fit.assert_not_called()


def test_continued_rejects_new_classification_classes(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    import mlflow.sklearn

    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    fresh = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=20,
            project_id=1,
            job_name="sgd-source-classes",
            target_column="target",
            algorithm="sgd_classifier",
            hyperparameters={"max_iter": 200},
            csv_bytes=CSV_V1,
            experiment_name="continued-classes",
            feature_columns=["a", "b"],
        )
    )
    with pytest.raises(ValueError, match="New target classes require Full Retrain"):
        SklearnTrainingRunner().run(
            TrainingJobContext(
                job_id=21,
                project_id=1,
                job_name="sgd-new-class",
                target_column="target",
                algorithm="sgd_classifier",
                hyperparameters={"max_iter": 200},
                csv_bytes=CSV_V2_NEW_CLASS,
                experiment_name="continued-classes",
                feature_columns=["a", "b"],
                continued_from_job_id=20,
                continued_from_mlflow_run_id=fresh.mlflow_run_id,
                continued_from_model_uri=fresh.model_uri,
            )
        )


def test_continue_worker_preserves_source_artifact(
    client, auth_headers, project_id, monkeypatch, tmp_path
):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    # Train source for real so model_uri is loadable.
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    runner.process_job(type("Claim", (), {"id": source["id"]})())
    with TestingSessionLocal() as db:
        source_row = db.get(TrainingJob, source["id"])
        assert source_row.status == JobStatus.succeeded, source_row.error_message
        source_run = source_row.mlflow_run_id
        source_uri = source_row.model_uri

    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    continued = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "worker-continued"},
    ).json()
    runner.process_job(type("Claim", (), {"id": continued["id"]})())
    with TestingSessionLocal() as db:
        child = db.get(TrainingJob, continued["id"])
        source_after = db.get(TrainingJob, source["id"])
        assert child.status == JobStatus.succeeded, child.error_message
        assert child.continued_from_job_id == source["id"]
        assert child.mlflow_run_id != source_run
        assert child.model_uri != source_uri
        assert source_after.mlflow_run_id == source_run
        assert source_after.model_uri == source_uri


def test_continued_register_starts_as_candidate(client, auth_headers, project_id, monkeypatch):
    dataset_id, version_id = _upload_dataset(client, auth_headers, project_id, CSV_V1)
    source = _create_job(client, auth_headers, project_id, dataset_id, version_id)
    _mark_succeeded(source["id"])
    _, version_v2 = _upload_dataset(client, auth_headers, project_id, CSV_V2, name="iris")
    continued = client.post(
        f"/api/v1/projects/{project_id}/jobs/{source['id']}/continue",
        headers=auth_headers,
        json={"dataset_version_id": version_v2, "name": "reg-continued"},
    ).json()
    _mark_succeeded(
        continued["id"],
        mlflow_run_id="continued-run-1",
        model_uri="runs:/continued-run-1/model",
    )
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-1",
            "params": {
                "features": "a,b",
                "problem_type": "classification",
                "target_columns": '["target"]',
                "training_mode": "continued",
                "job_id": str(continued["id"]),
            },
            "metrics": {"accuracy": 0.91},
            "tags": {"modelflow.training_mode": "continued"},
            "artifacts": [{"path": "model", "is_dir": True}],
        },
    )
    monkeypatch.setattr(
        mlflow_service,
        "register_model",
        lambda run_id, name, artifact_path: {"name": name, "version": "1"},
    )
    registered = client.post(
        f"/api/v1/projects/{project_id}/models/register",
        headers=auth_headers,
        json={"training_job_id": continued["id"], "name": "continued-model"},
    )
    assert registered.status_code == 201, registered.text
    assert registered.json()["lifecycle"] == ModelLifecycle.CANDIDATE.value
    assert registered.json()["lifecycle"] != "PRODUCTION"
