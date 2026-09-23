"""Phase 5-D closed-loop UX / hardening regressions."""

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
    JobStatus,
    ModelLifecycle,
    ModelQualityPolicy,
    ModelQualityRun,
    ModelVersion,
    Project,
    RetrainTrigger,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import closed_loop, closed_loop_ux, mlflow_service, storage
from app.services import registry_service
from app.workers import runner

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
ADMIN_PASSWORD = secrets.token_urlsafe(24)
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
        db.add(admin)
        db.flush()
        project = Project(name="phase5d", created_by=admin.id)
        db.add(project)
        db.commit()

    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    token = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": ADMIN_PASSWORD},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def project_id():
    with TestingSessionLocal() as db:
        return db.scalar(select(Project.id))


def _seed_endpoint(db, project_id: int):
    from app.core.config import settings

    dataset = Dataset(
        project_id=project_id,
        name="ds-phase5d",
        object_key="ds/v1.csv",
        latest_version=1,
    )
    db.add(dataset)
    db.flush()
    OBJECT_STORE[(settings.minio_datasets_bucket, "ds/v1.csv")] = CSV_V1
    cols = ["a", "b", "target"]
    dtypes = {c: "int64" for c in cols}
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project_id,
        version=1,
        object_key="ds/v1.csv",
        original_filename="v1.csv",
        format="csv",
        row_count=10,
        column_count=3,
        dtypes_json=json.dumps(dtypes),
        columns_json=json.dumps(cols),
    )
    db.add(version)
    db.flush()
    job = TrainingJob(
        project_id=project_id,
        dataset_id=dataset.id,
        dataset_version_id=version.id,
        name="prod-train",
        target_column="target",
        target_columns_json=json.dumps(["target"]),
        problem_type="classification",
        algorithm="logistic_regression",
        feature_columns_json=json.dumps(["a", "b"]),
        status=JobStatus.succeeded,
        mlflow_run_id="run-prod",
        model_uri="models:/demo/1",
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
        dataset_version_id=version.id,
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
    db.flush()
    return {
        "endpoint_id": endpoint.id,
        "model_version_id": model.id,
        "dataset_id": dataset.id,
        "dataset_version_id": version.id,
        "training_job_id": job.id,
    }


def _seed_quality_run(
    db,
    *,
    project_id: int,
    endpoint_id: int,
    policy_id: int,
    model_version_id: int,
    quality_status: str = "ok",
    status: JobStatus = JobStatus.succeeded,
    matched: int = 20,
    predictions: int = 20,
    match_rate: float = 1.0,
    metrics: str = '{"f1_macro": 0.9}',
    evaluation: str | None = None,
    trigger_decision: str | None = None,
):
    run = ModelQualityRun(
        project_id=project_id,
        policy_id=policy_id,
        endpoint_id=endpoint_id,
        model_version_id=model_version_id,
        status=status,
        quality_status=quality_status,
        window_start=datetime.now(timezone.utc) - timedelta(hours=24),
        window_end=datetime.now(timezone.utc),
        prediction_count=predictions,
        matched_ground_truth_count=matched,
        match_rate=match_rate,
        metrics_json=metrics,
        evaluation_json=evaluation or "{}",
        trigger_decision_json=trigger_decision or "{}",
        policy_revision=1,
        policy_snapshot_json="{}",
        finished_at=datetime.now(timezone.utc),
    )
    db.add(run)
    db.flush()
    return run


def test_quality_run_filters_and_paged_total(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        db.commit()

    policy = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "name": "filter-policy",
            "endpoint_id": seeded["endpoint_id"],
            "primary_metric": "f1_macro",
            "warning_threshold": 0.7,
            "critical_threshold": 0.5,
            "minimum_matched_samples": 5,
            "auto_retrain": False,
        },
    ).json()

    with TestingSessionLocal() as db:
        _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy["id"],
            model_version_id=seeded["model_version_id"],
            quality_status="ok",
        )
        _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy["id"],
            model_version_id=seeded["model_version_id"],
            quality_status="critical",
        )
        db.commit()

    bare = client.get(
        f"/api/v1/projects/{project_id}/model-quality/runs",
        headers=auth_headers,
        params={
            "endpoint_id": seeded["endpoint_id"],
            "quality_status": "ok",
            "limit": 10,
        },
    )
    assert bare.status_code == 200
    assert isinstance(bare.json(), list)
    assert all(row["quality_status"] == "ok" for row in bare.json())

    paged = client.get(
        f"/api/v1/projects/{project_id}/model-quality/runs",
        headers=auth_headers,
        params={
            "endpoint_id": seeded["endpoint_id"],
            "model_version_id": seeded["model_version_id"],
            "quality_status": "ok",
            "status": "succeeded",
            "paged": True,
            "skip": 0,
            "limit": 1,
        },
    )
    assert paged.status_code == 200
    body = paged.json()
    assert set(body.keys()) >= {"items", "total", "skip", "limit"}
    assert body["total"] >= 1
    assert len(body["items"]) == 1
    assert body["items"][0]["model_version_id"] == seeded["model_version_id"]
    assert body["items"][0]["quality_status"] == "ok"


