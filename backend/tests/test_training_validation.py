from __future__ import annotations

import json
import secrets

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, JobStatus, TrainingJob, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import inference, mlflow_service, registry_service, storage
from app.services.algorithm_catalog import detect_problem_type, list_algorithms

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)


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


def _project(client, auth_headers, name="train-ux"):
    response = client.post(
        "/api/v1/projects", headers=auth_headers, json={"name": name}
    )
    assert response.status_code == 201
    return response.json()["id"]


def _upload(client, auth_headers, project_id: int, csv: bytes, filename="data.csv"):
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (filename, csv, "text/csv")},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_algorithm_catalog_lists_six_algorithms(client, auth_headers):
    project_id = _project(client, auth_headers, "catalog")
    response = client.get(
        f"/api/v1/projects/{project_id}/training/algorithms",
        headers=auth_headers,
    )
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["algorithms"]}
    assert ids == {
        "random_forest",
        "logistic_regression",
        "gradient_boosting",
        "ridge",
        "random_forest_regressor",
        "gradient_boosting_regressor",
    }
    assert len(list_algorithms("classification")) == 3
    assert len(list_algorithms("regression")) == 3


def test_detect_problem_type_string_and_continuous():
    assert detect_problem_type(pd.Series(["a", "b", "a", "c"])) == "classification"
    assert (
        detect_problem_type(pd.Series([1.1, 2.2, 3.3, 4.4, 5.5, 6.6])) == "regression"
    )


def test_classification_rejects_ridge(client, auth_headers):
    project_id = _project(client, auth_headers, "cls-ridge")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1,2,0\n2,3,1\n3,4,0\n4,5,1\n",
    )
    before = client.get(
        f"/api/v1/projects/{project_id}/jobs", headers=auth_headers
    ).json()
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "bad-ridge",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "problem_type": "classification",
            "algorithm": "ridge",
            "feature_columns": ["a", "b"],
        },
    )
    assert response.status_code == 422
    assert "Ridge regression is not supported for classification" in response.json()["detail"]
    after = client.get(
        f"/api/v1/projects/{project_id}/jobs", headers=auth_headers
    ).json()
    assert len(after) == len(before)


def test_regression_rejects_logistic(client, auth_headers):
    project_id = _project(client, auth_headers, "reg-lr")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1.0,2.0,1.5\n2.0,3.0,2.5\n3.0,4.0,3.5\n4.0,5.0,4.5\n",
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "bad-lr",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "problem_type": "regression",
            "algorithm": "logistic_regression",
            "feature_columns": ["a", "b"],
        },
    )
    assert response.status_code == 422
    assert "Logistic regression is not supported for regression" in response.json()["detail"]


def test_ridge_rejects_random_forest_hyperparameters(client, auth_headers):
    project_id = _project(client, auth_headers, "ridge-hp")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1.0,2.0,1.5\n2.0,3.0,2.5\n3.0,4.0,3.5\n4.0,5.0,4.5\n",
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "bad-hp",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "problem_type": "regression",
            "algorithm": "ridge",
            "hyperparameters": {"n_estimators": 100, "max_depth": 5},
            "feature_columns": ["a", "b"],
        },
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "Unsupported hyperparameters for ridge" in detail
    assert "n_estimators" in detail
    assert "max_depth" in detail


def test_random_forest_accepted(client, auth_headers):
    project_id = _project(client, auth_headers, "rf-ok")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1,2,0\n2,3,1\n3,4,0\n4,5,1\n",
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "rf-ok",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "problem_type": "classification",
            "algorithm": "random_forest",
            "hyperparameters": {"n_estimators": 50, "max_depth": 4},
            "feature_columns": ["a", "b"],
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["algorithm"] == "random_forest"


def test_auto_problem_type_resolution(client, auth_headers):
    project_id = _project(client, auth_headers, "auto-detect")
    classification = _upload(
        client,
        auth_headers,
        project_id,
        b"a,label\n1,cat\n2,dog\n3,cat\n4,bird\n",
        filename="cls.csv",
    )
    resolved = client.post(
        f"/api/v1/projects/{project_id}/training/resolve-problem-type",
        headers=auth_headers,
        json={
            "dataset_id": classification["id"],
            "dataset_version_id": classification["version"]["id"],
            "target_column": "label",
            "problem_type": "auto",
        },
    )
    assert resolved.status_code == 200
    assert resolved.json()["resolved_problem_type"] == "classification"

    regression = _upload(
        client,
        auth_headers,
        project_id,
        b"a,value\n1.0,1.25\n2.0,2.5\n3.0,3.75\n4.0,5.0\n5.0,6.25\n6.0,7.5\n",
        filename="reg.csv",
    )
    resolved_reg = client.post(
        f"/api/v1/projects/{project_id}/training/resolve-problem-type",
        headers=auth_headers,
        json={
            "dataset_id": regression["id"],
            "dataset_version_id": regression["version"]["id"],
            "target_column": "value",
            "problem_type": "auto",
        },
    )
    assert resolved_reg.status_code == 200
    assert resolved_reg.json()["resolved_problem_type"] == "regression"


