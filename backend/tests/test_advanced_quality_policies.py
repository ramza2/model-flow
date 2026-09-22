"""Phase 5-C advanced quality policies — rules, baseline, snapshots, revision isolation."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Alert,
    AuditLog,
    Base,
    Dataset,
    DatasetVersion,
    Endpoint,
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
from app.services import closed_loop, mlflow_service, model_quality as mq
from app.services import quality_policy as qp
from app.services import registry_service, storage
from app.workers import runner
import secrets

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
        project = Project(name="advanced-quality", created_by=admin.id)
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
    token = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": ADMIN_PASSWORD},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def viewer_headers(client):
    token = client.post(
        "/api/v1/auth/login",
        json={"email": "viewer@example.com", "password": VIEWER_PASSWORD},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def project_id():
    with TestingSessionLocal() as db:
        return db.scalar(select(Project.id))


def _seed_endpoint(db, project_id: int, *, problem_type: str = "classification", multi: bool = False):
    from app.core.config import settings

    targets = ["target_a", "target_b"] if multi else ["target"]
    dataset = Dataset(
        project_id=project_id,
        name=f"ds-{problem_type}-{'multi' if multi else 'single'}",
        object_key="ds/v1.csv",
        latest_version=2,
    )
    db.add(dataset)
    db.flush()
    OBJECT_STORE[(settings.minio_datasets_bucket, "ds/v1.csv")] = CSV_V1
    OBJECT_STORE[(settings.minio_datasets_bucket, "ds/v2.csv")] = CSV_V2
    cols = ["a", "b", *targets]
    dtypes = {c: "float64" if problem_type == "regression" else "int64" for c in cols}
    v1 = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project_id,
        version=1,
        object_key="ds/v1.csv",
        original_filename="v1.csv",
        format="csv",
        row_count=10,
        column_count=len(cols),
        dtypes_json=json.dumps(dtypes),
        columns_json=json.dumps(cols),
    )
    v2 = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project_id,
        version=2,
        object_key="ds/v2.csv",
        original_filename="v2.csv",
        format="csv",
        row_count=10,
        column_count=len(cols),
        dtypes_json=json.dumps(dtypes),
        columns_json=json.dumps(cols),
    )
    db.add_all([v1, v2])
    db.flush()
    job = TrainingJob(
        project_id=project_id,
        dataset_id=dataset.id,
        dataset_version_id=v1.id,
        name="prod-train",
        target_column=targets[0],
        target_columns_json=json.dumps(targets),
        problem_type=problem_type,
        algorithm="logistic_regression" if problem_type == "classification" else "ridge",
        feature_columns_json=json.dumps(["a", "b"]),
        status=JobStatus.succeeded,
        mlflow_run_id="run-prod",
        model_uri="models:/demo/1",
        metrics_json=json.dumps({"accuracy": 0.9, "f1_macro": 0.9, "rmse": 1.0}),
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
        metrics_json=json.dumps({"accuracy": 0.9, "f1_macro": 0.9, "rmse": 1.0}),
        metadata_json=json.dumps(
            {
                "problem_type": problem_type,
                "target_columns": targets,
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
    db.flush()
    return {
        "dataset": dataset,
        "v1": v1,
        "v2": v2,
        "job": job,
        "model": model,
        "endpoint": endpoint,
    }


# --- Unit helpers ---


def test_legacy_absolute_compatibility_thresholds():
    assert (
        mq.evaluate_thresholds(
            primary_value=0.85,
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            matched_count=10,
            minimum_matched_samples=5,
        )
        == "ok"
    )
    assert (
        mq.evaluate_thresholds(
            primary_value=0.75,
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            matched_count=10,
            minimum_matched_samples=5,
        )
        == "warning"
    )
    assert (
        mq.evaluate_thresholds(
            primary_value=0.65,
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            matched_count=10,
            minimum_matched_samples=5,
        )
        == "critical"
    )


def test_any_all_combination():
    assert mq.combine_rule_statuses(["warning", "ok"], "any") == "warning"
    assert mq.combine_rule_statuses(["critical", "ok"], "any") == "critical"
    assert mq.combine_rule_statuses(["critical", "ok"], "all") == "ok"
    assert mq.combine_rule_statuses(["critical", "warning"], "all") == "warning"
    assert mq.combine_rule_statuses(["critical", "critical"], "all") == "critical"


def test_baseline_delta_higher_and_lower():
    assert (
        mq.evaluate_baseline_delta(
            degradation_delta=0.03, warning_threshold=0.05, critical_threshold=0.10
        )
        == "ok"
    )
    assert (
        mq.evaluate_baseline_delta(
            degradation_delta=0.08, warning_threshold=0.05, critical_threshold=0.10
        )
        == "warning"
    )
    assert (
        mq.evaluate_baseline_delta(
            degradation_delta=0.13, warning_threshold=0.05, critical_threshold=0.10
        )
        == "critical"
    )


def test_extract_metric_multi_output_target():
    metrics = {
        "aggregate": {"rmse": 1.0},
        "targets": {"target_a": {"rmse": 0.5}, "target_b": {"rmse": 2.0}},
    }
    assert mq.extract_metric_value(metrics, "rmse") == 1.0
    assert mq.extract_metric_value(metrics, "rmse", target="target_b") == 2.0


def test_rule_validation_rejects_duplicates_and_max():
    with pytest.raises(ValueError, match="Duplicate"):
        qp.validate_and_normalize_rules(
            [
                {
                    "metric": "f1_macro",
                    "comparison": "absolute",
                    "warning_threshold": 0.8,
                    "critical_threshold": 0.7,
                },
                {
                    "metric": "f1_macro",
                    "comparison": "absolute",
                    "warning_threshold": 0.9,
                    "critical_threshold": 0.8,
                },
            ]
        )
    with pytest.raises(ValueError, match="at most 10"):
        qp.validate_and_normalize_rules(
            [
                {
                    "metric": "accuracy",
                    "comparison": "absolute",
                    "warning_threshold": 0.9 - i * 0.01,
                    "critical_threshold": 0.8 - i * 0.01,
                }
                for i in range(11)
            ]
        )


def test_baseline_delta_threshold_ordering():
    with pytest.raises(ValueError, match="warning_threshold must be <="):
        qp.normalize_rule(
            {
                "metric": "f1_macro",
                "comparison": "baseline_delta",
                "warning_threshold": 0.2,
                "critical_threshold": 0.1,
            }
        )


def test_classification_threshold_range():
    with pytest.raises(ValueError, match="between 0 and 1"):
        qp.normalize_rule(
            {
                "metric": "accuracy",
                "comparison": "absolute",
                "warning_threshold": 1.5,
                "critical_threshold": 0.7,
            }
        )


def test_finite_threshold_validation():
    with pytest.raises(ValueError, match="finite"):
        qp.normalize_rule(
            {
                "metric": "mae",
                "comparison": "absolute",
                "warning_threshold": math.nan,
                "critical_threshold": 1.0,
            }
        )


def test_metric_problem_type_validation():
    with pytest.raises(ValueError, match="incompatible"):
        qp.validate_rules_against_model(
            [
                {
                    "metric": "rmse",
                    "target": None,
                    "comparison": "absolute",
                    "warning_threshold": 1.0,
                    "critical_threshold": 2.0,
                }
            ],
            problem_type="classification",
            target_columns=["target"],
        )


def test_multi_output_target_rule_evaluation():
    metrics = {
        "aggregate": {"rmse": 1.0, "mae": 0.8, "r2": 0.9},
        "targets": {
            "target_a": {"rmse": 0.5, "mae": 0.4, "r2": 0.95},
            "target_b": {"rmse": 2.0, "mae": 1.8, "r2": 0.5},
        },
    }
    status, evidence, reason = mq.evaluate_rules(
        metrics=metrics,
        rules=[
            {
                "metric": "rmse",
                "target": "target_b",
                "comparison": "absolute",
                "warning_threshold": 1.5,
                "critical_threshold": 1.8,
            }
        ],
        rule_logic="any",
        baseline_metrics=None,
        problem_type="regression",
        target_columns=["target_a", "target_b"],
    )
    assert status == "critical"
    assert evidence[0]["current_value"] == 2.0
    assert reason is None


def test_advanced_any_scenario_unit():
    metrics = {"f1_macro": 0.82, "accuracy": 0.80}
    status, _, _ = mq.evaluate_rules(
        metrics=metrics,
        rules=[
            {
                "metric": "f1_macro",
                "target": None,
                "comparison": "absolute",
                "warning_threshold": 0.80,
                "critical_threshold": 0.70,
            },
            {
                "metric": "accuracy",
                "target": None,
                "comparison": "absolute",
                "warning_threshold": 0.85,
                "critical_threshold": 0.75,
            },
        ],
        rule_logic="any",
        baseline_metrics=None,
        problem_type="classification",
        target_columns=["target"],
    )
    assert status == "warning"
    status2, _, _ = mq.evaluate_rules(
        metrics={"f1_macro": 0.82, "accuracy": 0.70},
        rules=[
            {
                "metric": "f1_macro",
                "target": None,
                "comparison": "absolute",
                "warning_threshold": 0.80,
                "critical_threshold": 0.70,
            },
            {
                "metric": "accuracy",
                "target": None,
                "comparison": "absolute",
                "warning_threshold": 0.85,
                "critical_threshold": 0.75,
            },
        ],
        rule_logic="any",
        baseline_metrics=None,
        problem_type="classification",
        target_columns=["target"],
    )
    assert status2 == "critical"


def test_advanced_all_scenario_unit():
    rules = [
        {
            "metric": "f1_macro",
            "target": None,
            "comparison": "absolute",
            "warning_threshold": 0.80,
            "critical_threshold": 0.70,
        },
        {
            "metric": "accuracy",
            "target": None,
            "comparison": "absolute",
            "warning_threshold": 0.85,
            "critical_threshold": 0.75,
        },
    ]
    s1, _, _ = mq.evaluate_rules(
        metrics={"f1_macro": 0.65, "accuracy": 0.90},
        rules=rules,
        rule_logic="all",
        baseline_metrics=None,
        problem_type="classification",
        target_columns=["target"],
    )
    assert s1 == "ok"
    s2, _, _ = mq.evaluate_rules(
        metrics={"f1_macro": 0.65, "accuracy": 0.80},
        rules=rules,
        rule_logic="all",
        baseline_metrics=None,
        problem_type="classification",
        target_columns=["target"],
    )
    assert s2 == "warning"
    s3, _, _ = mq.evaluate_rules(
        metrics={"f1_macro": 0.65, "accuracy": 0.70},
        rules=rules,
        rule_logic="all",
        baseline_metrics=None,
        problem_type="classification",
        target_columns=["target"],
    )
    assert s3 == "critical"


def test_baseline_delta_rule_unit():
    status, evidence, _ = mq.evaluate_rules(
        metrics={"f1_macro": 0.82},
        rules=[
            {
                "metric": "f1_macro",
                "target": None,
                "comparison": "baseline_delta",
                "warning_threshold": 0.05,
                "critical_threshold": 0.10,
            }
        ],
        rule_logic="any",
        baseline_metrics={"f1_macro": 0.90},
        problem_type="classification",
        target_columns=["target"],
    )
    assert status == "warning"
    assert abs(evidence[0]["degradation_delta"] - 0.08) < 1e-9


def test_lower_is_better_baseline_delta():
    for current, expected in ((1.1, "ok"), (1.3, "warning"), (1.5, "critical")):
        status, evidence, _ = mq.evaluate_rules(
            metrics={"rmse": current},
            rules=[
                {
                    "metric": "rmse",
                    "target": None,
                    "comparison": "baseline_delta",
                    "warning_threshold": 0.2,
                    "critical_threshold": 0.4,
                }
            ],
            rule_logic="any",
            baseline_metrics={"rmse": 1.0},
            problem_type="regression",
            target_columns=["y"],
        )
        assert status == expected
        assert abs(evidence[0]["degradation_delta"] - (current - 1.0)) < 1e-9


# --- API / integration ---


def test_legacy_create_api_and_effective_rule(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()
    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "legacy",
            "primary_metric": "f1_macro",
            "warning_threshold": 0.8,
            "critical_threshold": 0.7,
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["mode"] == "legacy"
    assert body["revision"] == 1
    assert len(body["effective_rules"]) == 1
    assert body["effective_rules"][0]["metric"] == "f1_macro"
    assert body["rules"] == []


def test_advanced_create_and_metric_incompatibility(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id, problem_type="classification")
        endpoint_id = seeded["endpoint"].id
        db.commit()
    bad = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "bad",
            "rules": [
                {
                    "metric": "rmse",
                    "comparison": "absolute",
                    "warning_threshold": 1.0,
                    "critical_threshold": 2.0,
                }
            ],
        },
    )
    assert bad.status_code == 422


def test_invalid_target_rejected(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id, problem_type="regression", multi=True)
        endpoint_id = seeded["endpoint"].id
        db.commit()
    bad = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "bad-target",
            "rules": [
                {
                    "metric": "rmse",
                    "target": "nope",
                    "comparison": "absolute",
                    "warning_threshold": 1.0,
                    "critical_threshold": 2.0,
                }
            ],
        },
    )
    assert bad.status_code == 422
    assert "Unknown target" in bad.text


def test_name_only_patch_keeps_revision(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()
    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "rev",
            "primary_metric": "accuracy",
            "warning_threshold": 0.9,
            "critical_threshold": 0.8,
        },
    ).json()
    patched = client.patch(
        f"/api/v1/projects/{project_id}/model-quality/policies/{created['id']}",
        headers=auth_headers,
        json={"name": "renamed"},
    )
    assert patched.status_code == 200
    assert patched.json()["revision"] == 1
    assert patched.json()["name"] == "renamed"


def test_semantic_patch_increments_revision(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()
    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "rev2",
            "primary_metric": "accuracy",
            "warning_threshold": 0.9,
            "critical_threshold": 0.8,
        },
    ).json()
    patched = client.patch(
        f"/api/v1/projects/{project_id}/model-quality/policies/{created['id']}",
        headers=auth_headers,
        json={"warning_threshold": 0.85},
    )
    assert patched.json()["revision"] == 2


def _enqueue_and_process(client, auth_headers, project_id, policy_id):
    evaluate = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/evaluate",
        headers=auth_headers,
    )
    assert evaluate.status_code == 201, evaluate.text
    run_id = evaluate.json()["id"]
    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        run.status = JobStatus.pending
        db.commit()
    claimed = runner.claim_next_model_quality_run()
    assert claimed is not None
    runner.process_model_quality_run(claimed)
    with TestingSessionLocal() as db:
        return db.get(ModelQualityRun, run_id)


def test_run_policy_snapshot_immutable_to_patch(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()

    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "snap",
            "primary_metric": "accuracy",
            "warning_threshold": 0.8,
            "critical_threshold": 0.7,
            "minimum_matched_samples": 2,
            "consecutive_breaches": 20,
            "auto_retrain": False,
        },
    ).json()
    policy_id = created["id"]

    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *args, **kwargs: [1, 1],
    )
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
                {"prediction_id": predicted["prediction_ids"][0], "actual": 1},
                {"prediction_id": predicted["prediction_ids"][1], "actual": 0},
            ]
        },
    )

    enqueue = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/evaluate",
        headers=auth_headers,
    )
    assert enqueue.status_code == 201
    run_id = enqueue.json()["id"]
    assert enqueue.json()["policy_revision"] == 1
    assert enqueue.json()["policy_snapshot"]["warning_threshold"] == 0.8

    # Patch after enqueue — live policy revision 2 with stricter thresholds.
    client.patch(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}",
        headers=auth_headers,
        json={"warning_threshold": 0.99, "critical_threshold": 0.95},
    )

    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        run.status = JobStatus.pending
        db.commit()
    claimed = runner.claim_next_model_quality_run()
    runner.process_model_quality_run(claimed)

    with TestingSessionLocal() as db:
        run = db.get(ModelQualityRun, run_id)
        snap = json.loads(run.policy_snapshot_json)
        assert snap["revision"] == 1
        assert snap["warning_threshold"] == 0.8
        assert run.policy_revision == 1
        # accuracy = 0.5 with rev1 thresholds → critical, not using rev2
        assert run.quality_status == "critical"
        evaluation = json.loads(run.evaluation_json)
        assert evaluation["rules"]


def test_baseline_set_clear_audit_and_revision(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model_id = seeded["model"].id
        db.commit()

    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "base",
            "minimum_matched_samples": 2,
            "auto_retrain": False,
            "rules": [
                {
                    "metric": "accuracy",
                    "comparison": "baseline_delta",
                    "warning_threshold": 0.05,
                    "critical_threshold": 0.1,
                }
            ],
        },
    )
    assert created.status_code == 201, created.text
    policy_id = created.json()["id"]
    assert created.json()["revision"] == 1

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
    # Perfect accuracy for baseline eligibility (ok status needs absolute... baseline_delta
    # without baseline → insufficient). Use a temporary absolute policy run via direct DB.
    with TestingSessionLocal() as db:
        now = datetime.now(timezone.utc)
        for i, pid in enumerate(predicted["prediction_ids"]):
            pass
        # Create a succeeded ok run for baseline eligibility.
        run = ModelQualityRun(
            project_id=project_id,
            policy_id=policy_id,
            endpoint_id=endpoint_id,
            model_version_id=model_id,
            status=JobStatus.succeeded,
            quality_status="ok",
            prediction_count=4,
            matched_ground_truth_count=4,
            match_rate=1.0,
            metrics_json=json.dumps({"accuracy": 0.9, "f1_macro": 0.9}),
            thresholds_json="{}",
            policy_revision=1,
            policy_snapshot_json="{}",
            evaluation_json="{}",
            finished_at=now,
        )
        db.add(run)
        db.commit()
        run_id = run.id

    set_resp = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/baseline",
        headers=auth_headers,
        json={"quality_run_id": run_id},
    )
    assert set_resp.status_code == 201, set_resp.text
    assert set_resp.json()["policy"]["revision"] == 2
    assert set_resp.json()["baseline"]["quality_run_id"] == run_id

    with TestingSessionLocal() as db:
        audits = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.action == "model_quality_policy.baseline_set"
                )
            ).all()
        )
        assert audits

    clear = client.delete(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_id}/baseline",
        headers=auth_headers,
    )
    assert clear.status_code == 200
    assert clear.json()["revision"] == 3
    assert clear.json()["baseline"] is None


def test_cross_policy_ok_run_can_bootstrap_baseline(client, auth_headers, project_id):
    """Policy B (baseline_delta) may pin Policy A's OK run on the same endpoint/model."""

    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model_id = seeded["model"].id
        db.commit()

    policy_a = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "absolute-a",
            "primary_metric": "accuracy",
            "warning_threshold": 0.9,
            "critical_threshold": 0.8,
            "minimum_matched_samples": 2,
            "auto_retrain": False,
        },
    )
    assert policy_a.status_code == 201, policy_a.text
    policy_a_id = policy_a.json()["id"]

    policy_b = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "baseline-b",
            "minimum_matched_samples": 2,
            "minimum_match_rate": 0.5,
            "auto_retrain": False,
            "rules": [
                {
                    "metric": "accuracy",
                    "comparison": "baseline_delta",
                    "warning_threshold": 0.05,
                    "critical_threshold": 0.1,
                }
            ],
        },
    )
    assert policy_b.status_code == 201, policy_b.text
    policy_b_id = policy_b.json()["id"]
    assert policy_b.json()["revision"] == 1
    assert policy_b.json()["baseline"] is None

    with TestingSessionLocal() as db:
        run = ModelQualityRun(
            project_id=project_id,
            policy_id=policy_a_id,
            endpoint_id=endpoint_id,
            model_version_id=model_id,
            status=JobStatus.succeeded,
            quality_status="ok",
            prediction_count=10,
            matched_ground_truth_count=8,
            match_rate=0.8,
            metrics_json=json.dumps({"accuracy": 0.95, "f1_macro": 0.9}),
            thresholds_json=json.dumps({"mode": "legacy"}),
            policy_revision=1,
            policy_snapshot_json=json.dumps({"mode": "legacy", "revision": 1}),
            evaluation_json="{}",
            finished_at=datetime.now(timezone.utc),
        )
        db.add(run)
        db.commit()
        run_id = run.id

    set_resp = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{policy_b_id}/baseline",
        headers=auth_headers,
        json={"quality_run_id": run_id},
    )
    assert set_resp.status_code == 201, set_resp.text
    body = set_resp.json()
    assert body["baseline"]["quality_run_id"] == run_id
    assert body["policy"]["revision"] == 2
    assert body["policy"]["baseline"]["quality_run_id"] == run_id