def test_summary_includes_structured_closed_loop(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        db.commit()

    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "name": "delta-needs-baseline",
            "endpoint_id": seeded["endpoint_id"],
            "rule_logic": "any",
            "rules": [
                {
                    "metric": "f1_macro",
                    "comparison": "baseline_delta",
                    "warning_threshold": 0.05,
                    "critical_threshold": 0.1,
                }
            ],
            "minimum_matched_samples": 5,
            "auto_retrain": False,
        },
    )
    assert created.status_code == 201

    summary = client.get(
        f"/api/v1/projects/{project_id}/model-quality/summary",
        headers=auth_headers,
    )
    assert summary.status_code == 200
    cards = summary.json()["items"]
    card = next(row for row in cards if row["policy_name"] == "delta-needs-baseline")
    assert "closed_loop" in card
    assert card["closed_loop"]["code"] == "needs_baseline"
    assert card["closed_loop_state"] == "Needs baseline"
    assert card["closed_loop"]["reason"] == "baseline_not_set"


def test_baseline_revision_deterministic_under_sequential_ops(
    client, auth_headers, project_id
):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        db.commit()

    policy = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "name": "revision-policy",
            "endpoint_id": seeded["endpoint_id"],
            "primary_metric": "f1_macro",
            "warning_threshold": 0.7,
            "critical_threshold": 0.5,
            "minimum_matched_samples": 5,
            "auto_retrain": False,
        },
    ).json()
    start_rev = policy["revision"]

    with TestingSessionLocal() as db:
        run_a = _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy["id"],
            model_version_id=seeded["model_version_id"],
        )
        run_b = _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy["id"],
            model_version_id=seeded["model_version_id"],
        )
        db.commit()
        run_a_id, run_b_id = run_a.id, run_b.id

    set_a = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy['id']}/baseline",
        headers=auth_headers,
        json={"quality_run_id": run_a_id},
    )
    assert set_a.status_code == 201
    assert set_a.json()["policy"]["revision"] == start_rev + 1

    set_b = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy['id']}/baseline",
        headers=auth_headers,
        json={"quality_run_id": run_b_id},
    )
    assert set_b.status_code == 201
    assert set_b.json()["policy"]["revision"] == start_rev + 2

    name_only = client.patch(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy['id']}",
        headers=auth_headers,
        json={"name": "revision-policy-renamed"},
    )
    assert name_only.status_code == 200
    assert name_only.json()["revision"] == start_rev + 2

    semantic = client.patch(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy['id']}",
        headers=auth_headers,
        json={"cooldown_hours": 12},
    )
    assert semantic.status_code == 200
    assert semantic.json()["revision"] == start_rev + 3

    cleared = client.delete(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy['id']}/baseline",
        headers=auth_headers,
    )
    assert cleared.status_code == 200
    assert cleared.json()["revision"] == start_rev + 4


def test_alert_idempotent_for_same_quality_run(project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            name="idem-policy",
            primary_metric="f1_macro",
            warning_threshold=0.7,
            critical_threshold=0.5,
            minimum_matched_samples=5,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=False,
            window_hours=24,
            is_active=True,
            revision=1,
            rule_logic="any",
            rules_json="[]",
            evaluation_delay_hours=0,
        )
        db.add(policy)
        db.flush()
        run = _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy.id,
            model_version_id=seeded["model_version_id"],
            quality_status="critical",
            evaluation=(
                '{"rules":[{"metric":"f1_macro","status":"critical",'
                '"comparison":"absolute","current_value":0.2}]}'
            ),
        )
        endpoint = db.get(Endpoint, seeded["endpoint_id"])
        alert1 = closed_loop.maybe_create_degradation_alert(
            db, run=run, policy=policy, endpoint=endpoint
        )
        alert2 = closed_loop.maybe_create_degradation_alert(
            db, run=run, policy=policy, endpoint=endpoint
        )
        db.commit()
        assert alert1 is not None
        assert alert2 is not None
        assert alert1.id == alert2.id
        alerts = db.scalars(
            select(Alert).where(
                Alert.project_id == project_id,
                Alert.alert_type == "model_quality_degradation",
                Alert.resource_id == str(run.id),
            )
        ).all()
        assert len(alerts) == 1


