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
    normalize_problem_type_for_targets,
    resolve_algorithm as _resolve_algorithm,
    wrap_estimator_for_multi_output,
)
from app.services.target_columns import is_multi_output, output_schema_for_targets

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
    experiment_name: str
    target_columns: list[str] = field(default_factory=list)
    csv_bytes: bytes | None = None
    train_bytes: bytes | None = None
    validation_bytes: bytes | None = None
    test_bytes: bytes | None = None
    problem_type: str = "auto"
    preprocessing: dict[str, Any] = field(default_factory=dict)
    feature_columns: list[str] = field(default_factory=list)
    train_ratio: float = 0.7
    val_ratio: float = 0.15
    test_ratio: float = 0.15
    random_seed: int = 42
    data_format: str = "csv"
    split_id: int | None = None
    dataset_version_id: int | None = None
    retrain_source_job_id: int | None = None
    split_train_hash: str | None = None
    split_validation_hash: str | None = None
    split_test_hash: str | None = None
    train_object_key: str | None = None
    validation_object_key: str | None = None
    test_object_key: str | None = None

    def __post_init__(self) -> None:
        if not self.target_columns:
            self.target_columns = [self.target_column]
        elif self.target_column not in self.target_columns:
            self.target_column = self.target_columns[0]


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


def _estimator(
    algorithm: str,
    hyperparameters: dict[str, Any],
    seed: int,
    *,
    multi_output: bool = False,
) -> Any:
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
    if multi_output:
        return wrap_estimator_for_multi_output(estimator, algorithm)
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
    target: pd.Series | pd.DataFrame,
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
    pd.Series | pd.DataFrame,
    pd.Series | pd.DataFrame,
    pd.Series | pd.DataFrame,
]:
    ratios = (float(train_ratio), float(val_ratio), float(test_ratio))
    if any(value < 0 for value in ratios) or train_ratio <= 0:
        raise ValueError("Split ratios must be non-negative and train_ratio must be positive.")
    if not np.isclose(sum(ratios), 1.0):
        raise ValueError("train_ratio + val_ratio + test_ratio must equal 1.")
    if len(features) < 5:
        raise ValueError("Need at least 5 rows with a non-null target to train a model.")

    multi_output = isinstance(target, pd.DataFrame)
    if classification and not multi_output:
        stratify = target if target.value_counts().min() >= 2 else None
    else:
        stratify = None
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
        empty_x = features.iloc[0:0]
        if isinstance(target, pd.DataFrame):
            empty_y: pd.Series | pd.DataFrame = target.iloc[0:0]
        else:
            empty_y = target.iloc[0:0]
        return x_train, empty_x, x_temp, y_train, empty_y, y_temp
    if test_ratio == 0:
        empty_x = features.iloc[0:0]
        if isinstance(target, pd.DataFrame):
            empty_y = target.iloc[0:0]
        else:
            empty_y = target.iloc[0:0]
        return x_train, x_temp, empty_x, y_train, y_temp, empty_y

    test_fraction = test_ratio / (val_ratio + test_ratio)
    if classification and not isinstance(y_temp, pd.DataFrame) and y_temp.value_counts().min() >= 2:
        temp_stratify = y_temp
    else:
        temp_stratify = None
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


def _compute_regression_metrics(
    target: pd.Series | pd.DataFrame,
    predictions: np.ndarray,
    *,
    target_names: list[str],
    prefix: str = "",
) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    if isinstance(target, pd.Series):
        base = _metrics("regression", target, predictions)
        return {f"{prefix}{key}": value for key, value in base.items()}, {
            target_names[0]: base
        }

    pred_array = np.asarray(predictions)
    per_target: dict[str, dict[str, float]] = {}
    flat: dict[str, float] = {}
    agg_rmse: list[float] = []
    agg_mae: list[float] = []
    agg_r2: list[float] = []
    for index, name in enumerate(target_names):
        values = _metrics("regression", target[name], pred_array[:, index])
        per_target[name] = values
        agg_rmse.append(values["rmse"])
        agg_mae.append(values["mae"])
        agg_r2.append(values["r2"])
        for metric_name, metric_value in values.items():
            flat[f"{prefix}target_{index}_{metric_name}"] = metric_value
    flat[f"{prefix}rmse"] = float(np.mean(agg_rmse))
    flat[f"{prefix}mae"] = float(np.mean(agg_mae))
    flat[f"{prefix}r2"] = float(np.mean(agg_r2))
    return flat, per_target


