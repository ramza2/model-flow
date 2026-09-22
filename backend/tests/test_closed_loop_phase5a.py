"""Phase 5-A closed-loop MLOps foundation — API and orchestration tests."""

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
    Alert,
    Base,
    Dataset,
    DatasetVersion,
    Endpoint,
    GroundTruthFeedback,
    JobStatus,
    ModelLifecycle,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
    PredictionObservation,
    Project,
    ProjectMembership,
    ProjectRole,
    RetrainTrigger,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import closed_loop, mlflow_service, registry_service, storage
from app.services import model_quality as quality_service
from app.workers import runner

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
ADMIN_PASSWORD = secrets.token_urlsafe(24)
VIEWER_PASSWORD = secrets.token_urlsafe(24)
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
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    with TestingSessionLocal() as db:
        admin = User(
            email="admin@example.com",
            full_name="Admin",
            password_hash=hash_password(ADMIN_PASSWORD),
            is_active=True,
            is_system_admin=True,
        )
        viewer = User(
            email="viewer@example.com",
            full_name="Viewer",
            password_hash=hash_password(VIEWER_PASSWORD),
            is_active=True,
        )
        db.add_all([admin, viewer])
        db.flush()
        project = Project(name="closed-loop", created_by=admin.id)
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
        json={"email": "admin@example.com", "password": ADMIN_PASSWORD},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
def viewer_headers(client):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "viewer@example.com", "password": VIEWER_PASSWORD},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
def project_id():
    with TestingSessionLocal() as db:
        return db.scalar(select(Project.id).where(Project.name == "closed-loop"))


def _seed_production_endpoint(db, project_id: int, *, with_v2: bool = True):
    from app.core.config import settings

    dataset = Dataset(
        project_id=project_id,
        name="iris",
        object_key="ds/v1.csv",
        latest_version=2 if with_v2 else 1,
    )
    db.add(dataset)
    db.flush()
    OBJECT_STORE[(settings.minio_datasets_bucket, "ds/v1.csv")] = CSV_V1
    v1 = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project_id,
        version=1,
        object_key="ds/v1.csv",
        original_filename="v1.csv",
        format="csv",
        row_count=10,
        column_count=3,
        dtypes_json=json.dumps({"a": "int64", "b": "int64", "target": "int64"}),
        columns_json=json.dumps(["a", "b", "target"]),
    )
    db.add(v1)
    db.flush()
    v2 = None
    if with_v2:
        OBJECT_STORE[(settings.minio_datasets_bucket, "ds/v2.csv")] = CSV_V2
        v2 = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project_id,
            version=2,
            object_key="ds/v2.csv",
            original_filename="v2.csv",
            format="csv",
            row_count=10,
            column_count=3,
            dtypes_json=json.dumps({"a": "int64", "b": "int64", "target": "int64"}),
            columns_json=json.dumps(["a", "b", "target"]),
        )
        db.add(v2)
        db.flush()

    job = TrainingJob(
        project_id=project_id,
        dataset_id=dataset.id,
        dataset_version_id=v1.id,
        name="prod-train",
        target_column="target",
        target_columns_json=json.dumps(["target"]),
        problem_type="classification",
        algorithm="logistic_regression",
        feature_columns_json=json.dumps(["a", "b"]),
        status=JobStatus.succeeded,
        mlflow_run_id="run-prod",
        model_uri="models:/project-1-iris/1",
        metrics_json=json.dumps({"accuracy": 0.9, "f1_macro": 0.9}),
    )
    db.add(job)
    db.flush()
    model = ModelVersion(
        project_id=project_id,
        name="iris",
        version="1",
        lifecycle=ModelLifecycle.PRODUCTION,
        mlflow_model_name=f"project-{project_id}-iris",
        mlflow_version="1",
        mlflow_run_id="run-prod",
        model_uri="models:/demo/1",
        metrics_json=json.dumps({"accuracy": 0.9, "f1_macro": 0.9}),
        metadata_json=json.dumps(
            {
                "problem_type": "classification",
                "target_columns": ["target"],
                "feature_schema": [
                    {"name": "a", "dtype": "float"},
                    {"name": "b", "dtype": "float"},
                ],
            }
        ),
        dataset_version_id=v1.id,
        training_job_id=job.id,
        gates_passed=True,
    )
    db.add(model)
    db.flush()
    endpoint = Endpoint(
        project_id=project_id,
        name="prod-endpoint",
        model_name=model.name,
        model_version=model.version,
        model_version_id=model.id,
        model_uri=model.model_uri,
        status="ready",
        feature_schema_json=json.dumps(
            [{"name": "a", "dtype": "float"}, {"name": "b", "dtype": "float"}]
        ),
    )
    db.add(endpoint)
    db.commit()
    return {
        "dataset": dataset,
        "v1": v1,
        "v2": v2,
        "job": job,
        "model": model,
        "endpoint": endpoint,
    }


