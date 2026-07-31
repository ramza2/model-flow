import pytest

from app.services.training import SklearnTrainingRunner, TrainingJobContext


def test_sklearn_runner_trains(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    from sklearn.datasets import load_iris

    # Use local file store for unit test
    tracking = tmp_path / "mlruns"
    tracking.mkdir()
    monkeypatch.setenv("MLFLOW_TRACKING_URI", tracking.as_uri())
    from app.core.config import settings

    monkeypatch.setattr(settings, "mlflow_tracking_uri", tracking.as_uri())

    df = load_iris(as_frame=True).frame
    csv_bytes = df.to_csv(index=False).encode()
    runner = SklearnTrainingRunner()
    result = runner.run(
        TrainingJobContext(
            job_id=1,
            project_id=1,
            job_name="unit-train",
            target_column="target",
            algorithm="random_forest",
            hyperparameters={"n_estimators": 10, "max_depth": 3},
            csv_bytes=csv_bytes,
            experiment_name="unit-exp",
        )
    )
    assert result.mlflow_run_id
    assert "accuracy" in result.metrics
    assert result.model_uri.startswith("runs:/")