def test_closed_loop_detail_codes_from_persisted_state(project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            name="state-policy",
            primary_metric="f1_macro",
            warning_threshold=0.7,
            critical_threshold=0.5,
            minimum_matched_samples=20,
            consecutive_breaches=3,
            cooldown_hours=24,
            auto_retrain=True,
            window_hours=24,
            is_active=True,
            revision=1,
            rule_logic="any",
            rules_json="[]",
            evaluation_delay_hours=0,
        )
        db.add(policy)
        db.flush()
        _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy.id,
            model_version_id=seeded["model_version_id"],
            quality_status="insufficient_data",
            matched=5,
            evaluation='{"reason":"minimum_matched_samples"}',
        )
        db.commit()

        detail = closed_loop_ux.compute_closed_loop_detail(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy=policy,
        )
        assert detail["code"] == "insufficient_data"
        assert detail["reason"] == "minimum_matched_samples"
        assert (
            closed_loop.compute_closed_loop_state(
                db,
                project_id=project_id,
                endpoint_id=seeded["endpoint_id"],
                policy=policy,
            )
            == "Insufficient data"
        )


def test_candidate_ready_structured_state(project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            name="cand-policy",
            primary_metric="f1_macro",
            warning_threshold=0.7,
            critical_threshold=0.5,
            minimum_matched_samples=5,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=True,
            window_hours=24,
            is_active=True,
            revision=1,
            rule_logic="any",
            rules_json="[]",
            evaluation_delay_hours=0,
        )
        db.add(policy)
        db.flush()
        run = _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy.id,
            model_version_id=seeded["model_version_id"],
            quality_status="critical",
        )
        job = db.get(TrainingJob, seeded["training_job_id"])
        candidate = ModelVersion(
            project_id=project_id,
            name="closed-loop-candidate",
            version="auto-1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project_id}-candidate",
            mlflow_version="2",
            mlflow_run_id="run-cand",
            model_uri="models:/demo/2",
            metrics_json="{}",
            metadata_json="{}",
            dataset_version_id=seeded["dataset_version_id"],
            training_job_id=job.id,
            gates_passed=True,
        )
        db.add(candidate)
        db.flush()
        db.add(
            RetrainTrigger(
                project_id=project_id,
                quality_run_id=run.id,
                trigger_type="quality_degradation",
                created_training_job_id=job.id,
                candidate_model_version_id=candidate.id,
                target_dataset_version_id=seeded["dataset_version_id"],
                config_json="{}",
            )
        )
        db.commit()

        detail = closed_loop_ux.compute_closed_loop_detail(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy=policy,
        )
        assert detail["code"] == "candidate_ready"
        assert detail["candidate_model_version_id"] == candidate.id
        assert candidate.lifecycle == ModelLifecycle.CANDIDATE


