"""Phase 6-D pipeline forecasting authoring / runtime regressions."""

from __future__ import annotations

import json
from io import BytesIO

import numpy as np
import pandas as pd
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import (
    Base,
    BatchInferenceJob,
    Dataset,
    DatasetVersion,
    Endpoint,
    JobStatus,
    ModelLifecycle,
    ModelVersion,
    Pipeline,
    PipelineRun,
    PipelineVersion,
    Project,
    TrainingJob,
)
from app.services import inference, pipeline_engine, storage
from app.services.batch_features import (
    resolve_feature_schema_payload,
    select_batch_feature_frame,
)
from app.services.forecasting import forecast_output_names
from app.services.training import SklearnTrainingRunner, TrainingJobContext


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture()
def pipeline_db():
    Base.metadata.create_all(engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(engine)


def _node(node_id: str, node_type: str, **config):
    return {
        "id": node_id,
        "type": node_type,
        "position": {"x": 0, "y": 0},
        "data": {"config": config},
    }


def _seed_run(db, graph: dict | None = None) -> PipelineRun:
    project = Project(name="fc-pipe")
    db.add(project)
    db.flush()
    pipeline = Pipeline(project_id=project.id, name="p")
    db.add(pipeline)
    db.flush()
    version = PipelineVersion(
        pipeline_id=pipeline.id,
        project_id=project.id,
        version=1,
        graph_json=json.dumps(graph or {"nodes": [], "edges": []}),
    )
    db.add(version)
    db.flush()
    run = PipelineRun(
        project_id=project.id,
        pipeline_id=pipeline.id,
        pipeline_version_id=version.id,
        status=JobStatus.running,
    )
    db.add(run)
    db.flush()
    return run


def _forecast_frame(n: int = 36) -> pd.DataFrame:
    rows = []
    for i in range(1, n + 1):
        month = "01" if i <= 31 else "02"
        day = i if i <= 31 else i - 31
        sales = 10 * i
        lag = np.nan if i == 1 else 10 * (i - 1)
        roll = sales if i < 3 else (10 * (i - 2) + 10 * (i - 1) + sales) / 3
        rows.append(
            {
                "event_time": f"2024-{month}-{day:02d}",
                "sales": sales,
                "sales_lag_1": lag,
                "sales_roll_avg_3": roll,
                "extra_column": i,
            }
        )
    return pd.DataFrame(rows)


# --- Strict validation -------------------------------------------------------


def _training_graph(**training_config):
    return {
        "nodes": [
            _node("d1", "dataset_load", dataset_id=1, dataset_version_id=1),
            _node("t1", "training", **training_config),
        ],
        "edges": [{"source": "d1", "target": "t1", "sourceHandle": "data", "targetHandle": "data"}],
    }


def test_legacy_tabular_training_graph_unchanged():
    result = pipeline_engine.validate_graph(
        _training_graph(
            target_column="sales",
            algorithm="ridge",
            problem_type="regression",
            feature_columns=["sales_lag_1"],
        ),
        strict=True,
    )
    assert result["valid"] is True, result["errors"]


@pytest.mark.parametrize(
    "config,match",
    [
        (
            {
                "training_task": "forecasting",
                "target_columns": ["sales", "sales_lag_1"],
                "problem_type": "regression",
                "algorithm": "ridge",
                "split_strategy": "time",
                "time_column": "event_time",
                "forecast_horizons": [1, 2],
            },
            "exactly one",
        ),
        (
            {
                "training_task": "forecasting",
                "target_column": "sales",
                "problem_type": "classification",
                "algorithm": "ridge",
                "split_strategy": "time",
                "time_column": "event_time",
                "forecast_horizons": [1, 2],
            },
            "regression",
        ),
        (
            {
                "training_task": "forecasting",
                "target_column": "sales",
                "problem_type": "regression",
                "algorithm": "ridge",
                "split_strategy": "random",
                "forecast_horizons": [1, 2],
            },
            "time-ordered",
        ),
        (
            {
                "training_task": "forecasting",
                "target_column": "sales",
                "problem_type": "regression",
                "algorithm": "ridge",
                "split_strategy": "time",
                "forecast_horizons": [1, 2],
            },
            "time_column",
        ),
        (
            {
                "training_task": "forecasting",
                "target_column": "sales",
                "problem_type": "regression",
                "algorithm": "ridge",
                "split_strategy": "time",
                "time_column": "event_time",
                "forecast_horizons": [],
            },
            "forecast_horizons|non-empty",
        ),
        (
            {
                "training_task": "forecasting",
                "target_column": "sales",
                "problem_type": "regression",
                "algorithm": "sgd_regressor",
                "split_strategy": "time",
                "time_column": "event_time",
                "forecast_horizons": [1, 2],
            },
            "does not support forecasting",
        ),
        (
            {
                "training_task": "forecasting",
                "target_column": "sales",
                "problem_type": "regression",
                "algorithm": "ridge",
                "split_strategy": "time",
                "time_column": "event_time",
                "forecast_horizons": [1, 1],
            },
            "duplicate",
        ),
    ],
)
def test_forecast_training_strict_validation_rejects(config, match):
    result = pipeline_engine.validate_graph(_training_graph(**config), strict=True)
    assert result["valid"] is False
    joined = " ".join(result["errors"]).lower()
    assert any(part in joined for part in match.lower().split("|")), result["errors"]


def test_valid_ridge_forecasting_graph_passes():
    result = pipeline_engine.validate_graph(
        _training_graph(
            training_task="forecasting",
            target_column="sales",
            problem_type="regression",
            algorithm="ridge",
            feature_columns=["sales_lag_1", "sales_roll_avg_3"],
            split_strategy="time",
            time_column="event_time",
            forecast_strategy="direct_multioutput",
            forecast_horizons=[3, 1, 2],
        ),
        strict=True,
    )
    assert result["valid"] is True, result["errors"]


def test_draft_strict_false_allows_incomplete_forecast():
    result = pipeline_engine.validate_graph(
        {
            "nodes": [
                _node(
                    "t1",
                    "training",
                    training_task="forecasting",
                    target_column="",
                    algorithm="",
                )
            ],
            "edges": [],
        },
        strict=False,
    )
    assert result["valid"] is True


# --- Split node --------------------------------------------------------------


def test_split_random_path_regression_unchanged(pipeline_db):
    run = _seed_run(pipeline_db)
    frame = pd.DataFrame(
        {"a": list(range(10)), "b": list(range(10, 20)), "target": [0, 1] * 5}
    )
    config = {
        "train_ratio": 0.7,
        "val_ratio": 0.15,
        "test_ratio": 0.15,
        "random_seed": 42,
    }
    first = pipeline_engine._execute_node(pipeline_db, run, "split", config, {"dataframe": frame})
    second = pipeline_engine._execute_node(pipeline_db, run, "split", config, {"dataframe": frame})
    pd.testing.assert_frame_equal(first["splits"]["train"], second["splits"]["train"])
    assert first["split_config"]["split_strategy"] == "random"
    assert first["split_config"]["time_column"] is None


def test_split_time_path_chronological_and_stable(pipeline_db):
    run = _seed_run(pipeline_db)
    frame = pd.DataFrame(
        {
            "event_time": [
                "2024-01-03",
                "2024-01-01",
                "2024-01-01",
                "2024-01-02",
                "2024-01-05",
                "2024-01-04",
                "2024-01-06",
                "2024-01-07",
                "2024-01-08",
                "2024-01-09",
            ],
            "value": [3, 1, 2, 4, 5, 6, 7, 8, 9, 10],
        }
    )
    out = pipeline_engine._execute_node(
        pipeline_db,
        run,
        "split",
        {
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
            "random_seed": 99,
            "split_strategy": "time",
            "time_column": "event_time",
        },
        {"dataframe": frame},
    )
    train_values = out["splits"]["train"]["value"].tolist()
    # Ascending time; duplicate 2024-01-01 preserves original relative order (1 then 2).
    assert train_values == [1, 2, 4, 3, 6, 5]
    assert out["split_config"]["split_strategy"] == "time"
    assert out["split_config"]["time_column"] == "event_time"
    assert out["splits"]["test"]["value"].tolist()[-1] == 10


def test_split_time_rejects_bad_null_time(pipeline_db):
    run = _seed_run(pipeline_db)
    frame = pd.DataFrame(
        {"event_time": ["2024-01-01", None, "2024-01-03"], "value": [1, 2, 3]}
    )
    with pytest.raises(ValueError, match="null|unparseable|NaN"):
        pipeline_engine._execute_node(
            pipeline_db,
            run,
            "split",
            {
                "train_ratio": 0.5,
                "val_ratio": 0.25,
                "test_ratio": 0.25,
                "split_strategy": "time",
                "time_column": "event_time",
            },
            {"dataframe": frame},
        )


# --- Pipeline forecasting execution -----------------------------------------


def test_pipeline_forecast_training_persists_and_runner_invariant(
    pipeline_db, tmp_path, monkeypatch
):
    pytest.importorskip("mlflow")
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_ALLOW_FILE_STORE", "true")
    from app.core.config import settings

    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())
    monkeypatch.setattr(pipeline_engine, "get_training_runner", lambda: SklearnTrainingRunner())

    run = _seed_run(pipeline_db)
    project_id = run.project_id
    dataset = Dataset(
        project_id=project_id, name="fc", object_key="fc.csv", latest_version=1
    )
    pipeline_db.add(dataset)
    pipeline_db.flush()
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project_id,
        version=1,
        object_key="fc.csv",
        original_filename="fc.csv",
        format="csv",
    )
    pipeline_db.add(version)
    pipeline_db.flush()

    frame = _forecast_frame(36).sample(frac=1, random_state=1).reset_index(drop=True)
    trained = pipeline_engine._execute_node(
        pipeline_db,
        run,
        "training",
        {
            "name": "pipe-fc",
            "training_task": "forecasting",
            "target_column": "sales",
            "problem_type": "regression",
            "algorithm": "ridge",
            "feature_columns": ["sales_lag_1", "sales_roll_avg_3"],
            "split_strategy": "time",
            "time_column": "event_time",
            "forecast_strategy": "direct_multioutput",
            "forecast_horizons": [1, 2, 3],
            "train_ratio": 0.6,
            "val_ratio": 0.2,
            "test_ratio": 0.2,
            "hyperparameters": {"alpha": 1.0},
        },
        {
            "dataframe": frame,
            "dataset_id": dataset.id,
            "dataset_version_id": version.id,
        },
    )
    pipeline_db.commit()
    job = pipeline_db.get(TrainingJob, trained["training_job_id"])
    assert job is not None
    assert job.training_task == "forecasting"
    assert job.forecast_strategy == "direct_multioutput"
    assert json.loads(job.forecast_horizons_json) == [1, 2, 3]
    assert job.split_strategy == "time"
    assert job.time_column == "event_time"
    assert "rmse" in trained["metrics"]

    import mlflow

    client = mlflow.tracking.MlflowClient(tracking_uri=tracking.as_uri())
    run_data = client.get_run(trained["mlflow_run_id"])
    assert json.loads(run_data.data.params["target_columns"]) == forecast_output_names(
        "sales", [1, 2, 3]
    )
    assert run_data.data.tags.get("modelflow.training_task") == "forecasting"


