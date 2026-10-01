"""Phase 6-C direct multi-horizon forecasting regressions."""

from __future__ import annotations

import io
import json
import secrets

import mlflow
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
from app.schemas.v1 import JobCreate, JobRetrainRequest
from app.services import mlflow_service, registry_service, storage
from app.services.continued_training import ContinuedTrainingError, validate_continued_source
from app.services.forecasting import (
    ForecastingError,
    assert_no_cross_partition_labels,
    build_forecast_supervised_partition,
    forecast_output_names,
    normalize_forecast_horizons,
)
from app.services.prediction_serialization import (
    assign_batch_prediction_columns,
    serialize_predictions,
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


def _forecast_csv(n: int = 40) -> bytes:
    rows = ["event_time,sales,sales_lag_1,sales_roll_avg_3"]
    for i in range(1, n + 1):
        day = f"2024-01-{i:02d}" if i <= 31 else f"2024-02-{i - 31:02d}"
        sales = 10 * i
        lag = "" if i == 1 else str(10 * (i - 1))
        roll = str(sales) if i < 3 else str((10 * (i - 2) + 10 * (i - 1) + sales) / 3)
        rows.append(f"{day},{sales},{lag},{roll}")
    return ("\n".join(rows) + "\n").encode()


FORECAST_CSV = _forecast_csv(40)


@pytest.fixture(autouse=True)
def setup_forecast_tests(monkeypatch):
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


def _project_dataset(client, auth_headers, csv: bytes = FORECAST_CSV):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"fc-{secrets.token_hex(4)}"},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]
    dataset = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": ("forecast.csv", csv, "text/csv")},
    )
    assert dataset.status_code == 201
    return project_id, dataset.json()["id"], dataset.json()["version"]["id"]


def _base_forecast_payload(dataset_id: int, version_id: int, **overrides):
    payload = {
        "name": "forecast-job",
        "dataset_id": dataset_id,
        "dataset_version_id": version_id,
        "target_columns": ["sales"],
        "problem_type": "regression",
        "algorithm": "ridge",
        "feature_columns": ["sales_lag_1", "sales_roll_avg_3"],
        "train_ratio": 0.6,
        "val_ratio": 0.2,
        "test_ratio": 0.2,
        "split_strategy": "time",
        "time_column": "event_time",
        "training_task": "forecasting",
        "forecast_strategy": "direct_multioutput",
        "forecast_horizons": [1, 2, 3],
    }
    payload.update(overrides)
    return payload


# --- Helpers -----------------------------------------------------------------


def test_normalize_horizons_and_output_names():
    assert normalize_forecast_horizons([3, 1, 2]) == [1, 2, 3]
    assert forecast_output_names("sales", [1, 2, 3]) == [
        "sales__t_plus_1",
        "sales__t_plus_2",
        "sales__t_plus_3",
    ]
    with pytest.raises(ForecastingError, match="positive"):
        normalize_forecast_horizons([0])
    with pytest.raises(ForecastingError, match="positive"):
        normalize_forecast_horizons([-1])
    with pytest.raises(ForecastingError, match="positive"):
        normalize_forecast_horizons([True])  # type: ignore[list-item]
    with pytest.raises(ForecastingError, match="duplicates"):
        normalize_forecast_horizons([1, 1])
    with pytest.raises(ForecastingError, match="non-empty"):
        normalize_forecast_horizons([])