def test_snapshot_mode_and_thresholds_json_legacy(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()

    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "legacy-mode",
            "primary_metric": "accuracy",
            "warning_threshold": 0.5,
            "critical_threshold": 0.4,
            "minimum_matched_samples": 1,
            "auto_retrain": False,
        },
    ).json()
    assert created["mode"] == "legacy"

    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *args, **kwargs: [1],
    )
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
    run = _enqueue_and_process(client, auth_headers, project_id, created["id"])
    snap = json.loads(run.policy_snapshot_json)
    thresholds = json.loads(run.thresholds_json)
    assert snap["mode"] == "legacy"
    assert thresholds["mode"] == "legacy"
    assert qp.snapshot_mode({"effective_rules": snap["effective_rules"], "primary_metric": "accuracy"}) == "legacy"
    assert qp.snapshot_mode({"mode": "advanced", "effective_rules": []}) == "advanced"


def test_baseline_missing_and_model_mismatch(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model = seeded["model"]
        db.commit()
        model_id = model.id

    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "mismatch",
            "minimum_matched_samples": 2,
            "auto_retrain": False,
            "rules": [
                {
                    "metric": "accuracy",
                    "comparison": "baseline_delta",
                    "warning_threshold": 0.05,
                    "critical_threshold": 0.1,
                }
            ],
        },
    ).json()
    policy_id = created["id"]

    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *args, **kwargs: [1, 1],
    )
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
                {"prediction_id": predicted["prediction_ids"][0], "actual": 1},
                {"prediction_id": predicted["prediction_ids"][1], "actual": 1},
            ]
        },
    )

    run = _enqueue_and_process(client, auth_headers, project_id, policy_id)
    assert run.quality_status == "insufficient_data"
    evaluation = json.loads(run.evaluation_json)
    assert evaluation["reason"] == "baseline_not_set"
    assert run.trigger_decision_json
    decision = json.loads(run.trigger_decision_json)
    assert decision["reason"] == "insufficient_data"

    # Set baseline then swap model → mismatch
    with TestingSessionLocal() as db:
        ok_run = ModelQualityRun(
            project_id=project_id,
            policy_id=policy_id,
            endpoint_id=endpoint_id,
            model_version_id=model_id,
            status=JobStatus.succeeded,
            quality_status="ok",
            prediction_count=2,
            matched_ground_truth_count=2,
            match_rate=1.0,
            metrics_json=json.dumps({"accuracy": 1.0}),
            thresholds_json="{}",
            policy_revision=1,
            policy_snapshot_json="{}",
            evaluation_json="{}",
            finished_at=datetime.now(timezone.utc),
        )
        db.add(ok_run)
        db.flush()
        qp.set_baseline(db, policy=db.get(ModelQualityPolicy, policy_id), quality_run_id=ok_run.id, created_by=1)
        # New production model B
        other = ModelVersion(
            project_id=project_id,
            name="iris",
            version="2",
            lifecycle=ModelLifecycle.PRODUCTION,
            mlflow_model_name=f"project-{project_id}-iris",
            mlflow_version="2",
            training_job_id=db.get(ModelVersion, model_id).training_job_id,
            dataset_version_id=db.get(ModelVersion, model_id).dataset_version_id,
            model_uri="models:/demo/2",
            mlflow_run_id="run-2",
            metrics_json=json.dumps({"accuracy": 0.9}),
            metadata_json=json.dumps({"problem_type": "classification", "target_columns": ["target"]}),
            created_by=1,
        )
        db.add(other)
        db.flush()
        endpoint = db.get(Endpoint, endpoint_id)
        endpoint.model_version_id = other.id
        db.commit()
        other_id = other.id

    # Predictions against the swapped model so sufficiency passes and baseline mismatch is hit.
    monkeypatch.setattr(
        "app.services.inference.predict",
        lambda *args, **kwargs: [1, 1],
    )
    predicted_b = client.post(
        f"/api/v1/endpoints/{endpoint_id}/predict",
        headers=auth_headers,
        json={"instances": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]},
    ).json()
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={
            "items": [
                {"prediction_id": predicted_b["prediction_ids"][0], "actual": 1},
                {"prediction_id": predicted_b["prediction_ids"][1], "actual": 1},
            ]
        },
    )

    run2 = _enqueue_and_process(client, auth_headers, project_id, policy_id)
    assert run2.quality_status == "insufficient_data"
    assert run2.model_version_id == other_id
    assert json.loads(run2.evaluation_json)["reason"] == "baseline_model_mismatch"
    with TestingSessionLocal() as db:
        alerts = list(
            db.scalars(
                select(Alert).where(Alert.alert_type == "model_quality_degradation")
            ).all()
        )
        assert alerts == []