def test_pipeline_forecast_rejects_boolean_target(pipeline_db, monkeypatch):
    class _Boom:
        def run(self, ctx):
            raise AssertionError("runner should not be called")

    monkeypatch.setattr(pipeline_engine, "get_training_runner", lambda: _Boom())
    run = _seed_run(pipeline_db)
    dataset = Dataset(
        project_id=run.project_id, name="bool", object_key="b.csv", latest_version=1
    )
    pipeline_db.add(dataset)
    pipeline_db.flush()
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=run.project_id,
        version=1,
        object_key="b.csv",
        original_filename="b.csv",
        format="csv",
    )
    pipeline_db.add(version)
    pipeline_db.flush()
    frame = pd.DataFrame(
        {
            "event_time": [f"2024-01-{i:02d}" for i in range(1, 21)],
            "flag": [bool(i % 2) for i in range(1, 21)],
            "feat": list(range(1, 21)),
        }
    )
    with pytest.raises(ValueError, match="numeric|boolean"):
        pipeline_engine._execute_node(
            pipeline_db,
            run,
            "training",
            {
                "training_task": "forecasting",
                "target_column": "flag",
                "problem_type": "regression",
                "algorithm": "ridge",
                "feature_columns": ["feat"],
                "split_strategy": "time",
                "time_column": "event_time",
                "forecast_horizons": [1, 2],
            },
            {
                "dataframe": frame,
                "dataset_id": dataset.id,
                "dataset_version_id": version.id,
            },
        )