def test_multi_policy_same_endpoint_trigger_isolation(client, auth_headers, project_id):
    """Policy B must not inherit Policy A's candidate/retrain on the same endpoint."""

    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        db.commit()

    policy_a = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "name": "policy-a-critical",
            "endpoint_id": seeded["endpoint_id"],
            "primary_metric": "f1_macro",
            "warning_threshold": 0.7,
            "critical_threshold": 0.5,
            "minimum_matched_samples": 5,
            "auto_retrain": False,
        },
    ).json()
    policy_b = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "name": "policy-b-needs-baseline",
            "endpoint_id": seeded["endpoint_id"],
            "rule_logic": "any",
            "rules": [
                {
                    "metric": "f1_macro",
                    "comparison": "baseline_delta",
                    "warning_threshold": 0.05,
                    "critical_threshold": 0.1,
                }
            ],
            "minimum_matched_samples": 5,
            "auto_retrain": False,
        },
    ).json()

    with TestingSessionLocal() as db:
        run_a = _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy_a["id"],
            model_version_id=seeded["model_version_id"],
            quality_status="critical",
        )
        job = db.get(TrainingJob, seeded["training_job_id"])
        candidate = ModelVersion(
            project_id=project_id,
            name="candidate-from-a",
            version="a-1",
            lifecycle=ModelLifecycle.CANDIDATE,
            mlflow_model_name=f"project-{project_id}-cand-a",
            mlflow_version="9",
            mlflow_run_id="run-a",
            model_uri="models:/demo/a",
            metrics_json="{}",
            metadata_json="{}",
            dataset_version_id=seeded["dataset_version_id"],
            training_job_id=job.id,
            gates_passed=True,
        )
        db.add(candidate)
        db.flush()
        db.add(
            RetrainTrigger(
                project_id=project_id,
                quality_run_id=run_a.id,
                trigger_type="quality_degradation",
                created_training_job_id=job.id,
                candidate_model_version_id=candidate.id,
                target_dataset_version_id=seeded["dataset_version_id"],
                config_json="{}",
            )
        )
        db.commit()
        candidate_id = candidate.id

    summary = client.get(
        f"/api/v1/projects/{project_id}/model-quality/summary",
        headers=auth_headers,
    ).json()["items"]
    card_a = next(row for row in summary if row["policy_id"] == policy_a["id"])
    card_b = next(row for row in summary if row["policy_id"] == policy_b["id"])

    assert card_a["closed_loop"]["code"] == "candidate_ready"
    assert card_a["closed_loop"]["candidate_model_version_id"] == candidate_id
    assert card_b["closed_loop"]["code"] == "needs_baseline"
    assert card_b["closed_loop"]["candidate_model_version_id"] is None
    assert card_b["closed_loop"]["retrain_trigger_id"] is None


def test_materializable_sql_filter_before_pagination(client, auth_headers, project_id):
    from datetime import datetime, timezone

    from app.db.models import (
        FeedbackReviewStatus,
        GroundTruthFeedback,
        PredictionObservation,
    )

    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        now = datetime.now(timezone.utc)
        # Older non-materializable rows (no input snapshot) come first by id.
        for i in range(30):
            obs = PredictionObservation(
                id=f"non-mat-{i}",
                project_id=project_id,
                endpoint_id=seeded["endpoint_id"],
                model_version_id=seeded["model_version_id"],
                request_id=f"req-non-{i}",
                instance_index=0,
                prediction_json="0",
                input_json=None,
                predicted_at=now,
            )
            db.add(obs)
            db.flush()
            db.add(
                GroundTruthFeedback(
                    project_id=project_id,
                    prediction_observation_id=obs.id,
                    actual_json="1",
                    review_status=FeedbackReviewStatus.APPROVED.value,
                )
            )
        mat_ids: list[int] = []
        for i in range(10):
            obs = PredictionObservation(
                id=f"mat-{i}",
                project_id=project_id,
                endpoint_id=seeded["endpoint_id"],
                model_version_id=seeded["model_version_id"],
                request_id=f"req-mat-{i}",
                instance_index=0,
                prediction_json="0",
                input_json='{"a":1,"b":2}',
                predicted_at=now,
            )
            db.add(obs)
            db.flush()
            fb = GroundTruthFeedback(
                project_id=project_id,
                prediction_observation_id=obs.id,
                actual_json="1",
                review_status=FeedbackReviewStatus.APPROVED.value,
            )
            db.add(fb)
            db.flush()
            mat_ids.append(fb.id)
        # Extra materializable rows for multi-page continuity (30 total mat).
        for i in range(10, 30):
            obs = PredictionObservation(
                id=f"mat-extra-{i}",
                project_id=project_id,
                endpoint_id=seeded["endpoint_id"],
                model_version_id=seeded["model_version_id"],
                request_id=f"req-mat-extra-{i}",
                instance_index=0,
                prediction_json="0",
                input_json='{"a":1,"b":2}',
                predicted_at=now,
            )
            db.add(obs)
            db.flush()
            fb = GroundTruthFeedback(
                project_id=project_id,
                prediction_observation_id=obs.id,
                actual_json="1",
                review_status=FeedbackReviewStatus.APPROVED.value,
            )
            db.add(fb)
            db.flush()
            mat_ids.append(fb.id)
        db.commit()

    # First page must not be polluted by the 30 non-materializable older rows.
    page1 = client.get(
        f"/api/v1/projects/{project_id}/feedback",
        headers=auth_headers,
        params={"materializable": True, "paged": True, "skip": 0, "limit": 25},
    )
    assert page1.status_code == 200
    body1 = page1.json()
    assert body1["total"] == 30
    assert len(body1["items"]) == 25
    assert all(item["materializable"] is True for item in body1["items"])

    page2 = client.get(
        f"/api/v1/projects/{project_id}/feedback",
        headers=auth_headers,
        params={"materializable": True, "paged": True, "skip": 25, "limit": 25},
    )
    body2 = page2.json()
    assert body2["total"] == 30
    assert len(body2["items"]) == 5
    ids1 = {item["id"] for item in body1["items"]}
    ids2 = {item["id"] for item in body2["items"]}
    assert ids1.isdisjoint(ids2)
    assert ids1 | ids2 == set(mat_ids)

    # When only 10 materializable exist among 40 rows, limit=25 still returns 10/10.
    with TestingSessionLocal() as db:
        for fb_id in mat_ids[10:]:
            fb = db.get(GroundTruthFeedback, fb_id)
            db.delete(fb)
        db.commit()

    only10 = client.get(
        f"/api/v1/projects/{project_id}/feedback",
        headers=auth_headers,
        params={"materializable": True, "paged": True, "skip": 0, "limit": 25},
    ).json()
    assert only10["total"] == 10
    assert len(only10["items"]) == 10