def test_minimum_match_rate_gate(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()
    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "rate",
            "primary_metric": "accuracy",
            "warning_threshold": 0.5,
            "critical_threshold": 0.4,
            "minimum_matched_samples": 2,
            "minimum_match_rate": 0.5,
            "auto_retrain": False,
        },
    ).json()
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
    # Only 1 matched of 4 → rate 0.25 < 0.5
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={"items": [{"prediction_id": predicted["prediction_ids"][0], "actual": 0}]},
    )
    # Need at least 2 matched for samples gate; add another but still below rate if we only have 2/4=0.5 exactly.
    # Use 2 matched of 4 = 0.5 which equals minimum — should pass rate. So only 1 matched.
    # Wait: minimum_matched_samples=2 means 1 matched fails samples first.
    # Adjust: minimum_matched_samples=1, minimum_match_rate=0.5, matched=1/4=0.25
    client.patch(
        f"/api/v1/projects/{project_id}/model-quality/policies/{created['id']}",
        headers=auth_headers,
        json={"minimum_matched_samples": 1},
    )
    run = _enqueue_and_process(client, auth_headers, project_id, created["id"])
    assert run.quality_status == "insufficient_data"
    assert json.loads(run.evaluation_json)["reason"] == "minimum_match_rate"


def test_evaluation_delay_window(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model_id = seeded["model"].id
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=endpoint_id,
            name="delay",
            window_hours=24,
            evaluation_delay_hours=2,
            minimum_matched_samples=1,
            primary_metric="accuracy",
            warning_threshold=0.5,
            critical_threshold=0.4,
            consecutive_breaches=2,
            cooldown_hours=0,
            auto_retrain=False,
        )
        db.add(policy)
        db.flush()
        now = datetime.now(timezone.utc)
        # Prediction inside delay window — should be excluded.
        recent = PredictionObservation(
            id="pred-recent",
            project_id=project_id,
            endpoint_id=endpoint_id,
            model_version_id=model_id,
            request_id="req-recent",
            instance_index=0,
            prediction_json="1",
            predicted_at=now - timedelta(minutes=30),
        )
        # Prediction in evaluate window (3h ago).
        older = PredictionObservation(
            id="pred-old",
            project_id=project_id,
            endpoint_id=endpoint_id,
            model_version_id=model_id,
            request_id="req-old",
            instance_index=0,
            prediction_json="1",
            predicted_at=now - timedelta(hours=3),
        )
        db.add_all([recent, older])
        from app.db.models import GroundTruthFeedback

        db.add(
            GroundTruthFeedback(
                project_id=project_id,
                prediction_observation_id="pred-old",
                actual_json="1",
                source="test",
                review_status="PENDING",
            )
        )
        db.add(
            GroundTruthFeedback(
                project_id=project_id,
                prediction_observation_id="pred-recent",
                actual_json="0",
                source="test",
                review_status="PENDING",
            )
        )
        db.commit()
        policy_id = policy.id

    run = _enqueue_and_process(client, auth_headers, project_id, policy_id)
    assert run.prediction_count == 1
    assert run.matched_ground_truth_count == 1
    assert run.quality_status == "ok"


