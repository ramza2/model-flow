"""Phase 6-A time-aware training foundation regressions."""

from __future__ import annotations

import io
import secrets
from unittest.mock import MagicMock, patch

import numpy as np
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
from app.schemas.v1 import JobRetrainRequest
from app.services import mlflow_service, registry_service, storage
from app.services.dataset_splits import (
    apply_time_ordered_partitions,
    order_frame_by_time,
    split_config_signature,
    time_partition_boundaries,
    validate_time_column_config,
)
from app.services.retrain_service import (
    build_job_create_from_source,
    build_retrain_job_create,
)
from app.services.training import SklearnTrainingRunner, TrainingJobContext

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)

TIME_CSV = (
    b"event_time,a,b,target\n"
    b"2024-01-01,1,2,0\n"
    b"2024-01-02,2,3,0\n"
    b"2024-01-03,3,4,1\n"
    b"2024-01-04,4,5,1\n"
    b"2024-01-05,5,6,1\n"
    b"2024-01-06,6,7,0\n"
    b"2024-01-07,7,8,1\n"
    b"2024-01-08,8,9,0\n"
    b"2024-01-09,9,1,1\n"
    b"2024-01-10,10,2,0\n"
)


@pytest.fixture(autouse=True)
def setup_time_split_tests(monkeypatch):
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


def _project_dataset(client, auth_headers, csv: bytes = TIME_CSV):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"time-{secrets.token_hex(4)}"},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]
    dataset = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("timed.csv", csv, "text/csv")},
    )
    assert dataset.status_code == 201
    return project_id, dataset.json()["id"], dataset.json()["version"]["id"]


def test_legacy_random_split_config_signature_exact():
    assert split_config_signature(0.7, 0.15, 0.15, 42) == "0.700000:0.150000:0.150000:42"
    assert (
        split_config_signature(0.7, 0.15, 0.15, 42, split_strategy="random")
        == "0.700000:0.150000:0.150000:42"
    )
    assert (
        split_config_signature(
            0.7, 0.15, 0.15, 42, split_strategy="random", time_column=None
        )
        == "0.700000:0.150000:0.150000:42"
    )
    timed = split_config_signature(
        0.7, 0.15, 0.15, 42, split_strategy="time", time_column="event_time"
    )
    assert timed.startswith("0.700000:0.150000:0.150000:42:time:")
    assert len(timed) <= 120
    assert timed != "0.700000:0.150000:0.150000:42"


def test_order_frame_datetime_strings_and_duplicates():
    frame = pd.DataFrame(
        {
            "event_time": [
                "2024-01-03",
                "2024-01-01",
                "2024-01-01",
                "2024-01-02",
            ],
            "value": [3, 1, 2, 4],
        }
    )
    ordered = order_frame_by_time(frame, "event_time")
    assert ordered["value"].tolist() == [1, 2, 4, 3]


def test_order_frame_numeric_and_datetime_dtype():
    numeric = pd.DataFrame({"t": [3.0, 1.0, 2.0], "x": [30, 10, 20]})
    assert order_frame_by_time(numeric, "t")["x"].tolist() == [10, 20, 30]

    dt = pd.DataFrame(
        {
            "t": pd.to_datetime(["2024-01-03", "2024-01-01", "2024-01-02"]),
            "x": [3, 1, 2],
        }
    )
    assert order_frame_by_time(dt, "t")["x"].tolist() == [1, 2, 3]


def test_time_value_validation_rejects_bad_values():
    with pytest.raises(ValueError, match="null"):
        order_frame_by_time(
            pd.DataFrame({"t": ["2024-01-01", None], "x": [1, 2]}), "t"
        )
    with pytest.raises(ValueError, match="unparseable"):
        order_frame_by_time(
            pd.DataFrame({"t": ["2024-01-01", "not-a-date"], "x": [1, 2]}), "t"
        )
    with pytest.raises(ValueError, match="infinite|NaN"):
        order_frame_by_time(
            pd.DataFrame({"t": [1.0, float("nan")], "x": [1, 2]}), "t"
        )


def test_time_partition_boundaries_and_reject_empty():
    train_end, val_end = time_partition_boundaries(10, 0.6, 0.2, 0.2)
    assert train_end == 6
    assert val_end == 8
    with pytest.raises(ValueError, match="Not enough rows"):
        time_partition_boundaries(3, 0.6, 0.2, 0.2)