def test_prediction_ids_and_model_version_snapshot(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model_id = seeded["model"].id

    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *args, **kwargs: [0, 1, 0],
    )
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *args, **kwargs: None)

    response = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}, {"a": 3, "b": 4}, {"a": 5, "b": 6}]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["predictions"] == [0, 1, 0]
    assert len(body["prediction_ids"]) == 3
    assert body["prediction_ids"][0] != body["prediction_ids"][1]

    with TestingSessionLocal() as db:
        rows = db.scalars(select(PredictionObservation)).all()
        assert len(rows) == 3
        assert {row.model_version_id for row in rows} == {model_id}
        # Swap endpoint model; historical observations keep snapshot.
        endpoint = db.get(Endpoint, endpoint_id)
        endpoint.model_version_id = None
        db.commit()
        still = db.get(PredictionObservation, body["prediction_ids"][0])
        assert still.model_version_id == model_id


def test_ground_truth_idempotency_and_conflict(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
    monkeypatch.setattr("app.services.inference.predict", lambda *args, **kwargs: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *args, **kwargs: None)
    predicted = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()
    prediction_id = predicted["prediction_ids"][0]

    first = client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    assert first.status_code == 200, first.text
    assert first.json()["accepted"][0]["idempotent"] is False

    same = client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    assert same.status_code == 200
    assert same.json()["accepted"][0]["idempotent"] is True

    conflict = client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 1}]},
    )
    assert conflict.status_code == 409


def test_viewer_cannot_write_ground_truth(client, viewer_headers, project_id):
    response = client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=viewer_headers,
        json={"items": [{"prediction_id": "00000000-0000-0000-0000-000000000001", "actual": 0}]},
    )
    assert response.status_code == 403


def test_closed_loop_retrain_to_candidate_without_auto_promote(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production_endpoint(db, project_id, with_v2=True)
        endpoint_id = seeded["endpoint"].id
        model_a_id = seeded["model"].id
        source_job_id = seeded["job"].id
        v2_id = seeded["v2"].id

        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=endpoint_id,
            name="prod-quality",
            is_active=True,
            window_hours=24,
            minimum_matched_samples=3,
            primary_metric="accuracy",
            warning_threshold=0.8,
            critical_threshold=0.7,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=True,
        )
        db.add(policy)
        db.commit()
        policy_id = policy.id

    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *args, **kwargs: [1, 1, 1, 1],
    )
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *args, **kwargs: None)

    predicted = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={
            "instances": [
                {"a": 1, "b": 2},
                {"a": 3, "b": 4},
                {"a": 5, "b": 6},
                {"a": 7, "b": 8},
            ]
        },
    ).json()
    # All actuals differ from predicted 1 → accuracy 0.
    items = [
        {"prediction_id": pid, "actual": 0}
        for pid in predicted["prediction_ids"]
    ]
    assert (
        client.post(
            f"/api/v1/projects/{project_id}/ground-truth",
            headers=auth_headers,
            json={"items": items},
        ).status_code
        == 200
    )

    evaluate = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/evaluate",
        headers=auth_headers,
    )
    assert evaluate.status_code == 201, evaluate.text
    run_id = evaluate.json()["id"]

    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        assert run is not None
        run.status = JobStatus.pending
        db.commit()

    claimed = runner.claim_next_model_quality_run()
    assert claimed is not None
    runner.process_model_quality_run(claimed)

    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        assert run.status == JobStatus.succeeded
        assert run.quality_status == "critical"
        assert run.matched_ground_truth_count == 4
        decision = json.loads(run.trigger_decision_json)
        assert decision["action"] == "retrain_triggered"
        assert decision["target_dataset_version_id"] == v2_id

        alerts = db.scalars(
            select(Alert).where(Alert.alert_type == "model_quality_degradation")
        ).all()
        assert len(alerts) == 1
        assert alerts[0].resource_id == str(run_id)

        triggers = db.scalars(
            select(RetrainTrigger).where(RetrainTrigger.quality_run_id == run_id)
        ).all()
        assert len(triggers) == 1
        trigger = triggers[0]
        job_b = db.get(TrainingJob, trigger.created_training_job_id)
        assert job_b is not None
        assert job_b.retrain_source_job_id == source_job_id
        assert job_b.dataset_version_id == v2_id
        assert job_b.status == JobStatus.pending

        # Simulate training success + candidate registration.
        job_b.status = JobStatus.succeeded
        job_b.mlflow_run_id = "run-candidate"
        job_b.model_uri = "models:/demo/2"
        job_b.metrics_json = json.dumps({"accuracy": 0.95, "f1_macro": 0.95})
        db.commit()

        def fake_register_from_run(db_session, **kwargs):
            row = ModelVersion(
                project_id=kwargs["project_id"],
                name="iris",
                version="2",
                lifecycle=ModelLifecycle.CANDIDATE,
                mlflow_model_name=f"project-{kwargs['project_id']}-iris",
                mlflow_version="2",
                mlflow_run_id=kwargs["run_id"],
                model_uri="models:/demo/2",
                metrics_json=job_b.metrics_json,
                metadata_json=json.dumps({"problem_type": "classification"}),
                dataset_version_id=kwargs.get("dataset_version_id"),
                training_job_id=kwargs.get("training_job_id"),
                gates_passed=True,
            )
            db_session.add(row)
            db_session.flush()
            return row

        monkeypatch.setattr(registry_service, "register_from_run", fake_register_from_run)
        monkeypatch.setattr(
            registry_service,
            "evaluate_gates",
            lambda db_session, row, actor_id=None: {
                "passed": True,
                "results": [],
            },
        )
        candidate = closed_loop.register_candidate_idempotently(db, training_job=job_b)
        db.commit()
        assert candidate is not None
        assert candidate.lifecycle == ModelLifecycle.CANDIDATE
        assert candidate.id != model_a_id
        model_a = db.get(ModelVersion, model_a_id)
        assert model_a.lifecycle == ModelLifecycle.PRODUCTION
        endpoint = db.get(Endpoint, endpoint_id)
        assert endpoint.model_version_id == model_a_id
        meta = json.loads(candidate.metadata_json)
        assert meta["closed_loop"]["quality_run_id"] == run_id
        ready = db.scalars(
            select(Alert).where(Alert.alert_type == "retraining_candidate_ready")
        ).all()
        assert len(ready) == 1

        # Idempotent registration
        again = closed_loop.register_candidate_idempotently(db, training_job=job_b)
        assert again.id == candidate.id

        # No auto approval/promote
        assert candidate.lifecycle == ModelLifecycle.CANDIDATE
        assert db.scalar(
            select(ModelVersion).where(
                ModelVersion.id == candidate.id,
                ModelVersion.lifecycle == ModelLifecycle.PRODUCTION,
            )
        ) is None


