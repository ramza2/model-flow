"""Phase 5-B feedback review and dataset materialization tests."""

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
    Dataset,
    DatasetVersion,
    Endpoint,
    FeedbackMaterializationRun,
    FeedbackReviewStatus,
    GroundTruthFeedback,
    JobStatus,
    ModelLifecycle,
    ModelVersion,
    PredictionObservation,
    Project,
    ProjectMembership,
    ProjectRole,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import closed_loop, datasets, feedback_materialization, mlflow_service, storage
from app.services.target_columns import dumps_target_columns
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
    monkeypatch.setattr(
        storage,
        "delete_object",
        lambda bucket, key: OBJECT_STORE.pop((bucket, key), None),
    )
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
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
        project = Project(name="feedback-mat", created_by=admin.id)
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
        return db.scalar(select(Project.id).where(Project.name == "feedback-mat"))


def _seed_production(db, project_id: int, *, multi_output: bool = False):
    dataset = Dataset(project_id=project_id, name="feedback-ds", created_by=1)
    db.add(dataset)
    db.flush()
    if multi_output:
        csv = (
            b"a,b,target_a,target_b\n"
            b"1,2,1.0,2.0\n2,3,1.5,2.5\n3,4,2.0,3.0\n4,5,2.5,3.5\n"
            b"5,6,3.0,4.0\n6,7,3.5,4.5\n7,8,4.0,5.0\n8,9,4.5,5.5\n"
        )
        targets = ["target_a", "target_b"]
        problem = "regression"
        features = ["a", "b"]
    else:
        csv = CSV_V1
        targets = ["target"]
        problem = "classification"
        features = ["a", "b"]
    version = datasets.create_dataset_version_from_bytes(
        db,
        dataset,
        csv,
        "seed.csv",
        file_format="csv",
        created_by=1,
        source_type="upload",
    )
    job = TrainingJob(
        project_id=project_id,
        dataset_id=dataset.id,
        dataset_version_id=version.id,
        name="source-train",
        target_column=targets[0],
        target_columns_json=dumps_target_columns(targets),
        problem_type=problem,
        algorithm="logistic_regression" if not multi_output else "ridge",
        feature_columns_json=json.dumps(features),
        status=JobStatus.succeeded,
        mlflow_run_id="run-src",
        model_uri="models:/demo/1",
        metrics_json=json.dumps({"accuracy": 0.9} if not multi_output else {"rmse": 0.1}),
    )
    db.add(job)
    db.flush()
    model = ModelVersion(
        project_id=project_id,
        name="iris",
        version="1",
        mlflow_model_name=f"project-{project_id}-iris",
        mlflow_version="1",
        mlflow_run_id="run-src",
        model_uri="models:/demo/1",
        lifecycle=ModelLifecycle.PRODUCTION,
        training_job_id=job.id,
        dataset_version_id=version.id,
        created_by=1,
        metrics_json=job.metrics_json,
        metadata_json=json.dumps(
            {
                "problem_type": problem,
                "target_columns": targets,
                "feature_columns": features,
                "feature_schema": [
                    {"name": "a", "dtype": "float"},
                    {"name": "b", "dtype": "float"},
                ],
            }
        ),
    )
    db.add(model)
    db.flush()
    endpoint = Endpoint(
        project_id=project_id,
        name="prod-ep",
        model_name=model.name,
        model_version=model.version,
        model_version_id=model.id,
        model_uri=model.model_uri,
        status="ready",
        feature_schema_json=json.dumps(
            [{"name": "a", "type": "double"}, {"name": "b", "type": "double"}]
        ),
    )
    db.add(endpoint)
    db.commit()
    return {
        "dataset": dataset,
        "version": version,
        "job": job,
        "model": model,
        "endpoint": endpoint,
        "targets": targets,
        "features": features,
    }


def test_prediction_stores_input_json_jwt_and_alignment(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0, 1])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    response = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["prediction_ids"]) == 2
    with TestingSessionLocal() as db:
        rows = db.scalars(select(PredictionObservation).order_by(PredictionObservation.instance_index)).all()
        assert len(rows) == 2
        assert json.loads(rows[0].input_json) == {"a": 1, "b": 2}
        assert json.loads(rows[1].input_json) == {"a": 3, "b": 4}
        assert rows[0].instance_index == 0
        assert rows[1].instance_index == 1