def test_consecutive_breach_revision_isolation(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint"].id,
            name="iso",
            primary_metric="accuracy",
            warning_threshold=0.9,
            critical_threshold=0.8,
            consecutive_breaches=2,
            cooldown_hours=0,
            auto_retrain=True,
            revision=2,
        )
        db.add(policy)
        db.flush()
        # Old revision critical should not count.
        db.add(
            ModelQualityRun(
                project_id=project_id,
                policy_id=policy.id,
                endpoint_id=seeded["endpoint"].id,
                model_version_id=seeded["model"].id,
                status=JobStatus.succeeded,
                quality_status="critical",
                policy_revision=1,
                policy_snapshot_json=json.dumps({"revision": 1, "auto_retrain": True, "consecutive_breaches": 2, "cooldown_hours": 0}),
                evaluation_json="{}",
                metrics_json="{}",
                thresholds_json="{}",
            )
        )
        current = ModelQualityRun(
            project_id=project_id,
            policy_id=policy.id,
            endpoint_id=seeded["endpoint"].id,
            model_version_id=seeded["model"].id,
            status=JobStatus.succeeded,
            quality_status="critical",
            policy_revision=2,
            policy_snapshot_json=json.dumps(
                {
                    "revision": 2,
                    "auto_retrain": True,
                    "consecutive_breaches": 2,
                    "cooldown_hours": 0,
                    "rule_logic": "any",
                }
            ),
            evaluation_json=json.dumps({"rules": [{"status": "critical", "metric": "accuracy"}]}),
            metrics_json=json.dumps({"accuracy": 0.1}),
            thresholds_json="{}",
        )
        db.add(current)
        db.commit()
        count = mq.count_consecutive_breaches(
            db,
            policy_id=policy.id,
            model_version_id=seeded["model"].id,
            policy_revision=2,
        )
        assert count == 1