def _evaluate_metrics(
    problem_type: str,
    target: pd.Series | pd.DataFrame,
    predictions: np.ndarray,
    *,
    target_names: list[str],
    prefix: str = "",
) -> tuple[dict[str, float], dict[str, dict[str, float]] | None]:
    if problem_type == "classification":
        values = _metrics(problem_type, target, predictions)  # type: ignore[arg-type]
        return {f"{prefix}{key}": value for key, value in values.items()}, None
    return _compute_regression_metrics(
        target,
        predictions,
        target_names=target_names,
        prefix=prefix,
    )


def _schema(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return [
        {
            "name": str(column),
            "dtype": str(frame[column].dtype),
            "required": True,
        }
        for column in frame.columns
    ]


def _select_feature_columns(
    frame: pd.DataFrame,
    target_columns: list[str],
    feature_columns: list[str],
    preprocessing: dict[str, Any],
) -> list[str]:
    selected = (
        feature_columns
        or list(preprocessing.get("feature_columns", []))
        or [str(column) for column in frame.columns if column not in target_columns]
    )
    overlap = [column for column in target_columns if column in selected]
    if overlap:
        raise ValueError("Target columns cannot also be feature columns.")
    missing = [column for column in selected if column not in frame.columns]
    if missing:
        raise ValueError(f"Feature columns were not found: {missing}")
    if not selected:
        raise ValueError("Select at least one feature column.")
    return selected


def _partition_frame(
    frame: pd.DataFrame,
    *,
    target_columns: list[str],
    feature_columns: list[str],
    preprocessing: dict[str, Any],
) -> tuple[pd.DataFrame, pd.Series | pd.DataFrame, list[str]]:
    missing_targets = [column for column in target_columns if column not in frame.columns]
    if missing_targets:
        raise ValueError(
            f"Target column(s) not found: {missing_targets}. "
            f"Available columns: {list(frame.columns)}"
        )
    if len(target_columns) == 1:
        target = frame[target_columns[0]]
        valid = target.notna()
        frame = frame.loc[valid]
        target = target.loc[valid]
    else:
        targets = frame[target_columns]
        valid = targets.notna().all(axis=1)
        frame = frame.loc[valid]
        target = targets.loc[valid]
    selected = _select_feature_columns(frame, target_columns, feature_columns, preprocessing)
    return frame[selected].copy(), target, selected


class SklearnTrainingRunner:
    """Local sklearn runner with raw-feature preprocessing embedded in the model."""

    def run(self, ctx: TrainingJobContext) -> TrainingResult:
        logs: list[str] = []

        def log(message: str) -> None:
            logs.append(message)

        target_columns = list(ctx.target_columns or [ctx.target_column])
        multi_output = is_multi_output(target_columns)

        using_saved_split = ctx.split_id is not None or ctx.train_bytes is not None
        if using_saved_split:
            if ctx.train_bytes is None or ctx.validation_bytes is None or ctx.test_bytes is None:
                raise ValueError(
                    "Saved split requires train, validation, and test artifacts."
                )
            if not ctx.train_bytes or not ctx.validation_bytes or not ctx.test_bytes:
                raise ValueError("Saved split artifact is empty.")
            train_frame = _read_frame(ctx.train_bytes, ctx.data_format)
            val_frame = _read_frame(ctx.validation_bytes, ctx.data_format)
            test_frame = _read_frame(ctx.test_bytes, ctx.data_format)
            for label, frame in (
                ("train", train_frame),
                ("validation", val_frame),
                ("test", test_frame),
            ):
                if frame.empty:
                    raise ValueError(f"Saved {label} split artifact has no rows.")

            x_train, y_train, selected = _partition_frame(
                train_frame,
                target_columns=target_columns,
                feature_columns=ctx.feature_columns,
                preprocessing=ctx.preprocessing,
            )
            x_val, y_val, _ = _partition_frame(
                val_frame,
                target_columns=target_columns,
                feature_columns=ctx.feature_columns,
                preprocessing=ctx.preprocessing,
            )
            x_test, y_test, _ = _partition_frame(
                test_frame,
                target_columns=target_columns,
                feature_columns=ctx.feature_columns,
                preprocessing=ctx.preprocessing,
            )
            if len(x_train) < 1:
                raise ValueError("Saved train split has no usable rows after removing null targets.")
            if multi_output:
                problem_type = normalize_problem_type_for_targets(
                    ctx.problem_type,
                    train_frame,
                    target_columns,
                )
            else:
                problem_type = _normalise_problem_type(ctx.problem_type, y_train)  # type: ignore[arg-type]
            algorithm = _algorithm(ctx.algorithm, problem_type)
            features_for_schema = x_train
            log(
                f"Using saved dataset split #{ctx.split_id} "
                f"(artifacts, no runtime re-split)"
            )
        else:
            if ctx.csv_bytes is None:
                raise ValueError("Training data is missing.")
            full_frame = _read_frame(ctx.csv_bytes, ctx.data_format)
            if multi_output:
                problem_type = normalize_problem_type_for_targets(
                    ctx.problem_type,
                    full_frame,
                    target_columns,
                )
            features, target, selected = _partition_frame(
                full_frame,
                target_columns=target_columns,
                feature_columns=ctx.feature_columns,
                preprocessing=ctx.preprocessing,
            )
            if not multi_output:
                problem_type = _normalise_problem_type(ctx.problem_type, target)  # type: ignore[arg-type]
            algorithm = _algorithm(ctx.algorithm, problem_type)
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
            features_for_schema = features

        estimator = _estimator(
            algorithm,
            ctx.hyperparameters,
            ctx.random_seed,
            multi_output=multi_output,
        )
        model = Pipeline(
            [
                ("preprocessing", _preprocessor(features_for_schema, ctx.preprocessing)),
                ("estimator", estimator),
            ]
        )
        log(
            f"task={problem_type}, algorithm={algorithm}, "
            f"features={selected}, split={len(x_train)}/{len(x_val)}/{len(x_test)}"
        )

        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        mlflow.set_experiment(ctx.experiment_name)
        logged_params: dict[str, Any] = {
            **ctx.hyperparameters,
            "algorithm": algorithm,
            "problem_type": problem_type,
            "target_column": ctx.target_column,
            "target_columns": json.dumps(target_columns),
            "output_count": len(target_columns),
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
        if ctx.dataset_version_id is not None:
            logged_params["dataset_version_id"] = ctx.dataset_version_id
        if ctx.retrain_source_job_id is not None:
            logged_params["retrain_source_job_id"] = ctx.retrain_source_job_id
        if ctx.split_id is not None:
            logged_params["split_id"] = ctx.split_id
            logged_params["split_train_ratio"] = ctx.train_ratio
            logged_params["split_validation_ratio"] = ctx.val_ratio
            logged_params["split_test_ratio"] = ctx.test_ratio
            logged_params["split_random_seed"] = ctx.random_seed
            if ctx.split_train_hash:
                logged_params["split_train_hash"] = ctx.split_train_hash
            if ctx.split_validation_hash:
                logged_params["split_validation_hash"] = ctx.split_validation_hash
            if ctx.split_test_hash:
                logged_params["split_test_hash"] = ctx.split_test_hash
            if ctx.train_object_key:
                logged_params["split_train_object_key"] = ctx.train_object_key
            if ctx.validation_object_key:
                logged_params["split_validation_object_key"] = ctx.validation_object_key
            if ctx.test_object_key:
                logged_params["split_test_object_key"] = ctx.test_object_key

        with mlflow.start_run(run_name=ctx.job_name) as run:
            mlflow.log_params({key: str(value) for key, value in logged_params.items()})
            tags = {
                "modelflow.git_sha": settings.git_sha,
                "modelflow.problem_type": problem_type,
                "modelflow.algorithm": algorithm,
                "modelflow.multi_output": str(multi_output).lower(),
                "modelflow.output_count": str(len(target_columns)),
            }
            if ctx.retrain_source_job_id is not None:
                tags["modelflow.retrain_source_job_id"] = str(ctx.retrain_source_job_id)
            if ctx.split_id is not None:
                tags["modelflow.split_id"] = str(ctx.split_id)
                tags["modelflow.split_source"] = "saved"
            else:
                tags["modelflow.split_source"] = "runtime"
            mlflow.set_tags(tags)
            log("Fitting preprocessing pipeline and estimator...")
            model.fit(x_train, y_train)

            metric_values: dict[str, float] = {}
            target_metrics_payload: dict[str, Any] = {"targets": target_columns}
            evaluation_sets = [
                ("val", x_val, y_val),
                ("test", x_test, y_test),
            ]
            primary_predictions: np.ndarray | None = None
            primary_target: pd.Series | pd.DataFrame | None = None
            for prefix, split_features, split_target in evaluation_sets:
                if split_features.empty:
                    continue
                predictions = model.predict(split_features)
                values, per_target = _evaluate_metrics(
                    problem_type,
                    split_target,
                    predictions,
                    target_names=target_columns,
                    prefix=f"{prefix}_",
                )
                metric_values.update(values)
                if per_target is not None:
                    split_name = "validation" if prefix == "val" else "test"
                    target_metrics_payload[split_name] = per_target
                if prefix == "test" or primary_predictions is None:
                    primary_predictions = predictions
                    primary_target = split_target
                if prefix == "test":
                    if problem_type == "classification":
                        for key, value in values.items():
                            if key.startswith("test_"):
                                metric_values[key.removeprefix("test_")] = value
                    else:
                        for key in ("rmse", "mae", "r2"):
                            prefixed = f"test_{key}"
                            if prefixed in values:
                                metric_values[key] = values[prefixed]

            mlflow.log_metrics(metric_values)
            feature_schema = _schema(features_for_schema)
            output_schema = output_schema_for_targets(
                target_columns,
                {name: str(dtype) for name, dtype in (
                    y_train.dtypes.items() if isinstance(y_train, pd.DataFrame) else [(target_columns[0], y_train.dtype)]
                )},
            )
            mlflow.log_dict(feature_schema, "feature_schema.json")
            if multi_output:
                mlflow.log_dict(target_metrics_payload, "target_metrics.json")
            metadata: dict[str, Any] = {
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
                "target_columns": target_columns,
                "multi_output": multi_output,
                "output_schema": output_schema,
            }
            if ctx.split_id is not None:
                metadata["split"] = {
                    "split_id": ctx.split_id,
                    "dataset_version_id": ctx.dataset_version_id,
                    "train_ratio": ctx.train_ratio,
                    "validation_ratio": ctx.val_ratio,
                    "test_ratio": ctx.test_ratio,
                    "random_seed": ctx.random_seed,
                    "hashes": {
                        "train": ctx.split_train_hash,
                        "validation": ctx.split_validation_hash,
                        "test": ctx.split_test_hash,
                    },
                    "object_keys": {
                        "train": ctx.train_object_key,
                        "validation": ctx.validation_object_key,
                        "test": ctx.test_object_key,
                    },
                }
            mlflow.log_dict(metadata, "training_metadata.json")
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