def test_ground_truth_defaults_pending_and_review_flow(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    predicted = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()
    prediction_id = predicted["prediction_ids"][0]
    gt = client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    assert gt.status_code == 200, gt.text

    listed = client.get(f"/api/v1/projects/{project_id}/feedback", headers=auth_headers)
    assert listed.status_code == 200
    item = listed.json()[0]
    assert item["review_status"] == "PENDING"
    assert item["input_snapshot_available"] is True
    feedback_id = item["id"]

    approved = client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved", "comment": "ok"}]},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["results"][0]["review_status"] == "APPROVED"

    # Idempotent same decision
    again = client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    assert again.status_code == 200
    assert again.json()["results"][0]["idempotent"] is True

    rejected = client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "rejected"}]},
    )
    assert rejected.status_code == 200
    assert rejected.json()["results"][0]["review_status"] == "REJECTED"


def test_viewer_cannot_review_or_materialize(client, viewer_headers, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [1])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 1}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    denied = client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=viewer_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    assert denied.status_code == 403
    listed = client.get(f"/api/v1/projects/{project_id}/feedback", headers=viewer_headers)
    assert listed.status_code == 200


def test_legacy_observation_reviewable_not_materializable(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        obs = PredictionObservation(
            id="legacy-obs",
            project_id=project_id,
            endpoint_id=seeded["endpoint"].id,
            model_version_id=seeded["model"].id,
            request_id="req",
            instance_index=0,
            prediction_json="0",
            input_json=None,
            predicted_at=seeded["model"].created_at,
        )
        db.add(obs)
        fb = GroundTruthFeedback(
            project_id=project_id,
            prediction_observation_id=obs.id,
            actual_json="0",
            source="api",
            review_status=FeedbackReviewStatus.PENDING.value,
        )
        db.add(fb)
        db.commit()
        feedback_id = fb.id

    listed = client.get(f"/api/v1/projects/{project_id}/feedback", headers=auth_headers).json()
    item = next(row for row in listed if row["id"] == feedback_id)
    assert item["input_snapshot_available"] is False
    assert item["materializable"] is False

    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    blocked = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": item["endpoint_id"], "feedback_ids": [feedback_id]},
    )
    assert blocked.status_code in {409, 422}