def test_no_retrain_without_newer_dataset(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production_endpoint(db, project_id, with_v2=False)
        endpoint_id = seeded["endpoint"].id
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=endpoint_id,
            name="no-data",
            is_active=True,
            window_hours=24,
            minimum_matched_samples=2,
            primary_metric="accuracy",
            warning_threshold=0.9,
            critical_threshold=0.8,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=True,
        )
        db.add(policy)
        db.commit()
        policy_id = policy.id

    monkeypatch.setattr("app.services.inference.predict", lambda *args, **kwargs: [1, 1])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *args, **kwargs: None)
    predicted = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]},
    ).json()
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={
            "items": [
                {"prediction_id": predicted["prediction_ids"][0], "actual": 0},
                {"prediction_id": predicted["prediction_ids"][1], "actual": 0},
            ]
        },
    )
    run_id = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/evaluate",
        headers=auth_headers,
    ).json()["id"]
    with TestingSessionLocal() as db:
        db.get(ModelQualityRun, run_id).status = JobStatus.pending
        db.commit()
    claimed = runner.claim_next_model_quality_run()
    runner.process_model_quality_run(claimed)
    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        decision = json.loads(run.trigger_decision_json)
        assert decision["action"] == "skipped"
        assert decision["reason"] == "no_new_dataset_version"
        assert db.scalar(select(RetrainTrigger).where(RetrainTrigger.quality_run_id == run_id)) is None
        blocked = db.scalars(
            select(Alert).where(Alert.alert_type == "retrain_blocked_no_new_data")
        ).all()
        assert len(blocked) == 1


def test_insufficient_samples_skips_alerts_and_retrain(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=endpoint_id,
            name="min-samples",
            is_active=True,
            window_hours=24,
            minimum_matched_samples=50,
            primary_metric="accuracy",
            warning_threshold=0.9,
            critical_threshold=0.8,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=True,
        )
        db.add(policy)
        db.commit()
        policy_id = policy.id
    monkeypatch.setattr("app.services.inference.predict", lambda *args, **kwargs: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *args, **kwargs: None)
    predicted = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": predicted["prediction_ids"][0], "actual": 1}]},
    )
    run_id = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/evaluate",
        headers=auth_headers,
    ).json()["id"]
    with TestingSessionLocal() as db:
        db.get(ModelQualityRun, run_id).status = JobStatus.pending
        db.commit()
    runner.process_model_quality_run(runner.claim_next_model_quality_run())
    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        assert run.quality_status == "insufficient_data"
        assert json.loads(run.trigger_decision_json)["reason"] == "insufficient_data"
        assert (
            db.scalar(
                select(Alert).where(Alert.alert_type == "model_quality_degradation")
            )
            is None
        )
