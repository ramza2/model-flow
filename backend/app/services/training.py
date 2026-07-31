from __future__ import annotations

import json
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Protocol

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import accuracy_score, f1_score, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split

from app.core.config import settings


@dataclass
class TrainingJobContext:
    job_id: int
    project_id: int
    job_name: str
    target_column: str
    algorithm: str
    hyperparameters: dict[str, Any]
    csv_bytes: bytes
    experiment_name: str


@dataclass
class TrainingResult:
    mlflow_run_id: str
    model_uri: str
    metrics: dict[str, float]
    logs: str
    params: dict[str, str]


class TrainingRunner(Protocol):
    def run(self, ctx: TrainingJobContext) -> TrainingResult: ...


class SklearnTrainingRunner:
    """Replaceable training implementation (D-002 / D-005)."""

    def run(self, ctx: TrainingJobContext) -> TrainingResult:
        logs: list[str] = []
        def log(msg: str) -> None:
            logs.append(msg)

        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        mlflow.set_experiment(ctx.experiment_name)

        df = pd.read_csv(BytesIO(ctx.csv_bytes))
        if ctx.target_column not in df.columns:
            raise ValueError(
                f"Target column '{ctx.target_column}' not found. "
                f"Available columns: {list(df.columns)}"
            )

        y = df[ctx.target_column]
        X = df.drop(columns=[ctx.target_column])
        # Keep numeric features only for MVP simplicity
        X = X.select_dtypes(include=[np.number]).copy()
        if X.shape[1] == 0:
            raise ValueError(
                "No numeric feature columns found after dropping the target. "
                "Upload a CSV with numeric predictors."
            )

        # Drop rows with NA in features/target
        mask = X.notna().all(axis=1) & y.notna()
        X, y = X.loc[mask], y.loc[mask]
        if len(X) < 5:
            raise ValueError("Need at least 5 complete rows to train a model.")

        unique = y.nunique()
        is_classification = (
            not pd.api.types.is_float_dtype(y)
            and unique <= max(20, int(len(y) * 0.2))
        )
        task = "classification" if is_classification else "regression"
        log(f"Detected task={task}, rows={len(X)}, features={list(X.columns)}")

        params = {
            "n_estimators": int(ctx.hyperparameters.get("n_estimators", 50)),
            "max_depth": int(ctx.hyperparameters.get("max_depth", 5)),
            "random_state": int(ctx.hyperparameters.get("random_state", 42)),
        }
        test_size = float(ctx.hyperparameters.get("test_size", 0.2))
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=params["random_state"]
        )

        if is_classification:
            model = RandomForestClassifier(**params)
        else:
            model = RandomForestRegressor(**params)

        with mlflow.start_run(run_name=ctx.job_name) as run:
            mlflow.log_params(
                {
                    **{k: str(v) for k, v in params.items()},
                    "algorithm": ctx.algorithm,
                    "task": task,
                    "target_column": ctx.target_column,
                    "job_id": str(ctx.job_id),
                    "project_id": str(ctx.project_id),
                    "features": ",".join(X.columns),
                }
            )
            log("Fitting model...")
            model.fit(X_train, y_train)
            preds = model.predict(X_test)
            metrics: dict[str, float] = {}
            if is_classification:
                metrics["accuracy"] = float(accuracy_score(y_test, preds))
                metrics["f1_weighted"] = float(f1_score(y_test, preds, average="weighted"))
            else:
                metrics["rmse"] = float(mean_squared_error(y_test, preds) ** 0.5)
                metrics["r2"] = float(r2_score(y_test, preds))
            mlflow.log_metrics(metrics)
            mlflow.sklearn.log_model(model, artifact_path="model")
            run_id = run.info.run_id
            model_uri = f"runs:/{run_id}/model"
            log(f"Logged MLflow run {run_id}; metrics={json.dumps(metrics)}")

        return TrainingResult(
            mlflow_run_id=run_id,
            model_uri=model_uri,
            metrics=metrics,
            logs="\n".join(logs),
            params={k: str(v) for k, v in params.items()},
        )


def get_training_runner() -> TrainingRunner:
    return SklearnTrainingRunner()