def test_validate_time_column_not_target_or_feature():
    with pytest.raises(ValueError, match="target"):
        validate_time_column_config(
            "event_time",
            columns=["event_time", "a", "target"],
            target_columns=["event_time"],
            feature_columns=["a"],
        )
    with pytest.raises(ValueError, match="feature"):
        validate_time_column_config(
            "event_time",
            columns=["event_time", "a", "target"],
            target_columns=["target"],
            feature_columns=["event_time", "a"],
        )


def test_random_dataset_split_unchanged(client, auth_headers):
    project_id, _, version_id = _project_dataset(client, auth_headers)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "train_ratio": 0.7,
            "val_ratio": 0.15,
            "test_ratio": 0.15,
            "random_seed": 42,
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["split_strategy"] == "random"
    assert body["time_column"] is None
    assert body["config_signature"] == "0.700000:0.150000:0.150000:42"


def test_time_dataset_split_chronological_and_idempotent(client, auth_headers):
    project_id, _, version_id = _project_dataset(client, auth_headers)
    payload = {
        "name": "timed",
        "train_ratio": 0.6,
        "val_ratio": 0.2,
        "test_ratio": 0.2,
        "random_seed": 42,
        "split_strategy": "time",
        "time_column": "event_time",
    }
    first = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json=payload,
    )
    assert first.status_code == 201
    body = first.json()
    assert body["split_strategy"] == "time"
    assert body["time_column"] == "event_time"
    assert body["hashes"]["train"]
    assert body["config_signature"] != "0.600000:0.200000:0.200000:42"

    train_key = body["object_keys"]["train"]
    train_bytes = next(v for (_b, k), v in OBJECT_STORE.items() if k == train_key)
    train_frame = pd.read_csv(io.BytesIO(train_bytes))
    assert train_frame["event_time"].tolist() == [
        "2024-01-01",
        "2024-01-02",
        "2024-01-03",
        "2024-01-04",
        "2024-01-05",
        "2024-01-06",
    ]

    second = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={**payload, "name": "timed-again"},
    )
    assert second.status_code == 200
    assert second.json()["id"] == body["id"]


def test_time_split_rejects_missing_and_null_time(client, auth_headers):
    project_id, _, version_id = _project_dataset(client, auth_headers)
    missing = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "split_strategy": "time",
            "time_column": "missing_col",
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
        },
    )
    assert missing.status_code in {400, 422}

    bad_csv = (
        b"event_time,a,b,target\n"
        b"2024-01-01,1,2,0\n"
        b",2,3,0\n"
        b"2024-01-03,3,4,1\n"
        b"2024-01-04,4,5,1\n"
        b"2024-01-05,5,6,1\n"
    )
    project_id2, _, version_id2 = _project_dataset(client, auth_headers, csv=bad_csv)
    nulls = client.post(
        f"/api/v1/projects/{project_id2}/dataset-versions/{version_id2}/splits",
        headers=auth_headers,
        json={
            "split_strategy": "time",
            "time_column": "event_time",
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
        },
    )
    assert nulls.status_code == 400
    assert "null" in nulls.json()["detail"].lower()


def test_job_create_time_validation_and_saved_split_authority(client, auth_headers):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    as_feature = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "bad-feature",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_column": "target",
            "feature_columns": ["a", "event_time"],
            "split_strategy": "time",
            "time_column": "event_time",
            "algorithm": "logistic_regression",
        },
    )
    assert as_feature.status_code == 422
    assert "feature" in as_feature.json()["detail"].lower()

    as_target = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "bad-target",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_column": "event_time",
            "feature_columns": ["a", "b"],
            "split_strategy": "time",
            "time_column": "event_time",
            "algorithm": "logistic_regression",
            "problem_type": "regression",
        },
    )
    assert as_target.status_code == 422

    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "split_strategy": "time",
            "time_column": "event_time",
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
            "random_seed": 7,
        },
    ).json()

    job = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "from-saved-time",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "split_id": split["id"],
            "target_column": "target",
            "feature_columns": ["a", "b"],
            "algorithm": "logistic_regression",
            "split_strategy": "random",
            "time_column": None,
            "train_ratio": 0.8,
            "val_ratio": 0.1,
            "test_ratio": 0.1,
            "random_seed": 999,
        },
    )
    assert job.status_code == 201
    body = job.json()
    assert body["split_strategy"] == "time"
    assert body["time_column"] == "event_time"
    assert body["ratios"]["train"] == 0.6
    assert body["random_seed"] == 7