def test_horizon_alignment_and_null_drop():
    frame = pd.DataFrame(
        {
            "sales": [10, 20, 30, 40, 50],
            "feat": [1, 2, 3, 4, 5],
        }
    )
    x, y = build_forecast_supervised_partition(
        frame,
        target_column="sales",
        feature_columns=["feat"],
        horizons=[1],
        partition_label="train",
        require_min_rows=False,
    )
    assert y["sales__t_plus_1"].tolist() == [20, 30, 40, 50]
    assert x["feat"].tolist() == [1, 2, 3, 4]

    x3, y3 = build_forecast_supervised_partition(
        frame,
        target_column="sales",
        feature_columns=["feat"],
        horizons=[1, 2, 3],
        partition_label="train",
        require_min_rows=False,
    )
    assert list(y3.columns) == [
        "sales__t_plus_1",
        "sales__t_plus_2",
        "sales__t_plus_3",
    ]
    assert y3.iloc[0].tolist() == [20, 30, 40]
    assert len(x3) == 2  # origins without full future window dropped

    punctured = frame.copy()
    punctured.loc[3, "sales"] = np.nan
    x_drop, y_drop = build_forecast_supervised_partition(
        punctured,
        target_column="sales",
        feature_columns=["feat"],
        horizons=[1],
        partition_label="train",
        require_min_rows=False,
    )
    # Origin at index 2 would need sales[3] which is null → dropped.
    assert x_drop["feat"].tolist() == [1, 2, 4]


def test_partition_before_shift_no_cross_boundary_labels():
    """Critical leakage invariant for runtime partitions."""
    sales = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140]
    frame = pd.DataFrame(
        {
            "event_time": list(range(len(sales))),
            "sales": sales,
            "feat": list(range(len(sales))),
        }
    )
    # 6 / 4 / 4 ≈ 0.43 / 0.29 / 0.29 — use exact boundaries matching the example.
    train_raw = frame.iloc[:6].copy()
    val_raw = frame.iloc[6:10].copy()
    test_raw = frame.iloc[10:].copy()
    assert train_raw["sales"].tolist() == [10, 20, 30, 40, 50, 60]
    assert val_raw["sales"].tolist() == [70, 80, 90, 100]
    assert test_raw["sales"].tolist() == [110, 120, 130, 140]

    horizons = [1, 2]
    x_train, y_train = build_forecast_supervised_partition(
        train_raw,
        target_column="sales",
        feature_columns=["feat"],
        horizons=horizons,
        partition_label="train",
    )
    x_val, y_val = build_forecast_supervised_partition(
        val_raw,
        target_column="sales",
        feature_columns=["feat"],
        horizons=horizons,
        partition_label="validation",
    )
    x_test, y_test = build_forecast_supervised_partition(
        test_raw,
        target_column="sales",
        feature_columns=["feat"],
        horizons=horizons,
        partition_label="test",
    )

    train_labels = y_train.values.reshape(-1).tolist()
    assert_no_cross_partition_labels(
        train_target_values=train_labels,
        forbidden_values=set(val_raw["sales"].tolist() + test_raw["sales"].tolist()),
    )
    # Last usable train origin max future label is 60 (inside train).
    assert max(train_labels) == 60
    assert 70 not in train_labels
    assert 80 not in train_labels

    val_labels = y_val.values.reshape(-1).tolist()
    assert_no_cross_partition_labels(
        train_target_values=val_labels,
        forbidden_values=set(test_raw["sales"].tolist()),
    )
    assert max(val_labels) == 100
    assert 110 not in val_labels

    # Wrong approach (full-frame shift then split) WOULD leak — prove it fails the invariant.
    wrong = frame.copy()
    wrong["y1"] = wrong["sales"].shift(-1)
    wrong["y2"] = wrong["sales"].shift(-2)
    wrong_train = wrong.iloc[:6]
    leaked = wrong_train[["y1", "y2"]].dropna().values.reshape(-1).tolist()
    with pytest.raises(AssertionError, match="leakage"):
        assert_no_cross_partition_labels(
            train_target_values=leaked,
            forbidden_values=set(val_raw["sales"].tolist()),
        )


def test_insufficient_partition_rows_reject():
    frame = pd.DataFrame({"sales": [1, 2, 3], "feat": [1, 2, 3]})
    with pytest.raises(ForecastingError, match="Not enough rows in the train"):
        build_forecast_supervised_partition(
            frame,
            target_column="sales",
            feature_columns=["feat"],
            horizons=[1, 2],
            partition_label="train",
        )