def test_materialization_creates_immutable_v2_and_cumulative_v3(
    client, auth_headers, project_id, monkeypatch
):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        dataset_id = seeded["dataset"].id
        v1_id = seeded["version"].id
        v1_key = seeded["version"].object_key
        v1_rows = seeded["version"].row_count
        source_job_id = seeded["job"].id

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0, 1])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    preds = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 11, "b": 12}, {"a": 13, "b": 14}]},
    ).json()["prediction_ids"]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={
            "items": [
                {"prediction_id": preds[0], "actual": 0},
                {"prediction_id": preds[1], "actual": 1},
            ]
        },
    )
    feedback = client.get(f"/api/v1/projects/{project_id}/feedback", headers=auth_headers).json()
    # Approve first, reject second
    fb1 = next(row for row in feedback if row["prediction_id"] == preds[0])
    fb2 = next(row for row in feedback if row["prediction_id"] == preds[1])
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={
            "items": [
                {"feedback_id": fb1["id"], "decision": "approved"},
                {"feedback_id": fb2["id"], "decision": "rejected"},
            ]
        },
    )

    created = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [fb1["id"]]},
    )
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    assert created.json()["status"] == "pending"
    assert created.json()["base_dataset_version_id"] == v1_id

    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        runner.process_feedback_materialization_run(run)

    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        assert run.status == JobStatus.succeeded
        assert run.row_count_before == v1_rows
        assert run.row_count_added == 1
        assert run.row_count_after == v1_rows + 1
        v1 = db.get(DatasetVersion, v1_id)
        assert v1.object_key == v1_key
        assert v1.row_count == v1_rows
        output = db.get(DatasetVersion, run.output_dataset_version_id)
        assert output is not None
        assert output.version == 2
        assert output.source_type == "feedback_materialization"
        assert output.row_count == v1_rows + 1
        output_id = output.id
        fb = db.get(GroundTruthFeedback, fb1["id"])
        assert fb.materialized_dataset_version_id == output.id
        frame = datasets.load_dataset_version_dataframe(output)
        assert len(frame) == v1_rows + 1
        assert list(frame.columns) == ["a", "b", "target"]
        last = frame.iloc[-1]
        assert int(last["a"]) == 11 and int(last["b"]) == 12 and int(last["target"]) == 0

        # Rejected feedback not included
        assert not ((frame["a"] == 13) & (frame["b"] == 14)).any()

        # Phase 5-A discovers newer version
        source_job = db.get(TrainingJob, source_job_id)
        newer, reason = closed_loop.find_newer_compatible_dataset_version(
            db, project_id=project_id, source_job=source_job
        )
        assert newer is not None
        assert newer.id == output.id
        assert reason is None

    # Duplicate materialization blocked
    dup = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [fb1["id"]]},
    )
    assert dup.status_code == 409

    # Materialized review mutation blocked
    mutate = client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": fb1["id"], "decision": "rejected"}]},
    )
    assert mutate.status_code == 409

    lineage = client.get(
        f"/api/v1/projects/{project_id}/datasets/{dataset_id}/versions/2/lineage",
        headers=auth_headers,
    )
    assert lineage.status_code == 200
    assert lineage.json()["feedback_materialization"]["type"] == "feedback_materialization"

    # Cumulative: approve another prediction → base v2 → v3
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [1])
    pred_b = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 21, "b": 22}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": pred_b, "actual": 1}]},
    )
    fb_b = client.get(
        f"/api/v1/projects/{project_id}/feedback?review_status=PENDING",
        headers=auth_headers,
    ).json()[0]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": fb_b["id"], "decision": "approved"}]},
    )
    created2 = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [fb_b["id"]]},
    )
    assert created2.status_code == 201, created2.text
    assert created2.json()["base_dataset_version_id"] == output_id
    run2_id = created2.json()["id"]

    with TestingSessionLocal() as db:
        run2 = db.get(FeedbackMaterializationRun, run2_id)
        runner.process_feedback_materialization_run(run2)

    with TestingSessionLocal() as db:
        run2 = db.get(FeedbackMaterializationRun, run2_id)
        assert run2.status == JobStatus.succeeded
        v3 = db.get(DatasetVersion, run2.output_dataset_version_id)
        assert v3.version == 3
        assert v3.row_count == v1_rows + 2
        frame3 = datasets.load_dataset_version_dataframe(v3)
        assert ((frame3["a"] == 11) & (frame3["b"] == 12)).any()
        assert ((frame3["a"] == 21) & (frame3["b"] == 22)).any()


def test_failed_run_releases_reservation(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    created = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    )
    run_id = created.json()["id"]

    monkeypatch.setattr(
        feedback_materialization,
        "execute_materialization_run",
        lambda db, run: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        runner.process_feedback_materialization_run(run)

    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        assert run.status == JobStatus.failed
        assert run.output_dataset_version_id is None
        fb = db.get(GroundTruthFeedback, feedback_id)
        assert fb.materialization_run_id is None
        assert fb.materialized_dataset_version_id is None


def test_multi_output_regression_row_mapping(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id, multi_output=True)
        endpoint_id = seeded["endpoint"].id
        v1_rows = seeded["version"].row_count

    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *a, **k: [{"target_a": 9.0, "target_b": 8.0}],
    )
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 10, "b": 20}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": {"target_a": 10.2, "target_b": 5.7}}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    created = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    )
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        runner.process_feedback_materialization_run(run)
    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        assert run.status == JobStatus.succeeded, run.error_message
        output = db.get(DatasetVersion, run.output_dataset_version_id)
        frame = datasets.load_dataset_version_dataframe(output)
        assert list(frame.columns) == ["a", "b", "target_a", "target_b"]
        last = frame.iloc[-1]
        assert float(last["a"]) == 10 and float(last["b"]) == 20
        assert float(last["target_a"]) == 10.2 and float(last["target_b"]) == 5.7
        assert len(frame) == v1_rows + 1


def test_succeeded_run_worker_idempotent(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    run_id = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    ).json()["id"]
    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        runner.process_feedback_materialization_run(run)
        first_output = db.get(FeedbackMaterializationRun, run_id).output_dataset_version_id
        versions_before = db.scalars(select(DatasetVersion)).all()
        count_before = len(versions_before)
        runner.process_feedback_materialization_run(db.get(FeedbackMaterializationRun, run_id))
        assert db.get(FeedbackMaterializationRun, run_id).output_dataset_version_id == first_output
        assert len(db.scalars(select(DatasetVersion)).all()) == count_before


