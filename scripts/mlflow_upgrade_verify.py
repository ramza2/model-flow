#!/usr/bin/env python3
"""Verify preserved + new MLflow data after db upgrade (test-mlflow-upgrade.sh)."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import mlflow
from mlflow.tracking import MlflowClient


def main() -> None:
    tracking = os.environ["MLFLOW_TRACKING_URI"]
    seed = json.loads(Path(os.environ["SEED_IN"]).read_text(encoding="utf-8"))
    mlflow.set_tracking_uri(tracking)
    client = MlflowClient(tracking)

    exp = client.get_experiment(seed["experiment_id"])
    assert exp is not None and exp.name == "modelflow-upgrade-probe", exp

    run = client.get_run(seed["run_id"])
    assert run.info.run_id == seed["run_id"]
    assert float(run.data.metrics.get("accuracy", -1)) == float(seed["metric_accuracy"])
    assert run.data.params.get("probe") == seed["param_probe"]

    artifacts = {item.path for item in client.list_artifacts(seed["run_id"])}
    assert seed["artifact_name"] in artifacts or any(
        path.endswith(seed["artifact_name"]) for path in artifacts
    ), artifacts
    local = client.download_artifacts(seed["run_id"], seed["artifact_name"])
    assert Path(local).read_text(encoding="utf-8") == "preserve-me\n"

    versions = client.search_model_versions(f"name='{seed['model_name']}'")
    assert any(str(v.version) == str(seed["model_version"]) for v in versions), versions

    # New write after upgrade must succeed without disturbing the seed run.
    with mlflow.start_run(experiment_id=seed["experiment_id"]) as new_run:
        mlflow.log_param("probe", "post-upgrade")
        mlflow.log_metric("accuracy", 0.95)
        with tempfile.TemporaryDirectory() as tmp:
            artifact = Path(tmp) / "post.txt"
            artifact.write_text("after-upgrade\n", encoding="utf-8")
            mlflow.log_artifact(str(artifact))

    recheck = client.get_run(seed["run_id"])
    assert float(recheck.data.metrics.get("accuracy", -1)) == float(seed["metric_accuracy"])
    assert recheck.data.params.get("probe") == seed["param_probe"]

    print(
        json.dumps(
            {
                "preserved_run_id": seed["run_id"],
                "new_run_id": new_run.info.run_id,
                "model_name": seed["model_name"],
                "model_version": seed["model_version"],
            }
        )
    )


if __name__ == "__main__":
    main()