# --- API validation ----------------------------------------------------------


def test_legacy_tabular_unchanged(client, auth_headers):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "tabular",
            "dataset_id": dataset_id,
            "dataset_version_id": version_id,
            "target_columns": ["sales"],
            "problem_type": "regression",
            "algorithm": "ridge",
            "feature_columns": ["sales_lag_1", "sales_roll_avg_3"],
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["training_task"] == "tabular"
    assert body["forecast_strategy"] is None
    assert body["forecast_horizons"] == []
    assert body["forecast_output_names"] == []


def test_forecast_job_create_contract(client, auth_headers):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_base_forecast_payload(dataset_id, version_id),
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["training_task"] == "forecasting"
    assert body["forecast_strategy"] == "direct_multioutput"
    assert body["forecast_horizons"] == [1, 2, 3]
    assert body["forecast_output_names"] == [
        "sales__t_plus_1",
        "sales__t_plus_2",
        "sales__t_plus_3",
    ]
    assert body["problem_type"] == "regression"
    assert body["split_strategy"] == "time"
    assert body["time_column"] == "event_time"


@pytest.mark.parametrize(
    "overrides,match",
    [
        ({"target_columns": ["sales", "sales_lag_1"]}, "exactly one"),
        ({"problem_type": "classification"}, "regression"),
        ({"split_strategy": "random"}, "time"),
        ({"time_column": None, "split_strategy": "time"}, "time_column"),
        ({"forecast_horizons": []}, "forecast_horizons|non-empty"),
        ({"forecast_horizons": [0]}, "positive"),
        ({"forecast_horizons": [1, 1]}, "duplicate"),
        ({"algorithm": "sgd_regressor"}, "does not support forecasting"),
        ({"algorithm": "random_forest"}, "does not support|regression|algorithm"),
    ],
)
def test_forecast_validation_rejects(client, auth_headers, overrides, match):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    payload = _base_forecast_payload(dataset_id, version_id, **overrides)
    if "time_column" in overrides and overrides["time_column"] is None:
        payload.pop("time_column", None)
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=payload,
    )
    assert created.status_code in {400, 422}, created.text
    assert created.json()["detail"]


def test_forecast_rejects_random_saved_split(client, auth_headers):
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "name": "random-split",
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
            "random_seed": 42,
            "split_strategy": "random",
        },
    )
    assert split.status_code == 201
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_base_forecast_payload(
            dataset_id,
            version_id,
            split_id=split.json()["id"],
            # Client may omit runtime split fields when using saved split.
            split_strategy="random",
            time_column=None,
        ),
    )
    assert created.status_code == 422, created.text
    assert "time" in created.json()["detail"].lower()


def test_boolean_target_rejected(client, auth_headers):
    csv = (
        b"event_time,flag,feat\n"
        + b"".join(
            f"2024-01-{i:02d},{str(i % 2 == 0).lower()},{i}\n".encode()
            for i in range(1, 21)
        )
    )
    project_id, dataset_id, version_id = _project_dataset(client, auth_headers, csv=csv)
    created = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_base_forecast_payload(
            dataset_id,
            version_id,
            target_columns=["flag"],
            feature_columns=["feat"],
        ),
    )
    assert created.status_code == 422
    assert "numeric" in created.json()["detail"].lower() or "boolean" in created.json()["detail"].lower()


# --- Training runtime --------------------------------------------------------