def _approve_two_feedback(client, auth_headers, project_id, endpoint_id, monkeypatch):
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0, 1])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    preds = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 11, "b": 12}, {"a": 13, "b": 14}]},
    ).json()["prediction_ids"]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={
            "items": [
                {"prediction_id": preds[0], "actual": 0},
                {"prediction_id": preds[1], "actual": 1},
            ]
        },
    )
    feedback = client.get(f"/api/v1/projects/{project_id}/feedback", headers=auth_headers).json()
    fb_a = next(row for row in feedback if row["prediction_id"] == preds[0])
    fb_b = next(row for row in feedback if row["prediction_id"] == preds[1])
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={
            "items": [
                {"feedback_id": fb_a["id"], "decision": "approved"},
                {"feedback_id": fb_b["id"], "decision": "approved"},
            ]
        },
    )
    return fb_a["id"], fb_b["id"]


def test_active_materialization_blocks_stale_base_and_cumulative_after(
    client, auth_headers, project_id, monkeypatch
):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        v1_id = seeded["version"].id
        v1_rows = seeded["version"].row_count

    fb_a, fb_b = _approve_two_feedback(
        client, auth_headers, project_id, endpoint_id, monkeypatch
    )

    run_a = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [fb_a]},
    )
    assert run_a.status_code == 201, run_a.text
    assert run_a.json()["base_dataset_version_id"] == v1_id
    run_a_id = run_a.json()["id"]

    # Second create while Run A is still pending must conflict (no stale fork).
    run_b_blocked = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [fb_b]},
    )
    assert run_b_blocked.status_code == 409, run_b_blocked.text
    assert "active" in run_b_blocked.json()["detail"].lower()

    with TestingSessionLocal() as db:
        runner.process_feedback_materialization_run(
            db.get(FeedbackMaterializationRun, run_a_id)
        )
        run = db.get(FeedbackMaterializationRun, run_a_id)
        assert run.status == JobStatus.succeeded
        v2_id = run.output_dataset_version_id
        assert db.get(DatasetVersion, v2_id).version == 2

    run_b = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [fb_b]},
    )
    assert run_b.status_code == 201, run_b.text
    assert run_b.json()["base_dataset_version_id"] == v2_id
    assert run_b.json()["base_dataset_version"] == 2
    run_b_id = run_b.json()["id"]

    with TestingSessionLocal() as db:
        runner.process_feedback_materialization_run(
            db.get(FeedbackMaterializationRun, run_b_id)
        )
        run = db.get(FeedbackMaterializationRun, run_b_id)
        assert run.status == JobStatus.succeeded
        v3 = db.get(DatasetVersion, run.output_dataset_version_id)
        assert v3.version == 3
        assert v3.row_count == v1_rows + 2
        frame = datasets.load_dataset_version_dataframe(v3)
        assert ((frame["a"] == 11) & (frame["b"] == 12)).any()
        assert ((frame["a"] == 13) & (frame["b"] == 14)).any()


def test_post_upload_alert_failure_cleans_artifact(
    client, auth_headers, project_id, monkeypatch
):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        dataset_id = seeded["dataset"].id
        v1_id = seeded["version"].id
        v1_key = seeded["version"].object_key
        mirror_before = seeded["dataset"].latest_version

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    run_id = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    ).json()["id"]

    keys_before = set(OBJECT_STORE.keys())

    def boom_alert(*_a, **_k):
        raise RuntimeError("alert boom")

    monkeypatch.setattr(feedback_materialization, "create_alert", boom_alert)
    with TestingSessionLocal() as db:
        runner.process_feedback_materialization_run(
            db.get(FeedbackMaterializationRun, run_id)
        )

    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        assert run.status == JobStatus.failed
        assert run.output_dataset_version_id is None
        fb = db.get(GroundTruthFeedback, feedback_id)
        assert fb.materialization_run_id is None
        assert fb.materialized_dataset_version_id is None
        assert db.get(DatasetVersion, v1_id).object_key == v1_key
        dataset = db.get(Dataset, dataset_id)
        assert dataset.latest_version == mirror_before
        versions = db.scalars(
            select(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id)
        ).all()
        assert len(versions) == 1
        assert set(OBJECT_STORE.keys()) == keys_before


