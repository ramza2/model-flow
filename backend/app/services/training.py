from __future__ import annotations

import json
import platform
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any, Protocol

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
import sklearn
from mlflow.models import infer_signature
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import (
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from app.core.config import settings
from app.services.algorithm_catalog import (
    ALGORITHM_ALIASES,
    CLASSIFICATION_ALGORITHMS,
    REGRESSION_ALGORITHMS,
    normalize_problem_type as _normalise_problem_type,
    resolve_algorithm as _resolve_algorithm,
)

# Re-export catalog constants for callers that historically imported them here.
__all__ = (
    "ALGORITHM_ALIASES",
    "CLASSIFICATION_ALGORITHMS",
    "REGRESSION_ALGORITHMS",
    "SklearnTrainingRunner",
    "TrainingJobContext",
    "TrainingResult",
    "TrainingRunner",
)


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
    problem_type: str = "auto"
    preprocessing: dict[str, Any] = field(default_factory=dict)
    feature_columns: list[str] = field(default_factory=list)
    train_ratio: float = 0.7
    val_ratio: float = 0.15
    test_ratio: float = 0.15
    random_seed: int = 42
    data_format: str = "csv"


@dataclass
class TrainingResult:
    mlflow_run_id: str
    model_uri: str
    metrics: dict[str, float]
    logs: str
    params: dict[str, str]


class TrainingRunner(Protocol):
    def run(self, ctx: TrainingJobContext) -> TrainingResult: ...


def _read_frame(data: bytes, data_format: str) -> pd.DataFrame:
    stream = BytesIO(data)
    fmt = data_format.lower()
    if fmt == "csv":
        return pd.read_csv(stream)
    if fmt == "parquet":
        return pd.read_parquet(stream)
    if fmt in {"json", "jsonl", "ndjson"}:
        try:
            return pd.read_json(stream)
        except ValueError:
            stream.seek(0)
            return pd.read_json(stream, lines=True)
    raise ValueError(f"Unsupported training data format: {data_format}")


def _algorithm(value: str, problem_type: str) -> str:
    return _resolve_algorithm(value, problem_type)


def _filtered_params(estimator: Any, values: dict[str, Any]) -> dict[str, Any]:
    accepted = estimator.get_params(deep=False)
    ignored = {
        "test_size",
        "train_ratio",
        "val_ratio",
        "test_ratio",
        "random_seed",
    }
    unknown = sorted(set(values) - set(accepted) - ignored)
    if unknown:
        raise ValueError(
            f"Unsupported hyperparameters for this algorithm: {', '.join(unknown)}"
        )
    return {key: value for key, value in values.items() if key in accepted}


def _estimator(algorithm: str, hyperparameters: dict[str, Any], seed: int) -> Any:
    if algorithm == "logistic_regression":
        estimator = LogisticRegression(max_iter=1000, random_state=seed)
    elif algorithm == "random_forest":
        estimator = RandomForestClassifier(n_estimators=100, random_state=seed)
    elif algorithm == "gradient_boosting":
        estimator = GradientBoostingClassifier(random_state=seed)
    elif algorithm == "ridge":
        estimator = Ridge()
    elif algorithm == "random_forest_regressor":
        estimator = RandomForestRegressor(n_estimators=100, random_state=seed)
    else:
        estimator = GradientBoostingRegressor(random_state=seed)
    estimator.set_params(**_filtered_params(estimator, hyperparameters))
    return estimator


def _imputer_config(value: Any, default: str) -> tuple[str, Any | None]:
    if isinstance(value, dict):
        return str(value.get("strategy", default)), value.get("fill_value")
    if isinstance(value, str):
        return value, None
    return default, None


def _preprocessor(frame: pd.DataFrame, config: dict[str, Any]) -> ColumnTransformer:
    numeric = frame.select_dtypes(include=[np.number]).columns.tolist()
    categorical = [column for column in frame.columns if column not in numeric]
    transformers: list[tuple[str, Pipeline, list[str]]] = []

    if numeric:
        strategy, fill_value = _imputer_config(
            config.get("numeric_impute", config.get("numeric_imputer")),
            "median",
        )
        numeric_steps: list[tuple[str, Any]] = [
            (
                "imputer",
                SimpleImputer(strategy=strategy, fill_value=fill_value),
            )
        ]
        scaling = config.get("scaling", config.get("scale_numeric", False))
        if scaling not in {False, None, "none", "None"}:
            numeric_steps.append(("scaler", StandardScaler()))
        transformers.append(("numeric", Pipeline(numeric_steps), numeric))

    if categorical:
        strategy, fill_value = _imputer_config(
            config.get("categorical_impute", config.get("categorical_imputer")),
            "most_frequent",
        )
        if strategy == "constant" and fill_value is None:
            fill_value = "<MISSING>"
        categorical_steps: list[tuple[str, Any]] = [
            (
                "imputer",
                SimpleImputer(strategy=strategy, fill_value=fill_value),
            )
        ]
        if config.get("onehot", config.get("one_hot", True)):
            categorical_steps.append(
                (
                    "onehot",
                    OneHotEncoder(handle_unknown="ignore", sparse_output=False),
                )
            )
        transformers.append(("categorical", Pipeline(categorical_steps), categorical))

    if not transformers:
        raise ValueError("No usable feature columns were selected.")
    return ColumnTransformer(transformers=transformers, remainder="drop")


def _split(
    features: pd.DataFrame,
    target: pd.Series,
    *,
    train_ratio: float,
    val_ratio: float,
    test_ratio: float,
    seed: int,
    classification: bool,
) -> tuple[
    pd.DataFrame,
    pd.DataFrame,
    pd.DataFrame,
    pd.Series,
    pd.Series,
    pd.Series,
]:
    ratios = (float(train_ratio), float(val_ratio), float(test_ratio))
    if any(value < 0 for value in ratios) or train_ratio <= 0:
        raise ValueError("Split ratios must be non-negative and train_ratio must be positive.")
    if not np.isclose(sum(ratios), 1.0):
        raise ValueError("train_ratio + val_ratio + test_ratio must equal 1.")
    if len(features) < 5:
        raise ValueError("Need at least 5 rows with a non-null target to train a model.")

    stratify = target if classification and target.value_counts().min() >= 2 else None
    try:
        x_train, x_temp, y_train, y_temp = train_test_split(
            features,
            target,
            train_size=train_ratio,
            random_state=seed,
            stratify=stratify,
        )
    except ValueError:
        x_train, x_temp, y_train, y_temp = train_test_split(
            features,
            target,
            train_size=train_ratio,
            random_state=seed,
        )

    if val_ratio == 0:
        empty_x, empty_y = features.iloc[0:0], target.iloc[0:0]
        return x_train, empty_x, x_temp, y_train, empty_y, y_temp
    if test_ratio == 0:
        empty_x, empty_y = features.iloc[0:0], target.iloc[0:0]
        return x_train, x_temp, empty_x, y_train, y_temp, empty_y

    test_fraction = test_ratio / (val_ratio + test_ratio)
    temp_stratify = y_temp if classification and y_temp.value_counts().min() >= 2 else None
    try:
        x_val, x_test, y_val, y_test = train_test_split(
            x_temp,
            y_temp,
            test_size=test_fraction,
            random_state=seed,
            stratify=temp_stratify,
        )
    except ValueError:
        x_val, x_test, y_val, y_test = train_test_split(
            x_temp,
            y_temp,
            test_size=test_fraction,
            random_state=seed,
        )
    return x_train, x_val, x_test, y_train, y_val, y_test


def _metrics(problem_type: str, target: pd.Series, predictions: np.ndarray) -> dict[str, float]:
    if problem_type == "classification":
        return {
            "accuracy": float(accuracy_score(target, predictions)),
            "f1_weighted": float(f1_score(target, predictions, average="weighted")),
            "precision_weighted": float(
                precision_score(target, predictions, average="weighted", zero_division=0)
            ),
            "recall_weighted": float(
                recall_score(target, predictions, average="weighted", zero_division=0)
            ),
        }
    return {
        "rmse": float(mean_squared_error(target, predictions) ** 0.5),
        "mae": float(mean_absolute_error(target, predictions)),
        "r2": float(r2_score(target, predictions)),
    }


def _schema(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return [
        {
            "name": str(column),
            "dtype": str(frame[column].dtype),
            "required": True,
        }
        for column in frame.columns
    ]


class SklearnTrainingRunner:
    """Local sklearn runner with raw-feature preprocessing embedded in the model."""

    def run(self, ctx: TrainingJobContext) -> TrainingResult:
        logs: list[str] = []

        def log(message: str) -> None:
            logs.append(message)

        frame = _read_frame(ctx.csv_bytes, ctx.data_format)
        if ctx.target_column not in frame.columns:
            raise ValueError(
                f"Target column '{ctx.target_column}' not found. "
                f"Available columns: {list(frame.columns)}"
            )
        target = frame[ctx.target_column]
        valid_target = target.notna()
        frame, target = frame.loc[valid_target], target.loc[valid_target]
        problem_type = _normalise_problem_type(ctx.problem_type, target)
        algorithm = _algorithm(ctx.algorithm, problem_type)

        selected = (
            ctx.feature_columns
            or list(ctx.preprocessing.get("feature_columns", []))
            or [str(column) for column in frame.columns if column != ctx.target_column]
        )
        if ctx.target_column in selected:
            raise ValueError("The target column cannot also be a feature column.")
        missing = [column for column in selected if column not in frame.columns]
        if missing:
            raise ValueError(f"Feature columns were not found: {missing}")
        if not selected:
            raise ValueError("Select at least one feature column.")
        features = frame[selected].copy()

        splits = _split(
            features,
            target,
            train_ratio=ctx.train_ratio,
            val_ratio=ctx.val_ratio,
            test_ratio=ctx.test_ratio,
            seed=ctx.random_seed,
            classification=problem_type == "classification",
        )
        x_train, x_val, x_test, y_train, y_val, y_test = splits
        estimator = _estimator(algorithm, ctx.hyperparameters, ctx.random_seed)
        model = Pipeline(
            [
                ("preprocessing", _preprocessor(features, ctx.preprocessing)),
                ("estimator", estimator),
            ]
        )
        log(
            f"task={problem_type}, algorithm={algorithm}, rows={len(features)}, "
            f"features={selected}, split={len(x_train)}/{len(x_val)}/{len(x_test)}"
        )

        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        mlflow.set_experiment(ctx.experiment_name)
        logged_params: dict[str, Any] = {
            **ctx.hyperparameters,
            "algorithm": algorithm,
            "problem_type": problem_type,
            "target_column": ctx.target_column,
            "job_id": ctx.job_id,
            "project_id": ctx.project_id,
            "features": ",".join(selected),
            "train_ratio": ctx.train_ratio,
            "val_ratio": ctx.val_ratio,
            "test_ratio": ctx.test_ratio,
            "random_seed": ctx.random_seed,
            "git_sha": settings.git_sha,
            "python_version": platform.python_version(),
            "sklearn_version": sklearn.__version__,
            "pandas_version": pd.__version__,
            "numpy_version": np.__version__,
            "mlflow_version": mlflow.__version__,
        }

        with mlflow.start_run(run_name=ctx.job_name) as run:
            mlflow.log_params({key: str(value) for key, value in logged_params.items()})
            mlflow.set_tags(
                {
                    "modelflow.git_sha": settings.git_sha,
                    "modelflow.problem_type": problem_type,
                    "modelflow.algorithm": algorithm,
                }
            )
            log("Fitting preprocessing pipeline and estimator...")
            model.fit(x_train, y_train)

            metric_values: dict[str, float] = {}
            evaluation_sets = [
                ("val", x_val, y_val),
                ("test", x_test, y_test),
            ]
            primary_predictions: np.ndarray | None = None
            primary_target: pd.Series | None = None
            for prefix, split_features, split_target in evaluation_sets:
                if split_features.empty:
                    continue
                predictions = model.predict(split_features)
                values = _metrics(problem_type, split_target, predictions)
                metric_values.update({f"{prefix}_{key}": value for key, value in values.items()})
                if prefix == "test" or primary_predictions is None:
                    primary_predictions = predictions
                    primary_target = split_target
                    metric_values.update(values)

            mlflow.log_metrics(metric_values)
            feature_schema = _schema(features)
            mlflow.log_dict(feature_schema, "feature_schema.json")
            mlflow.log_dict(
                {
                    "git_sha": settings.git_sha,
                    "libraries": {
                        "python": platform.python_version(),
                        "scikit-learn": sklearn.__version__,
                        "pandas": pd.__version__,
                        "numpy": np.__version__,
                        "mlflow": mlflow.__version__,
                    },
                    "preprocessing": ctx.preprocessing,
                    "feature_schema": feature_schema,
                },
                "training_metadata.json",
            )
            if problem_type == "classification" and primary_predictions is not None:
                labels = sorted(
                    set(primary_target.tolist()) | set(primary_predictions.tolist()),
                    key=str,
                )
                matrix = confusion_matrix(
                    primary_target,
                    primary_predictions,
                    labels=labels,
                )
                mlflow.log_dict(
                    {
                        "labels": [
                            label.item() if hasattr(label, "item") else label for label in labels
                        ],
                        "matrix": matrix.tolist(),
                    },
                    "confusion_matrix.json",
                )

            input_example = x_train.head(min(5, len(x_train)))
            output_example = model.predict(input_example)
            signature = infer_signature(input_example, output_example)
            mlflow.sklearn.log_model(
                model,
                artifact_path="model",
                signature=signature,
                input_example=input_example,
                serialization_format=mlflow.sklearn.SERIALIZATION_FORMAT_CLOUDPICKLE,
            )
            run_id = run.info.run_id
            model_uri = f"runs:/{run_id}/model"
            log(f"Logged MLflow run {run_id}; metrics={json.dumps(metric_values)}")

        return TrainingResult(
            mlflow_run_id=run_id,
            model_uri=model_uri,
            metrics=metric_values,
            logs="\n".join(logs),
            params={key: str(value) for key, value in logged_params.items()},
        )


def get_training_runner() -> TrainingRunner:
    return SklearnTrainingRunner()