def test_ridge_multi_horizon_training_and_mlflow(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_TRACKING_URI", tracking.as_uri())
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    from app.core.config import settings

    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=1,
            project_id=1,
            job_name="fc-ridge",
            target_column="sales",
            target_columns=["sales"],
            algorithm="ridge",
            hyperparameters={"alpha": 1.0},
            csv_bytes=FORECAST_CSV,
            experiment_name="fc-exp",
            problem_type="regression",
            feature_columns=["sales_lag_1", "sales_roll_avg_3"],
            train_ratio=0.6,
            val_ratio=0.2,
            test_ratio=0.2,
            split_strategy="time",
            time_column="event_time",
            training_task="forecasting",
            forecast_strategy="direct_multioutput",
            forecast_horizons=[1, 2, 3],
        )
    )
    assert result.mlflow_run_id
    assert "rmse" in result.metrics
    assert "mae" in result.metrics
    assert "r2" in result.metrics
    assert "test_target_0_rmse" in result.metrics or "val_target_0_rmse" in result.metrics
    assert result.params["training_task"] == "forecasting"
    assert result.params["forecast_strategy"] == "direct_multioutput"
    assert json.loads(result.params["forecast_horizons"]) == [1, 2, 3]
    assert json.loads(result.params["target_columns"]) == [
        "sales__t_plus_1",
        "sales__t_plus_2",
        "sales__t_plus_3",
    ]

    client = mlflow.tracking.MlflowClient(tracking_uri=tracking.as_uri())
    run = client.get_run(result.mlflow_run_id)
    assert run.data.tags.get("modelflow.training_task") == "forecasting"
    assert run.data.tags.get("modelflow.forecast_strategy") == "direct_multioutput"
    artifacts = {item.path for item in client.list_artifacts(result.mlflow_run_id)}
    assert "forecast_metrics.json" in artifacts
    assert "training_metadata.json" in artifacts
    local = mlflow.artifacts.download_artifacts(
        run_id=result.mlflow_run_id,
        artifact_path="training_metadata.json",
        dst_path=str(tmp_path / "meta"),
    )
    with open(local) as fh:
        metadata = json.load(fh)
    assert metadata["training_task"] == "forecasting"
    assert metadata["forecasting"]["horizons"] == [1, 2, 3]
    assert metadata["target_columns"] == [
        "sales__t_plus_1",
        "sales__t_plus_2",
        "sales__t_plus_3",
    ]


@pytest.mark.parametrize(
    "algorithm,hyperparameters",
    [
        ("random_forest_regressor", {"n_estimators": 8, "max_depth": 3}),
        ("gradient_boosting_regressor", {"n_estimators": 8, "max_depth": 2, "learning_rate": 0.2}),
    ],
)
def test_supported_forecast_algorithms(tmp_path, monkeypatch, algorithm, hyperparameters):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_TRACKING_URI", tracking.as_uri())
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    from app.core.config import settings

    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    result = SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=2,
            project_id=1,
            job_name=f"fc-{algorithm}",
            target_column="sales",
            target_columns=["sales"],
            algorithm=algorithm,
            hyperparameters=hyperparameters,
            csv_bytes=FORECAST_CSV,
            experiment_name="fc-exp",
            problem_type="regression",
            feature_columns=["sales_lag_1", "sales_roll_avg_3"],
            train_ratio=0.6,
            val_ratio=0.2,
            test_ratio=0.2,
            split_strategy="time",
            time_column="event_time",
            training_task="forecasting",
            forecast_strategy="direct_multioutput",
            forecast_horizons=[1, 2],
        )
    )
    assert "rmse" in result.metrics
    assert json.loads(result.params["forecast_output_names"]) == [
        "sales__t_plus_1",
        "sales__t_plus_2",
    ]