def test_direct_time_training_earliest_train_latest_test(monkeypatch):
    frame = pd.read_csv(io.BytesIO(TIME_CSV))
    # Shuffle input to prove runner re-orders.
    frame = frame.sample(frac=1, random_state=0).reset_index(drop=True)
    csv_bytes = frame.to_csv(index=False).encode()

    captured: dict = {}

    class FakeRun:
        info = MagicMock(run_id="run-time-1")

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("app.services.training.mlflow.set_tracking_uri", lambda *_: None)
    monkeypatch.setattr("app.services.training.mlflow.set_experiment", lambda *_: None)
    monkeypatch.setattr("app.services.training.mlflow.start_run", lambda **_: FakeRun())
    monkeypatch.setattr(
        "app.services.training.mlflow.log_params",
        lambda params: captured.update(params=params),
    )
    monkeypatch.setattr(
        "app.services.training.mlflow.set_tags",
        lambda tags: captured.update(tags=tags),
    )
    monkeypatch.setattr("app.services.training.mlflow.log_metrics", lambda *_a, **_k: None)
    monkeypatch.setattr("app.services.training.mlflow.log_dict", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "app.services.training.mlflow.sklearn.log_model",
        lambda *a, **k: MagicMock(model_uri="models:/x"),
    )

    ctx = TrainingJobContext(
        job_id=1,
        project_id=1,
        job_name="time-direct",
        target_column="target",
        algorithm="logistic_regression",
        hyperparameters={},
        experiment_name="exp",
        csv_bytes=csv_bytes,
        feature_columns=["a", "b"],
        train_ratio=0.6,
        val_ratio=0.2,
        test_ratio=0.2,
        random_seed=42,
        split_strategy="time",
        time_column="event_time",
        problem_type="classification",
    )
    with patch("sklearn.pipeline.Pipeline.fit", autospec=True) as fit_mock:
        fit_mock.side_effect = lambda self, x, y=None: self
        with patch(
            "sklearn.pipeline.Pipeline.predict",
            side_effect=lambda self, x: np.zeros(len(x)),
        ):
            result = SklearnTrainingRunner().run(ctx)

    assert result.mlflow_run_id == "run-time-1"
    assert captured["params"]["split_strategy"] == "time"
    assert captured["params"]["time_column"] == "event_time"
    assert captured["tags"]["modelflow.split_strategy"] == "time"
    x_train = fit_mock.call_args.args[1]
    train_a = list(x_train["a"])
    assert train_a == [1, 2, 3, 4, 5, 6]
    # No future rows in train.
    assert max(train_a) == 6


def test_retry_clone_retrain_preserve_time_fields():
    source = TrainingJob(
        id=11,
        project_id=1,
        dataset_id=1,
        dataset_version_id=2,
        split_id=None,
        name="source",
        target_column="target",
        target_columns_json='["target"]',
        problem_type="classification",
        algorithm="logistic_regression",
        hyperparameters_json="{}",
        preprocessing_json="{}",
        feature_columns_json='["a","b"]',
        metrics_config_json="[]",
        resource_json="{}",
        random_seed=42,
        train_ratio=0.6,
        val_ratio=0.2,
        test_ratio=0.2,
        split_strategy="time",
        time_column="event_time",
        status=JobStatus.succeeded,
        model_uri="models:/x",
        mlflow_run_id="run-1",
    )
    cloned = build_job_create_from_source(source, name="clone")
    assert cloned.split_strategy == "time"
    assert cloned.time_column == "event_time"

    retrain = build_retrain_job_create(
        source,
        JobRetrainRequest(dataset_version_id=3, name="retrain"),
    )
    assert retrain.split_strategy == "time"
    assert retrain.time_column == "event_time"
    assert retrain.split_id is None
    assert retrain.dataset_version_id == 3


def test_apply_time_partitions_no_shuffle():
    frame = pd.DataFrame(
        {
            "event_time": [f"2024-01-{i:02d}" for i in range(1, 11)],
            "a": list(range(1, 11)),
            "target": [0, 0, 1, 1, 1, 0, 1, 0, 1, 0],
        }
    )
    parts = apply_time_ordered_partitions(
        frame, time_column="event_time", train_ratio=0.6, val_ratio=0.2, test_ratio=0.2
    )
    assert parts["train"]["a"].tolist() == [1, 2, 3, 4, 5, 6]
    assert parts["validation"]["a"].tolist() == [7, 8]
    assert parts["test"]["a"].tolist() == [9, 10]