def test_worker_commit_failure_cleans_new_artifact(
    client, auth_headers, project_id, monkeypatch
):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        dataset_id = seeded["dataset"].id

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    run_id = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    ).json()["id"]

    keys_before = set(OBJECT_STORE.keys())
    commit_calls = {"n": 0}

    def session_factory():
        db = TestingSessionLocal()
        real_commit = db.commit

        def commit():
            commit_calls["n"] += 1
            # First commit is the success commit after execute — force failure.
            if commit_calls["n"] == 1:
                raise RuntimeError("commit boom")
            return real_commit()

        db.commit = commit  # type: ignore[method-assign]
        return db

    monkeypatch.setattr(runner, "SessionLocal", session_factory)
    with TestingSessionLocal() as db:
        runner.process_feedback_materialization_run(
            db.get(FeedbackMaterializationRun, run_id)
        )

    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        assert run.status == JobStatus.failed
        assert run.output_dataset_version_id is None
        fb = db.get(GroundTruthFeedback, feedback_id)
        assert fb.materialization_run_id is None
        assert fb.materialized_dataset_version_id is None
        assert (
            len(
                db.scalars(
                    select(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id)
                ).all()
            )
            == 1
        )
        assert set(OBJECT_STORE.keys()) == keys_before


def test_prediction_count_mismatch_fail_closed(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id

    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    fewer = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]},
    )
    assert fewer.status_code == 422
    with TestingSessionLocal() as db:
        assert db.scalar(select(PredictionObservation).limit(1)) is None

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0, 1])
    extra = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    )
    assert extra.status_code == 422
    with TestingSessionLocal() as db:
        assert db.scalar(select(PredictionObservation).limit(1)) is None

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0, 1])
    ok = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]},
    )
    assert ok.status_code == 200
    with TestingSessionLocal() as db:
        rows = db.scalars(
            select(PredictionObservation).order_by(PredictionObservation.instance_index)
        ).all()
        assert len(rows) == 2
        assert json.loads(rows[0].input_json) == {"a": 1, "b": 2}
        assert json.loads(rows[1].input_json) == {"a": 3, "b": 4}


def test_service_api_key_prediction_stores_input_json(
    client, auth_headers, project_id, monkeypatch
):
    from app.db.models import ServiceApiKey
    from app.services import service_api_keys

    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        raw_key, prefix, key_hash = service_api_keys.generate_service_api_key(db)
        db.add(
            ServiceApiKey(
                project_id=project_id,
                endpoint_id=endpoint_id,
                name="feedback-sak",
                key_prefix=prefix,
                key_hash=key_hash,
                created_by=1,
                is_active=True,
            )
        )
        db.commit()

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [1, 0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    response = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={"instances": [{"a": 7, "b": 8}, {"a": 9, "b": 10}]},
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["prediction_ids"]) == 2
    with TestingSessionLocal() as db:
        rows = db.scalars(
            select(PredictionObservation).order_by(PredictionObservation.instance_index)
        ).all()
        assert json.loads(rows[0].input_json) == {"a": 7, "b": 8}
        assert json.loads(rows[1].input_json) == {"a": 9, "b": 10}

    mismatch = client.post(
        f"/api/v1/inference/endpoints/{endpoint_id}/predict",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={"instances": [{"a": 1, "b": 2}]},
    )
    # predict still returns 2 from monkeypatch → mismatch
    assert mismatch.status_code == 422


def test_mixed_endpoint_and_model_feedback_rejected(
    client, auth_headers, project_id, monkeypatch
):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model = seeded["model"]
        other_ep = Endpoint(
            project_id=project_id,
            name="other-ep",
            model_name=model.name,
            model_version=model.version,
            model_version_id=model.id,
            model_uri=model.model_uri,
            status="ready",
            feature_schema_json=seeded["endpoint"].feature_schema_json,
        )
        db.add(other_ep)
        db.flush()
        other_endpoint_id = other_ep.id
        # Observation on other endpoint with approved feedback
        obs = PredictionObservation(
            id="other-ep-obs",
            project_id=project_id,
            endpoint_id=other_endpoint_id,
            model_version_id=model.id,
            request_id="req-other",
            instance_index=0,
            prediction_json="0",
            input_json=json.dumps({"a": 1, "b": 2}),
            predicted_at=model.created_at,
        )
        db.add(obs)
        fb = GroundTruthFeedback(
            project_id=project_id,
            prediction_observation_id=obs.id,
            actual_json="0",
            source="api",
            review_status=FeedbackReviewStatus.APPROVED.value,
        )
        db.add(fb)
        db.commit()
        mixed_feedback_id = fb.id

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    own_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()
    own_feedback = next(row for row in own_id if row["prediction_id"] == prediction_id)
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": own_feedback["id"], "decision": "approved"}]},
    )

    mixed = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "feedback_ids": [own_feedback["id"], mixed_feedback_id],
        },
    )
    assert mixed.status_code == 422
    assert "endpoint" in mixed.json()["detail"].lower()