def test_runtime_training_no_cross_partition_labels(tmp_path, monkeypatch):
    """Runner must partition raw rows before building horizon labels."""
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_TRACKING_URI", tracking.as_uri())
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    from app.core.config import settings

    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    sales = list(range(10, 150, 10))  # 14 points
    csv = "event_time,sales,feat\n" + "".join(
        f"2024-01-{i + 1:02d},{sales[i]},{i}\n" for i in range(len(sales))
    )
    # Spy into supervised builder via wrapping to capture train labels.
    captured: dict[str, list] = {}
    original = build_forecast_supervised_partition

    def wrapped(partition, **kwargs):
        x, y = original(partition, **kwargs)
        label = kwargs["partition_label"]
        captured[label] = y.values.reshape(-1).tolist() if not y.empty else []
        captured[f"{label}_raw_sales"] = partition["sales"].tolist()
        return x, y

    # Local import inside SklearnTrainingRunner.run resolves this module attribute.
    monkeypatch.setattr(
        "app.services.forecasting.build_forecast_supervised_partition",
        wrapped,
    )

    SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=3,
            project_id=1,
            job_name="fc-leak",
            target_column="sales",
            target_columns=["sales"],
            algorithm="ridge",
            hyperparameters={"alpha": 1.0},
            csv_bytes=csv.encode(),
            experiment_name="fc-exp",
            problem_type="regression",
            feature_columns=["feat"],
            train_ratio=6 / 14,
            val_ratio=4 / 14,
            test_ratio=4 / 14,
            split_strategy="time",
            time_column="event_time",
            training_task="forecasting",
            forecast_strategy="direct_multioutput",
            forecast_horizons=[1, 2],
        )
    )
    assert captured["train_raw_sales"] == [10, 20, 30, 40, 50, 60]
    assert_no_cross_partition_labels(
        train_target_values=captured["train"],
        forbidden_values=set(captured["validation_raw_sales"] + captured["test_raw_sales"]),
    )
    assert max(captured["train"]) == 60


def test_saved_time_split_forecast_no_cross_boundary(tmp_path, monkeypatch, client, auth_headers):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_TRACKING_URI", tracking.as_uri())
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    from app.core.config import settings

    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    project_id, dataset_id, version_id = _project_dataset(client, auth_headers)
    split = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/splits",
        headers=auth_headers,
        json={
            "name": "fc-time",
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
            "random_seed": 42,
            "split_strategy": "time",
            "time_column": "event_time",
        },
    )
    assert split.status_code == 201
    body = split.json()
    train_bytes = next(v for (_b, k), v in OBJECT_STORE.items() if k == body["object_keys"]["train"])
    val_bytes = next(v for (_b, k), v in OBJECT_STORE.items() if k == body["object_keys"]["validation"])
    test_bytes = next(v for (_b, k), v in OBJECT_STORE.items() if k == body["object_keys"]["test"])

    train_sales = set(pd.read_csv(io.BytesIO(train_bytes))["sales"].tolist())
    val_sales = set(pd.read_csv(io.BytesIO(val_bytes))["sales"].tolist())
    test_sales = set(pd.read_csv(io.BytesIO(test_bytes))["sales"].tolist())

    captured: dict[str, list] = {}
    original = build_forecast_supervised_partition

    def wrapped(partition, **kwargs):
        x, y = original(partition, **kwargs)
        captured[kwargs["partition_label"]] = (
            y.values.reshape(-1).tolist() if not y.empty else []
        )
        return x, y

    monkeypatch.setattr(
        "app.services.forecasting.build_forecast_supervised_partition",
        wrapped,
    )

    SklearnTrainingRunner().run(
        TrainingJobContext(
            job_id=4,
            project_id=project_id,
            job_name="fc-saved",
            target_column="sales",
            target_columns=["sales"],
            algorithm="ridge",
            hyperparameters={"alpha": 1.0},
            train_bytes=train_bytes,
            validation_bytes=val_bytes,
            test_bytes=test_bytes,
            split_id=body["id"],
            experiment_name="fc-exp",
            problem_type="regression",
            feature_columns=["sales_lag_1", "sales_roll_avg_3"],
            train_ratio=0.6,
            val_ratio=0.2,
            test_ratio=0.2,
            split_strategy="time",
            time_column="event_time",
            training_task="forecasting",
            forecast_strategy="direct_multioutput",
            forecast_horizons=[1, 2],
        )
    )
    assert_no_cross_partition_labels(
        train_target_values=captured["train"],
        forbidden_values=val_sales | test_sales,
    )
    assert max(captured["train"]) <= max(train_sales)