def test_feature_column_validations(client, auth_headers):
    project_id = _project(client, auth_headers, "features")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1,2,0\n2,3,1\n3,4,0\n4,5,1\n",
    )
    empty = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "empty-features",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "feature_columns": [],
            "algorithm": "random_forest",
        },
    )
    assert empty.status_code == 422
    assert "at least one feature" in empty.json()["detail"].lower()

    with_target = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "target-as-feature",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "feature_columns": ["a", "target"],
            "algorithm": "random_forest",
        },
    )
    assert with_target.status_code == 422
    assert "target column cannot also be a feature" in with_target.json()["detail"].lower()

    missing = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "missing-feature",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "feature_columns": ["a", "missing_col"],
            "algorithm": "random_forest",
        },
    )
    assert missing.status_code == 422
    assert "missing_col" in missing.json()["detail"]


def test_invalid_retry_returns_422_without_new_job(client, auth_headers):
    project_id = _project(client, auth_headers, "retry-invalid")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1,2,0\n2,3,1\n3,4,0\n4,5,1\n",
    )
    with TestingSessionLocal() as db:
        job = TrainingJob(
            project_id=project_id,
            dataset_id=dataset["id"],
            dataset_version_id=dataset["version"]["id"],
            name="legacy-bad",
            target_column="target",
            problem_type="classification",
            algorithm="ridge",
            hyperparameters_json="{}",
            feature_columns_json=json.dumps(["a", "b"]),
            status=JobStatus.failed,
            max_retries=3,
            retry_count=0,
            logs="failed\n",
            error_message="bad algorithm",
            created_by=1,
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        job_id = job.id

    before = client.get(
        f"/api/v1/projects/{project_id}/jobs", headers=auth_headers
    ).json()
    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{job_id}/retry",
        headers=auth_headers,
    )
    assert response.status_code == 422
    after = client.get(
        f"/api/v1/projects/{project_id}/jobs", headers=auth_headers
    ).json()
    assert len(after) == len(before)


def test_pending_cancel_sets_finished_at(client, auth_headers):
    project_id = _project(client, auth_headers, "cancel-finish")
    dataset = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1,2,0\n2,3,1\n3,4,0\n4,5,1\n",
    )
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "to-cancel",
            "dataset_id": dataset["id"],
            "dataset_version_id": dataset["version"]["id"],
            "target_column": "target",
            "algorithm": "random_forest",
            "feature_columns": ["a", "b"],
        },
    )
    assert created.status_code == 201
    job_id = created.json()["id"]
    cancelled = client.post(
        f"/api/v1/projects/{project_id}/jobs/{job_id}/cancel",
        headers=auth_headers,
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["finished_at"] is not None


def test_stopped_endpoint_prediction_returns_409(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers, "stopped-predict")
    # Minimal approved model + endpoint via direct DB helpers used elsewhere is heavy;
    # exercise the predict path by creating an endpoint row through the API after soft stubs.
    from app.db.models import Endpoint, ModelLifecycle, ModelVersion

    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name="served",
            version="1",
            lifecycle=ModelLifecycle.PRODUCTION,
            mlflow_model_name=f"project-{project_id}-served",
            mlflow_version="1",
            mlflow_run_id="run-1",
            model_uri="models:/served/1",
            gates_passed=True,
            gate_results_json=json.dumps({"passed": True}),
            metadata_json=json.dumps(
                {
                    "feature_schema": [
                        {"name": "a", "dtype": "float64"},
                        {"name": "b", "dtype": "float64"},
                    ]
                }
            ),
        )
        db.add(model)
        db.flush()
        endpoint = Endpoint(
            project_id=project_id,
            name="stopped-ep",
            model_name="served",
            model_version="1",
            model_version_id=model.id,
            model_uri=model.model_uri,
            status="stopped",
            feature_schema_json=json.dumps(
                [
                    {"name": "a", "dtype": "float64"},
                    {"name": "b", "dtype": "float64"},
                ]
            ),
            created_by=1,
        )
        db.add(endpoint)
        db.commit()
        db.refresh(endpoint)
        endpoint_id = endpoint.id

    monkeypatch.setattr(inference, "validate_instances", lambda *args, **kwargs: None)
    response = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1.0, "b": 2.0}]},
    )
    assert response.status_code == 409
    body = response.json()
    assert "stopped" in body["detail"].lower()
    assert "Start the endpoint" in body["hint"]