def test_alert_uses_evaluation_evidence(client, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        policy = ModelQualityPolicy(
            project_id=project_id,
            endpoint_id=seeded["endpoint"].id,
            name="alert",
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            revision=4,
        )
        db.add(policy)
        db.flush()
        run = ModelQualityRun(
            project_id=project_id,
            policy_id=policy.id,
            endpoint_id=seeded["endpoint"].id,
            model_version_id=seeded["model"].id,
            status=JobStatus.succeeded,
            quality_status="critical",
            prediction_count=80,
            matched_ground_truth_count=54,
            policy_revision=4,
            policy_snapshot_json=json.dumps({"revision": 4}),
            evaluation_json=json.dumps(
                {
                    "rule_logic": "any",
                    "rules": [
                        {
                            "metric": "f1_macro",
                            "comparison": "baseline_delta",
                            "degradation_delta": 0.18,
                            "critical_threshold": 0.15,
                            "warning_threshold": 0.1,
                            "status": "critical",
                        },
                        {
                            "metric": "accuracy",
                            "comparison": "absolute",
                            "current_value": 0.62,
                            "critical_threshold": 0.65,
                            "warning_threshold": 0.75,
                            "status": "critical",
                        },
                        {"metric": "precision_macro", "status": "ok"},
                    ],
                    "quality_status": "critical",
                }
            ),
            metrics_json=json.dumps({"f1_macro": 0.72, "accuracy": 0.62}),
            thresholds_json="{}",
        )
        db.add(run)
        db.commit()
        alert = closed_loop.maybe_create_degradation_alert(
            db,
            run=run,
            policy=policy,
            endpoint=seeded["endpoint"],
        )
        db.commit()
        assert alert is not None
        assert "2 of 3 rules breached" in alert.message
        assert "baseline delta" in alert.message
        assert "Policy revision: 4" in alert.message


def test_viewer_cannot_mutate_baseline(client, viewer_headers, auth_headers, project_id):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        db.commit()
    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "rbac",
            "primary_metric": "accuracy",
            "warning_threshold": 0.9,
            "critical_threshold": 0.8,
        },
    ).json()
    denied = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies/{created['id']}/baseline",
        headers=viewer_headers,
        json={"quality_run_id": 1},
    )
    assert denied.status_code in {401, 403}