# --- Feature schema / batch / endpoint --------------------------------------


def test_shared_batch_feature_selection_and_forecast_columns(pipeline_db, monkeypatch):
    project = Project(name="batch-fc")
    pipeline_db.add(project)
    pipeline_db.flush()
    job = TrainingJob(
        project_id=project.id,
        dataset_id=1,
        name="fc",
        target_column="sales",
        target_columns_json='["sales"]',
        problem_type="regression",
        algorithm="ridge",
        feature_columns_json='["sales_lag_1","sales_roll_avg_3"]',
        training_task="forecasting",
        forecast_strategy="direct_multioutput",
        forecast_horizons_json="[1,2,3]",
        status=JobStatus.succeeded,
        model_uri="models:/x/1",
        mlflow_run_id="run-x",
    )
    pipeline_db.add(job)
    pipeline_db.flush()
    model = ModelVersion(
        project_id=project.id,
        name="fc-model",
        version="1",
        mlflow_model_name="fc-model",
        mlflow_version="1",
        model_uri="models:/fc/1",
        training_job_id=job.id,
        lifecycle=ModelLifecycle.APPROVED,
        metadata_json=json.dumps(
            {
                "target_columns": forecast_output_names("sales", [1, 2, 3]),
                "feature_schema": [
                    {"name": "sales_lag_1", "required": True},
                    {"name": "sales_roll_avg_3", "required": True},
                ],
                "multi_output": True,
            }
        ),
    )
    pipeline_db.add(model)
    pipeline_db.flush()

    frame = _forecast_frame(10)
    features = select_batch_feature_frame(
        pipeline_db, frame, model_version=model, training_job=job
    )
    assert list(features.columns) == ["sales_lag_1", "sales_roll_avg_3"]
    assert "event_time" not in features.columns
    assert "sales" not in features.columns
    assert "extra_column" not in features.columns

    with pytest.raises(ValueError, match="missing model features"):
        select_batch_feature_frame(
            pipeline_db,
            frame.drop(columns=["sales_roll_avg_3"]),
            model_version=model,
            training_job=job,
        )

    schema = resolve_feature_schema_payload(
        pipeline_db, model_version=model, training_job=job, incoming=[]
    )
    assert [item["name"] for item in schema] == ["sales_lag_1", "sales_roll_avg_3"]

    class _Model:
        def predict(self, x):
            assert list(x.columns) == ["sales_lag_1", "sales_roll_avg_3"]
            return np.array([[101.0, 102.0, 103.0]] * len(x))

    monkeypatch.setattr(inference, "load_model", lambda uri: _Model())
    OBJECT: dict[tuple[str, str], bytes] = {}
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(
        storage,
        "upload_bytes",
        lambda bucket, key, data, content_type="application/octet-stream": OBJECT.__setitem__(
            (bucket, key), data
        ),
    )

    run = _seed_run(pipeline_db)
    run.project_id = project.id
    pipeline_db.flush()
    dataset = Dataset(
        project_id=project.id, name="ds", object_key="ds.csv", latest_version=1
    )
    pipeline_db.add(dataset)
    pipeline_db.flush()
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project.id,
        version=1,
        object_key="ds.csv",
        original_filename="ds.csv",
        format="csv",
    )
    pipeline_db.add(version)
    pipeline_db.flush()

    result = pipeline_engine._execute_node(
        pipeline_db,
        run,
        "batch_prediction",
        {},
        {
            "dataframe": frame,
            "dataset_version_id": version.id,
            "model_version": model,
        },
    )
    pipeline_db.commit()
    batch = pipeline_db.get(BatchInferenceJob, result["batch_job_id"])
    assert batch is not None
    payload = next(iter(OBJECT.values()))
    out = pd.read_csv(BytesIO(payload))
    assert "prediction_sales__t_plus_1" in out.columns
    assert "prediction_sales__t_plus_2" in out.columns
    assert "prediction_sales__t_plus_3" in out.columns
    assert "event_time" in out.columns
    assert "extra_column" in out.columns