def test_lock_policy_for_update_refreshes_stale_identity_map(project_id):
    """populate_existing must reload revision after another writer commits.

    SQLite cannot prove cross-transaction row-lock waits; this asserts the
    freshness half of the lock-first contract used by baseline set/clear/PATCH.
    """

    from sqlalchemy import update

    from app.services import quality_policy as policy_service

    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            name="lock-freshness",
            primary_metric="f1_macro",
            warning_threshold=0.7,
            critical_threshold=0.5,
            minimum_matched_samples=5,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=False,
            window_hours=24,
            is_active=True,
            revision=3,
            rule_logic="any",
            rules_json="[]",
            evaluation_delay_hours=0,
        )
        db.add(policy)
        db.commit()
        policy_id = policy.id

    with TestingSessionLocal() as db:
        stale = db.get(ModelQualityPolicy, policy_id)
        assert stale is not None
        assert stale.revision == 3

        # Concurrent writer updates the row outside this Session's UOW so the
        # identity-map instance stays stale until populate_existing refreshes it.
        with engine.connect() as conn:
            conn.execute(
                update(ModelQualityPolicy)
                .where(ModelQualityPolicy.id == policy_id)
                .values(revision=4)
            )
            conn.commit()

        assert stale.revision == 3

        locked = policy_service.lock_policy_for_update(db, policy_id)
        assert locked is not None
        assert locked.revision == 4
        locked.revision = int(locked.revision) + 1
        db.commit()

    with TestingSessionLocal() as db:
        assert db.get(ModelQualityPolicy, policy_id).revision == 5


def test_degradation_alert_locks_quality_run_row(project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            name="alert-lock",
            primary_metric="f1_macro",
            warning_threshold=0.7,
            critical_threshold=0.5,
            minimum_matched_samples=5,
            consecutive_breaches=1,
            cooldown_hours=0,
            auto_retrain=False,
            window_hours=24,
            is_active=True,
            revision=1,
            rule_logic="any",
            rules_json="[]",
            evaluation_delay_hours=0,
        )
        db.add(policy)
        db.flush()
        run = _seed_quality_run(
            db,
            project_id=project_id,
            endpoint_id=seeded["endpoint_id"],
            policy_id=policy.id,
            model_version_id=seeded["model_version_id"],
            quality_status="critical",
            evaluation=(
                '{"rules":[{"metric":"f1_macro","status":"critical",'
                '"comparison":"absolute","current_value":0.2}]}'
            ),
        )
        endpoint = db.get(Endpoint, seeded["endpoint_id"])
        first = closed_loop.maybe_create_degradation_alert(
            db, run=run, policy=policy, endpoint=endpoint
        )
        second = closed_loop.maybe_create_degradation_alert(
            db, run=run, policy=policy, endpoint=endpoint
        )
        db.commit()
        assert first is not None and second is not None
        assert first.id == second.id
        assert (
            db.scalar(
                select(Alert).where(
                    Alert.resource_type == "model_quality_run",
                    Alert.resource_id == str(run.id),
                )
            )
            is not None
        )