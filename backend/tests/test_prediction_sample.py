from __future__ import annotations

import json

import pandas as pd
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    Base,
    Dataset,
    DatasetVersion,
    Endpoint,
    ModelLifecycle,
    ModelVersion,
    Project,
    TrainingJob,
)
from app.services import inference


@pytest.fixture
def db(tmp_path):
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'prediction-sample.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with Session() as session:
        yield session
    Base.metadata.drop_all(engine)
    engine.dispose()


def _seed_lineage(
    db,
    *,
    feature_schema,
    preview,
    dtypes=None,
    via_training_job: bool = True,
):
    project = Project(name="prediction-sample")
    db.add(project)
    db.flush()
    dataset = Dataset(
        project_id=project.id,
        name="demand",
        object_key="demand.csv",
        latest_version=1,
    )
    db.add(dataset)
    db.flush()
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project.id,
        version=1,
        object_key="demand.csv",
        original_filename="demand.csv",
        format="csv",
        preview_json=json.dumps(preview),
        dtypes_json=json.dumps(dtypes or {}),
        columns_json=json.dumps(list((preview[0] if preview else {}).keys())),
    )
    db.add(version)
    db.flush()
    job = None
    if via_training_job:
        job = TrainingJob(
            project_id=project.id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="train",
            target_column="demand_level",
            feature_columns_json=json.dumps(
                [f if isinstance(f, str) else f["name"] for f in feature_schema]
            ),
        )
        db.add(job)
        db.flush()
    model = ModelVersion(
        project_id=project.id,
        name="demand-model",
        version="1",
        lifecycle=ModelLifecycle.PRODUCTION,
        mlflow_model_name="demand-model",
        mlflow_version="1",
        mlflow_run_id="run-1",
        model_uri="models:/demand-model/1",
        dataset_version_id=None if via_training_job else version.id,
        training_job_id=job.id if job else None,
        gates_passed=True,
        gate_results_json=json.dumps({"passed": True}),
        metadata_json="{}",
    )
    db.add(model)
    db.flush()
    endpoint = Endpoint(
        project_id=project.id,
        name="demand-ep",
        model_name=model.name,
        model_version=model.version,
        model_version_id=model.id,
        model_uri=model.model_uri,
        status="ready",
        feature_schema_json=json.dumps(feature_schema),
    )
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    return endpoint


def test_prediction_sample_uses_preview_feature_subset(db):
    preview = [
        {
            "site_id": "SITE_A",
            "measured_at": "2026-07-01T09:00:00",
            "supply_temp": 72.4,
            "humidity": 55.1,
            "demand_level": "HIGH",
        }
    ]
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp"],
        preview=preview,
        dtypes={
            "site_id": "object",
            "measured_at": "datetime64[ns]",
            "supply_temp": "float64",
            "humidity": "float64",
            "demand_level": "object",
        },
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {
        "site_id": "SITE_A",
        "measured_at": "2026-07-01T09:00:00",
        "supply_temp": 72.4,
    }
    assert "demand_level" not in sample
    assert "humidity" not in sample


def test_prediction_sample_legacy_string_schema(db):
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp"],
        preview=[
            {
                "site_id": "SITE_A",
                "measured_at": "2026-07-01T09:00:00",
                "supply_temp": 72.4,
                "demand_level": "HIGH",
            }
        ],
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample["site_id"] == "SITE_A"
    assert sample["measured_at"] == "2026-07-01T09:00:00"
    assert sample["supply_temp"] == 72.4


def test_prediction_sample_dtype_fallback_without_preview(db):
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp", "is_active"],
        preview=[],
        dtypes={
            "site_id": "object",
            "measured_at": "datetime64[ns]",
            "supply_temp": "float64",
            "is_active": "bool",
        },
        via_training_job=False,
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {
        "site_id": "sample",
        "measured_at": "2026-01-01T00:00:00",
        "supply_temp": 0.0,
        "is_active": False,
    }


def test_prediction_sample_without_lineage_does_not_fail(db):
    project = Project(name="orphan-ep")
    db.add(project)
    db.flush()
    endpoint = Endpoint(
        project_id=project.id,
        name="orphan",
        model_name="m",
        model_version="1",
        model_version_id=None,
        model_uri="models:/m/1",
        status="ready",
        feature_schema_json=json.dumps(
            [
                {"name": "site_id", "dtype": "object"},
                {"name": "supply_temp", "dtype": "float64", "example": 12.5},
            ]
        ),
    )
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {"site_id": "sample", "supply_temp": 12.5}


def test_string_schema_without_dtype_is_not_all_zeros(db):
    project = Project(name="zeros-regression")
    db.add(project)
    db.flush()
    endpoint = Endpoint(
        project_id=project.id,
        name="zeros",
        model_name="m",
        model_version="1",
        model_version_id=None,
        model_uri="models:/m/1",
        status="ready",
        feature_schema_json=json.dumps(["site_id", "measured_at", "supply_temp"]),
    )
    db.add(endpoint)
    db.commit()
    db.refresh(endpoint)
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample == {
        "site_id": "sample",
        "measured_at": "sample",
        "supply_temp": "sample",
    }
    assert sample != {"site_id": 0, "measured_at": 0, "supply_temp": 0}