def test_critical_advanced_retrain_candidate_only(client, auth_headers, project_id, monkeypatch):
    with TestingSessionLocal() as db:
        seeded = _seed_endpoint(db, project_id)
        endpoint_id = seeded["endpoint"].id
        model_id = seeded["model"].id
        v2_id = seeded["v2"].id
        db.commit()

    created = client.post(
        f"/api/v1/projects/{project_id}/model-quality/policies",
        headers=auth_headers,
        json={
            "endpoint_id": endpoint_id,
            "name": "retrain",
            "minimum_matched_samples": 3,
            "consecutive_breaches": 1,
            "cooldown_hours": 0,
            "auto_retrain": True,
            "rule_logic": "any",
            "rules": [
                {
                    "metric": "accuracy",
                    "comparison": "absolute",
                    "warning_threshold": 0.8,
                    "critical_threshold": 0.7,
                }
            ],
        },
    )
    assert created.status_code == 201, created.text
    policy_id = created.json()["id"]

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
    client.post(
        f"/api/v1/projects/{project_id}/ground-truth",
        headers=auth_headers,
        json={
            "items": [
                {"prediction_id": pid, "actual": 0}
                for pid in predicted["prediction_ids"]
            ]
        },
    )

    run = _enqueue_and_process(client, auth_headers, project_id, policy_id)
    assert run.quality_status == "critical"
    decision = json.loads(run.trigger_decision_json)
    assert decision["action"] == "retrain_triggered"
    job_id_created = decision["training_job_id"]

    with TestingSessionLocal() as db:
        trigger = db.scalar(
            select(RetrainTrigger).where(RetrainTrigger.quality_run_id == run.id)
        )
        assert trigger is not None
        config = json.loads(trigger.config_json)
        assert config["policy_revision"] == 1
        assert "critical_rule_count" in config
        job = db.get(TrainingJob, job_id_created)
        assert job is not None
        assert job.dataset_version_id == v2_id
        # Simulate success + candidate registration
        job.status = JobStatus.succeeded
        job.mlflow_run_id = "closed-loop-run"
        db.commit()

    monkeypatch.setattr(
        registry_service,
        "register_from_run",
        lambda db, **kwargs: _fake_register(db, **kwargs),
    )
    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_id_created)
        candidate = closed_loop.register_candidate_idempotently(db, training_job=job)
        db.commit()
        assert candidate is not None
        assert candidate.lifecycle == ModelLifecycle.CANDIDATE
        assert candidate.lifecycle != ModelLifecycle.PENDING_APPROVAL
        assert candidate.lifecycle != ModelLifecycle.PRODUCTION
        endpoint = db.get(Endpoint, endpoint_id)
        assert endpoint.model_version_id == model_id  # no swap