def test_get_endpoint_includes_prediction_sample_from_preview(client, auth_headers):
    from app.db.models import (
        Dataset,
        DatasetVersion,
        Endpoint,
        ModelLifecycle,
        ModelVersion,
        TrainingJob,
    )

    project_id = _project(client, auth_headers, "predict-sample-get")
    with TestingSessionLocal() as db:
        dataset = Dataset(
            project_id=project_id,
            name="demand",
            object_key="demand.csv",
            latest_version=1,
        )
        db.add(dataset)
        db.flush()
        version = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project_id,
            version=1,
            object_key="demand.csv",
            original_filename="demand.csv",
            format="csv",
            preview_json=json.dumps(
                [
                    {
                        "site_id": "SITE_A",
                        "measured_at": "2026-07-01T09:00:00",
                        "supply_temp": 72.4,
                        "demand_level": "HIGH",
                    }
                ]
            ),
            dtypes_json=json.dumps(
                {
                    "site_id": "object",
                    "measured_at": "datetime64[ns]",
                    "supply_temp": "float64",
                    "demand_level": "object",
                }
            ),
        )
        db.add(version)
        db.flush()
        job = TrainingJob(
            project_id=project_id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="train",
            target_column="demand_level",
            feature_columns_json=json.dumps(
                ["site_id", "measured_at", "supply_temp"]
            ),
        )
        db.add(job)
        db.flush()
        model = ModelVersion(
            project_id=project_id,
            name="demand-model",
            version="1",
            lifecycle=ModelLifecycle.PRODUCTION,
            mlflow_model_name=f"project-{project_id}-demand",
            mlflow_version="1",
            mlflow_run_id="run-sample",
            model_uri="models:/demand/1",
            training_job_id=job.id,
            gates_passed=True,
            gate_results_json=json.dumps({"passed": True}),
            metadata_json="{}",
        )
        db.add(model)
        db.flush()
        endpoint = Endpoint(
            project_id=project_id,
            name="demand-ep",
            model_name=model.name,
            model_version=model.version,
            model_version_id=model.id,
            model_uri=model.model_uri,
            status="ready",
            feature_schema_json=json.dumps(
                ["site_id", "measured_at", "supply_temp"]
            ),
            created_by=1,
        )
        db.add(endpoint)
        db.commit()
        db.refresh(endpoint)
        endpoint_id = endpoint.id

    response = client.get(
        f"/api/v1/endpoints/{endpoint_id}",
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["prediction_sample"] == {
        "site_id": "SITE_A",
        "measured_at": "2026-07-01T09:00:00",
        "supply_temp": 72.4,
    }
    assert "demand_level" not in body["prediction_sample"]


def test_evaluate_gates_endpoint_still_works(client, auth_headers, monkeypatch):
    project_id = _project(client, auth_headers, "gates-rerun")
    from app.db.models import ModelLifecycle, ModelVersion

    with TestingSessionLocal() as db:
        model = ModelVersion(
            project_id=project_id,
            name="candidate",
            version="1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project_id}-candidate",
            mlflow_version="1",
            mlflow_run_id="run-gates",
            model_uri="models:/candidate/1",
            gates_passed=False,
            gate_results_json="{}",
            metrics_json=json.dumps({"accuracy": 0.99}),
            metadata_json=json.dumps({"feature_schema": [{"name": "a", "dtype": "float64"}]}),
        )
        db.add(model)
        db.commit()
        db.refresh(model)
        model_id = model.id

    def fake_evaluate(db, row, **kwargs):
        row.gates_passed = True
        row.gate_results_json = json.dumps(
            {"passed": True, "computed_by": "server", "checks": {"ok": True}}
        )
        return json.loads(row.gate_results_json)

    monkeypatch.setattr(registry_service, "evaluate_gates", fake_evaluate)
    response = client.post(
        f"/api/v1/projects/{project_id}/models/{model_id}/evaluate-gates",
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["gates_passed"] is True