def test_validate_instances_still_accepts_legacy_string_schema():
    inference.validate_instances(
        [{"site_id": "SITE_A", "supply_temp": 1.0}],
        ["site_id", "supply_temp"],
    )


def _demand_schema():
    from mlflow.types.schema import ColSpec, DataType, Schema

    return Schema(
        [
            ColSpec(DataType.string, "site_id"),
            ColSpec(DataType.string, "measured_at"),
            ColSpec(DataType.double, "supply_temp"),
        ]
    )


class _FakePyFuncModel:
    def __init__(self, schema=None, predictions=None):
        self._schema = schema
        self._predictions = predictions if predictions is not None else [108.09203880467113]
        self.last_frame = None

        class _Metadata:
            @staticmethod
            def get_input_schema():
                return schema

        self.metadata = _Metadata()

    def predict(self, frame):
        self.last_frame = frame
        return list(self._predictions)


def test_normalize_double_accepts_json_int():
    frame = pd.DataFrame(
        [
            {
                "site_id": "SITE-001",
                "measured_at": "2026-05-22 00:00:00",
                "supply_temp": 75,
            }
        ]
    )
    assert frame["supply_temp"].dtype == "int64"
    normalized = inference.normalize_prediction_frame(frame, _demand_schema())
    assert str(normalized["supply_temp"].dtype) == "float64"
    assert normalized["supply_temp"].iloc[0] == 75.0
    assert normalized["site_id"].iloc[0] == "SITE-001"


def test_normalize_double_accepts_float_and_rejects_string():
    ok = inference.normalize_prediction_frame(
        pd.DataFrame([{"site_id": "A", "measured_at": "t", "supply_temp": 75.5}]),
        _demand_schema(),
    )
    assert ok["supply_temp"].dtype == "float64"
    assert ok["supply_temp"].iloc[0] == 75.5

    with pytest.raises(inference.PredictionInputError, match="supply_temp"):
        inference.normalize_prediction_frame(
            pd.DataFrame([{"site_id": "A", "measured_at": "t", "supply_temp": "abc"}]),
            _demand_schema(),
        )


def test_normalize_integer_rejects_fractional():
    from mlflow.types.schema import ColSpec, DataType, Schema

    schema = Schema([ColSpec(DataType.integer, "hour")])
    with pytest.raises(inference.PredictionInputError, match="hour"):
        inference.normalize_prediction_frame(
            pd.DataFrame([{"hour": 12.5}]),
            schema,
        )
    normalized = inference.normalize_prediction_frame(
        pd.DataFrame([{"hour": 12.0}]),
        schema,
    )
    assert str(normalized["hour"].dtype) in {"int32", "Int32"}
    assert int(normalized["hour"].iloc[0]) == 12


def test_normalize_without_schema_is_passthrough():
    frame = pd.DataFrame([{"supply_temp": 75}])
    out = inference.normalize_prediction_frame(frame, None)
    assert out is frame
    assert out["supply_temp"].dtype == "int64"


def test_predict_json_int_double_round_trip(monkeypatch):
    fake = _FakePyFuncModel(schema=_demand_schema())
    monkeypatch.setattr(inference, "load_model", lambda _uri: fake)
    preds = inference.predict(
        "models:/demand/1",
        [
            {
                "site_id": "SITE-001",
                "measured_at": "2026-05-22 00:00:00",
                "supply_temp": 75,
            }
        ],
    )
    assert preds == [108.09203880467113]
    assert fake.last_frame is not None
    assert str(fake.last_frame["supply_temp"].dtype) == "float64"


def test_sample_json_round_trip_then_predict(db, monkeypatch):
    endpoint = _seed_lineage(
        db,
        feature_schema=["site_id", "measured_at", "supply_temp"],
        preview=[
            {
                "site_id": "SITE-001",
                "measured_at": "2026-05-22 00:00:00",
                "supply_temp": 75.0,
                "demand_level": "HIGH",
            }
        ],
        dtypes={
            "site_id": "object",
            "measured_at": "object",
            "supply_temp": "float64",
            "demand_level": "object",
        },
    )
    sample = inference.build_prediction_sample_for_endpoint(db, endpoint)
    assert sample is not None

    def _js_compatible(value):
        """Approximate browser JSON.stringify for whole-number floats (75.0 → 75)."""
        if isinstance(value, dict):
            return {key: _js_compatible(item) for key, item in value.items()}
        if isinstance(value, list):
            return [_js_compatible(item) for item in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    browser_like = json.loads(json.dumps([_js_compatible(sample)]))
    assert browser_like[0]["supply_temp"] == 75
    assert isinstance(browser_like[0]["supply_temp"], int)

    fake = _FakePyFuncModel(schema=_demand_schema())
    monkeypatch.setattr(inference, "load_model", lambda _uri: fake)
    preds = inference.predict(endpoint.model_uri, browser_like)
    assert preds == [108.09203880467113]
    assert str(fake.last_frame["supply_temp"].dtype) == "float64"