# --- Lifecycle ---------------------------------------------------------------


def test_retry_clone_retrain_preserve_forecast_and_continue_rejects():
    source = TrainingJob(
        id=10,
        project_id=1,
        dataset_id=1,
        dataset_version_id=2,
        name="fc-source",
        description="",
        target_column="sales",
        target_columns_json='["sales"]',
        problem_type="regression",
        algorithm="ridge",
        hyperparameters_json="{}",
        preprocessing_json="{}",
        feature_columns_json='["sales_lag_1"]',
        metrics_config_json="[]",
        resource_json="{}",
        random_seed=42,
        train_ratio=0.6,
        val_ratio=0.2,
        test_ratio=0.2,
        split_strategy="time",
        time_column="event_time",
        training_task="forecasting",
        forecast_strategy="direct_multioutput",
        forecast_horizons_json="[1,2,3]",
        max_retries=1,
        status=JobStatus.succeeded,
        model_uri="runs:/abc/model",
        mlflow_run_id="abc",
    )
    cloned = build_job_create_from_source(source, default_name_suffix="clone")
    assert cloned.training_task == "forecasting"
    assert cloned.forecast_strategy == "direct_multioutput"
    assert cloned.forecast_horizons == [1, 2, 3]
    assert cloned.split_strategy == "time"
    assert cloned.time_column == "event_time"

    retrained = build_retrain_job_create(
        source,
        JobRetrainRequest(dataset_version_id=3, name="fc-retrain"),
    )
    assert retrained.training_task == "forecasting"
    assert retrained.forecast_horizons == [1, 2, 3]
    assert retrained.forecast_strategy == "direct_multioutput"

    with pytest.raises(ContinuedTrainingError, match="not supported for forecasting"):
        validate_continued_source(source)


def test_algorithm_catalog_forecast_capability(client, auth_headers):
    project_id, _, _ = _project_dataset(client, auth_headers)
    catalog = client.get(
        f"/api/v1/projects/{project_id}/training/algorithms",
        headers=auth_headers,
    )
    assert catalog.status_code == 200
    by_id = {row["id"]: row for row in catalog.json()["algorithms"]}
    assert by_id["ridge"]["supports_forecasting"] is True
    assert by_id["ridge"]["forecasting_strategy"] == "direct_multioutput"
    assert by_id["random_forest_regressor"]["supports_forecasting"] is True
    assert by_id["gradient_boosting_regressor"]["supports_forecasting"] is True
    assert by_id["sgd_regressor"]["supports_forecasting"] is False
    assert by_id["random_forest"]["supports_forecasting"] is False


def test_forecast_output_serialization_names():
    names = forecast_output_names("sales", [1, 2, 3])
    preds = np.array([[101.2, 103.4, 105.1]])
    serialized = serialize_predictions(preds, target_columns=names)
    assert serialized[0] == {
        "sales__t_plus_1": 101.2,
        "sales__t_plus_2": 103.4,
        "sales__t_plus_3": 105.1,
    }
    frame = pd.DataFrame({"feat": [1.0]})
    out = assign_batch_prediction_columns(
        frame, serialized, target_columns=names
    )
    assert "prediction_sales__t_plus_1" in out.columns
    assert "prediction_sales__t_plus_2" in out.columns
    assert "prediction_sales__t_plus_3" in out.columns


def test_job_create_schema_canonicalizes_horizons():
    body = JobCreate.model_validate(
        {
            "name": "x",
            "dataset_id": 1,
            "dataset_version_id": 1,
            "target_columns": ["sales"],
            "problem_type": "regression",
            "algorithm": "ridge",
            "feature_columns": ["a"],
            "split_strategy": "time",
            "time_column": "event_time",
            "training_task": "forecasting",
            "forecast_horizons": [3, 1, 2],
        }
    )
    assert body.forecast_horizons == [1, 2, 3]
    assert body.forecast_strategy == "direct_multioutput"
    assert body.problem_type == "regression"