def _fake_register(db, **kwargs):
    row = ModelVersion(
        project_id=kwargs["project_id"],
        name=kwargs.get("registry_model_name") or f"project-{kwargs['project_id']}-iris",
        version="99",
        lifecycle=ModelLifecycle.CANDIDATE,
        mlflow_model_name=kwargs.get("registry_model_name")
        or f"project-{kwargs['project_id']}-iris",
        mlflow_version="99",
        training_job_id=kwargs.get("training_job_id"),
        dataset_version_id=kwargs.get("dataset_version_id"),
        model_uri="models:/x/99",
        mlflow_run_id=kwargs["run_id"],
        metrics_json="{}",
        metadata_json="{}",
        created_by=kwargs.get("created_by"),
    )
    db.add(row)
    db.flush()
    return row


def test_effective_quality_rules_legacy_and_advanced():
    class Fake:
        primary_metric = "f1_macro"
        warning_threshold = 0.8
        critical_threshold = 0.7
        rules_json = "[]"

    rules = qp.effective_quality_rules(Fake())
    assert len(rules) == 1
    assert rules[0]["comparison"] == "absolute"

    class Adv:
        primary_metric = "f1_macro"
        warning_threshold = 0.8
        critical_threshold = 0.7
        rules_json = json.dumps(
            [
                {
                    "metric": "accuracy",
                    "target": None,
                    "comparison": "absolute",
                    "warning_threshold": 0.9,
                    "critical_threshold": 0.8,
                }
            ]
        )

    rules2 = qp.effective_quality_rules(Adv())
    assert rules2[0]["metric"] == "accuracy"
