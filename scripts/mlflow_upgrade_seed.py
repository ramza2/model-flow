#!/usr/bin/env python3
"""Seed disposable MLflow tracking data for scripts/test-mlflow-upgrade.sh."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import mlflow
import mlflow.pyfunc
from mlflow.tracking import MlflowClient


class _ProbeModel(mlflow.pyfunc.PythonModel):
    def predict(self, context, model_input):  # noqa: ANN001
        return model_input


def main() -> None:
    tracking = os.environ["MLFLOW_TRACKING_URI"]
    out = Path(os.environ["SEED_OUT"])
    mlflow.set_tracking_uri(tracking)
    client = MlflowClient(tracking)

    exp = client.create_experiment("modelflow-upgrade-probe")
    with mlflow.start_run(experiment_id=exp) as run:
        mlflow.log_param("probe", "pre-upgrade")
        mlflow.log_metric("accuracy", 0.91)
        with tempfile.TemporaryDirectory() as tmp:
            artifact = Path(tmp) / "probe.txt"
            artifact.write_text("preserve-me\n", encoding="utf-8")
            mlflow.log_artifact(str(artifact))
            mlflow.pyfunc.log_model(artifact_path="model", python_model=_ProbeModel())
        mv = mlflow.register_model(f"runs:/{run.info.run_id}/model", "modelflow_upgrade_probe_model")

    seed = {
        "experiment_id": exp,
        "run_id": run.info.run_id,
        "model_name": mv.name,
        "model_version": str(mv.version),
        "metric_accuracy": 0.91,
        "param_probe": "pre-upgrade",
        "artifact_name": "probe.txt",
    }
    out.write_text(json.dumps(seed), encoding="utf-8")
    print(json.dumps(seed))


if __name__ == "__main__":
    main()