def test_cross_project_feedback_isolation(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        other = Project(name="other-feedback-project", created_by=1)
        db.add(other)
        db.flush()
        other_id = other.id

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]

    cross_list = client.get(
        f"/api/v1/projects/{other_id}/feedback", headers=auth_headers
    )
    assert cross_list.status_code in {200, 403, 404}
    if cross_list.status_code == 200:
        assert cross_list.json() == []

    cross_review = client.post(
        f"/api/v1/projects/{other_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    assert cross_review.status_code in {403, 404}

    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    cross_mat = client.post(
        f"/api/v1/projects/{other_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    )
    assert cross_mat.status_code in {403, 404, 422}


def test_compatibility_failure_rolls_back_and_cleans(
    client, auth_headers, project_id, monkeypatch
):
    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
        dataset_id = seeded["dataset"].id
        v1_id = seeded["version"].id
        mirror_before = seeded["dataset"].latest_version

    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved"}]},
    )
    run_id = client.post(
        f"/api/v1/projects/{project_id}/feedback-materializations",
        headers=auth_headers,
        json={"endpoint_id": endpoint_id, "feedback_ids": [feedback_id]},
    ).json()["id"]

    keys_before = set(OBJECT_STORE.keys())
    from app.services.retrain_service import RetrainConfigError

    def flaky_prepare(*_args, **_kwargs):
        raise RetrainConfigError("forced incompat")

    # Patch after run creation so only execute-time compatibility check fails.
    monkeypatch.setattr(feedback_materialization, "prepare_retrain_job", flaky_prepare)
    with TestingSessionLocal() as db:
        runner.process_feedback_materialization_run(
            db.get(FeedbackMaterializationRun, run_id)
        )

    with TestingSessionLocal() as db:
        run = db.get(FeedbackMaterializationRun, run_id)
        assert run.status == JobStatus.failed
        assert run.output_dataset_version_id is None
        fb = db.get(GroundTruthFeedback, feedback_id)
        assert fb.materialization_run_id is None
        assert fb.materialized_dataset_version_id is None
        assert db.get(Dataset, dataset_id).latest_version == mirror_before
        assert db.get(DatasetVersion, v1_id) is not None
        assert (
            len(
                db.scalars(
                    select(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id)
                ).all()
            )
            == 1
        )
        assert set(OBJECT_STORE.keys()) == keys_before


def test_review_comment_update_writes_audit(client, auth_headers, project_id, monkeypatch):
    from app.db.models import AuditLog

    with TestingSessionLocal() as db:
        seeded = _seed_production(db, project_id)
        endpoint_id = seeded["endpoint"].id
    monkeypatch.setattr("app.services.inference.predict", lambda *a, **k: [0])
    monkeypatch.setattr("app.services.inference.validate_instances", lambda *a, **k: None)
    prediction_id = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}]},
    ).json()["prediction_ids"][0]
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": prediction_id, "actual": 0}]},
    )
    feedback_id = client.get(
        f"/api/v1/projects/{project_id}/feedback", headers=auth_headers
    ).json()[0]["id"]
    client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={"items": [{"feedback_id": feedback_id, "decision": "approved", "comment": "first"}]},
    )
    updated = client.post(
        f"/api/v1/projects/{project_id}/feedback/review",
        headers=auth_headers,
        json={
            "items": [
                {"feedback_id": feedback_id, "decision": "approved", "comment": "revised"}
            ]
        },
    )
    assert updated.status_code == 200
    assert updated.json()["results"][0]["idempotent"] is True

    with TestingSessionLocal() as db:
        fb = db.get(GroundTruthFeedback, feedback_id)
        assert fb.review_comment == "revised"
        actions = [
            row.action
            for row in db.scalars(
                select(AuditLog)
                .where(AuditLog.resource_type == "ground_truth_feedback")
                .order_by(AuditLog.id.asc())
            ).all()
        ]
        assert "feedback.review.approve" in actions
        assert "feedback.review.comment_update" in actions