def test_pipeline_endpoint_uses_authoritative_feature_schema(pipeline_db, monkeypatch):
    project = Project(name="ep-fc")
    pipeline_db.add(project)
    pipeline_db.flush()
    job = TrainingJob(
        project_id=project.id,
        dataset_id=1,
        name="fc",
        target_column="sales",
        target_columns_json='["sales"]',
        problem_type="regression",
        algorithm="ridge",
        feature_columns_json='["sales_lag_1","sales_roll_avg_3"]',
        training_task="forecasting",
        forecast_strategy="direct_multioutput",
        forecast_horizons_json="[1,2,3]",
        status=JobStatus.succeeded,
        model_uri="models:/x/1",
        mlflow_run_id="run-x",
    )
    pipeline_db.add(job)
    pipeline_db.flush()
    model = ModelVersion(
        project_id=project.id,
        name="fc-model",
        version="1",
        mlflow_model_name="fc-model",
        mlflow_version="1",
        model_uri="models:/fc/1",
        training_job_id=job.id,
        lifecycle=ModelLifecycle.APPROVED,
        metadata_json=json.dumps(
            {
                "target_columns": forecast_output_names("sales", [1, 2, 3]),
                "feature_schema": [
                    {"name": "sales_lag_1", "required": True},
                    {"name": "sales_roll_avg_3", "required": True},
                ],
            }
        ),
    )
    pipeline_db.add(model)
    pipeline_db.flush()
    monkeypatch.setattr(inference, "load_model", lambda uri: object())
    run = _seed_run(pipeline_db)
    run.project_id = project.id
    pipeline_db.flush()
    out = pipeline_engine._execute_node(
        pipeline_db,
        run,
        "endpoint_deployment",
        {"name": "fc-endpoint"},
        {"model_version": model},
    )
    pipeline_db.commit()
    endpoint = pipeline_db.get(Endpoint, out["endpoint_id"])
    assert endpoint is not None
    schema = json.loads(endpoint.feature_schema_json)
    names = [item["name"] for item in schema]
    assert names == ["sales_lag_1", "sales_roll_avg_3"]
    assert "sales__t_plus_1" not in names


def test_tabular_batch_still_drops_targets_when_no_schema(pipeline_db, monkeypatch):
    project = Project(name="tab-batch")
    pipeline_db.add(project)
    pipeline_db.flush()
    job = TrainingJob(
        project_id=project.id,
        dataset_id=1,
        name="tab",
        target_column="target",
        target_columns_json='["target"]',
        problem_type="classification",
        algorithm="random_forest",
        feature_columns_json="[]",
        status=JobStatus.succeeded,
        model_uri="models:/t/1",
        mlflow_run_id="run-t",
    )
    pipeline_db.add(job)
    pipeline_db.flush()
    model = ModelVersion(
        project_id=project.id,
        name="tab",
        version="1",
        mlflow_model_name="tab",
        mlflow_version="1",
        model_uri="models:/t/1",
        training_job_id=job.id,
        lifecycle=ModelLifecycle.APPROVED,
        metadata_json="{}",
    )
    pipeline_db.add(model)
    pipeline_db.flush()
    frame = pd.DataFrame({"a": [1, 2], "b": [3, 4], "target": [0, 1]})
    features = select_batch_feature_frame(
        pipeline_db, frame, model_version=model, training_job=job
    )
    assert list(features.columns) == ["a", "b"]
