from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd

ALGORITHM_ALIASES = {
    "logistic": "logistic_regression",
    "logistic_regression": "logistic_regression",
    "lr": "logistic_regression",
    "random_forest": "random_forest",
    "random_forest_classifier": "random_forest",
    "rf": "random_forest",
    "rf_classifier": "random_forest",
    "gradient_boosting": "gradient_boosting",
    "gradient_boosting_classifier": "gradient_boosting",
    "gb": "gradient_boosting",
    "gb_classifier": "gradient_boosting",
    "ridge": "ridge",
    "ridge_regression": "ridge",
    "random_forest_regressor": "random_forest_regressor",
    "rf_regressor": "random_forest_regressor",
    "gradient_boosting_regressor": "gradient_boosting_regressor",
    "gb_regressor": "gradient_boosting_regressor",
}

CLASSIFICATION_ALGORITHMS = {
    "logistic_regression",
    "random_forest",
    "gradient_boosting",
}
REGRESSION_ALGORITHMS = {
    "ridge",
    "random_forest_regressor",
    "gradient_boosting_regressor",
}

# Hyperparameters accepted by sklearn estimators but ignored at create-time validation
# when passed for split/seed configuration (historical clients).
IGNORED_HYPERPARAMETER_KEYS = {
    "test_size",
    "train_ratio",
    "val_ratio",
    "test_ratio",
    "random_seed",
}


@dataclass(frozen=True)
class HyperparameterSpec:
    name: str
    type: str  # integer | number | boolean | string
    default: Any
    description: str = ""
    minimum: float | int | None = None
    maximum: float | int | None = None
    nullable: bool = False


@dataclass(frozen=True)
class AlgorithmSpec:
    id: str
    display_name: str
    problem_types: tuple[str, ...]
    hyperparameters: tuple[HyperparameterSpec, ...]
    multi_output_strategy: str = "unsupported"  # native | wrapper | unsupported

    @property
    def default_hyperparameters(self) -> dict[str, Any]:
        return {item.name: item.default for item in self.hyperparameters}

    @property
    def supported_parameter_names(self) -> set[str]:
        return {item.name for item in self.hyperparameters}

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "problem_types": list(self.problem_types),
            "multi_output_strategy": self.multi_output_strategy,
            "default_hyperparameters": self.default_hyperparameters,
            "supported_hyperparameters": sorted(self.supported_parameter_names),
            "hyperparameters": [
                {
                    "name": item.name,
                    "type": item.type,
                    "default": item.default,
                    "description": item.description,
                    "minimum": item.minimum,
                    "maximum": item.maximum,
                    "nullable": item.nullable,
                }
                for item in self.hyperparameters
            ],
        }


_TREE_PARAMS = (
    HyperparameterSpec(
        "n_estimators",
        "integer",
        100,
        "Number of trees in the ensemble.",
        minimum=1,
        maximum=5000,
    ),
    HyperparameterSpec(
        "max_depth",
        "integer",
        5,
        "Maximum tree depth. Use null for unlimited depth.",
        minimum=1,
        maximum=100,
        nullable=True,
    ),
)

_GB_PARAMS = (
    HyperparameterSpec(
        "n_estimators",
        "integer",
        100,
        "Number of boosting stages.",
        minimum=1,
        maximum=5000,
    ),
    HyperparameterSpec(
        "learning_rate",
        "number",
        0.1,
        "Shrinks the contribution of each tree.",
        minimum=0.0001,
        maximum=1.0,
    ),
    HyperparameterSpec(
        "max_depth",
        "integer",
        3,
        "Maximum depth of individual regression estimators.",
        minimum=1,
        maximum=100,
    ),
)

ALGORITHM_CATALOG: dict[str, AlgorithmSpec] = {
    "random_forest": AlgorithmSpec(
        id="random_forest",
        display_name="Random forest",
        problem_types=("classification",),
        hyperparameters=_TREE_PARAMS,
    ),
    "logistic_regression": AlgorithmSpec(
        id="logistic_regression",
        display_name="Logistic regression",
        problem_types=("classification",),
        hyperparameters=(
            HyperparameterSpec(
                "C",
                "number",
                1.0,
                "Inverse of regularization strength.",
                minimum=0.0001,
                maximum=1e6,
            ),
            HyperparameterSpec(
                "max_iter",
                "integer",
                1000,
                "Maximum number of iterations for the solver.",
                minimum=1,
                maximum=100000,
            ),
        ),
    ),
    "gradient_boosting": AlgorithmSpec(
        id="gradient_boosting",
        display_name="Gradient boosting",
        problem_types=("classification",),
        hyperparameters=_GB_PARAMS,
    ),
    "ridge": AlgorithmSpec(
        id="ridge",
        display_name="Ridge regression",
        problem_types=("regression",),
        hyperparameters=(
            HyperparameterSpec(
                "alpha",
                "number",
                1.0,
                "Regularization strength; larger values mean stronger regularization.",
                minimum=0.0,
                maximum=1e6,
            ),
        ),
        multi_output_strategy="native",
    ),
    "random_forest_regressor": AlgorithmSpec(
        id="random_forest_regressor",
        display_name="Random forest regressor",
        problem_types=("regression",),
        hyperparameters=_TREE_PARAMS,
        multi_output_strategy="native",
    ),
    "gradient_boosting_regressor": AlgorithmSpec(
        id="gradient_boosting_regressor",
        display_name="Gradient boosting regressor",
        problem_types=("regression",),
        hyperparameters=_GB_PARAMS,
        multi_output_strategy="wrapper",
    ),
}


def list_algorithms(
    problem_type: str | None = None,
) -> list[dict[str, Any]]:
    rows = list(ALGORITHM_CATALOG.values())
    if problem_type and problem_type != "auto":
        rows = [row for row in rows if problem_type in row.problem_types]
    return [row.to_dict() for row in rows]


def get_algorithm(algorithm_id: str) -> AlgorithmSpec | None:
    canonical = canonicalize_algorithm(algorithm_id, raise_on_unknown=False)
    if canonical is None:
        return None
    return ALGORITHM_CATALOG.get(canonical)


def canonicalize_algorithm(
    value: str, *, raise_on_unknown: bool = True
) -> str | None:
    canonical = ALGORITHM_ALIASES.get(str(value or "").lower().strip())
    if canonical is None and raise_on_unknown:
        supported = ", ".join(sorted(ALGORITHM_CATALOG))
        raise ValueError(
            f"Unsupported algorithm '{value}'. Supported algorithms: {supported}"
        )
    return canonical


def detect_problem_type(target: pd.Series) -> str:
    """Infer classification vs regression from a target column series."""
    if (
        pd.api.types.is_bool_dtype(target)
        or pd.api.types.is_string_dtype(target)
        or isinstance(target.dtype, pd.CategoricalDtype)
    ):
        return "classification"
    unique = target.nunique(dropna=True)
    if pd.api.types.is_integer_dtype(target) and unique <= max(
        20, int(len(target) * 0.2)
    ):
        return "classification"
    return "regression"


def normalize_problem_type(value: str, target: pd.Series) -> str:
    value = str(value or "auto").lower().strip()
    if value == "auto":
        return detect_problem_type(target)
    if value not in {"classification", "regression"}:
        raise ValueError("problem_type must be classification, regression, or auto.")
    return value


def is_numeric_regression_target(target: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(target) and not isinstance(
        target.dtype, pd.CategoricalDtype
    )


def normalize_problem_type_for_targets(
    value: str,
    frame: pd.DataFrame,
    target_columns: list[str],
) -> str:
    requested = str(value or "auto").lower().strip()
    if len(target_columns) > 1:
        if requested == "classification":
            raise ValueError("Multi-output classification is not supported.")
        for column in target_columns:
            if column not in frame.columns:
                raise ValueError(f"Target column '{column}' is not in the dataset.")
            series = frame[column]
            if requested == "regression":
                if pd.api.types.is_bool_dtype(series):
                    raise ValueError(
                        f"Target column '{column}' cannot be boolean for regression."
                    )
                if not is_numeric_regression_target(series):
                    raise ValueError(
                        f"Target column '{column}' must be numeric for multi-output regression."
                    )
            elif requested == "auto":
                if detect_problem_type(series) != "regression":
                    raise ValueError("Multi-output classification is not supported.")
            else:
                raise ValueError("problem_type must be regression for multi-output targets.")
        return "regression"
    return normalize_problem_type(value, frame[target_columns[0]])


def wrap_estimator_for_multi_output(estimator: Any, algorithm: str) -> Any:
    from sklearn.multioutput import MultiOutputRegressor

    spec = ALGORITHM_CATALOG.get(algorithm)
    if spec is None or spec.multi_output_strategy == "unsupported":
        raise ValueError(f"Algorithm '{algorithm}' does not support multi-output regression.")
    if spec.multi_output_strategy == "wrapper":
        return MultiOutputRegressor(estimator)
    return estimator


def resolve_algorithm(value: str, problem_type: str) -> str:
    canonical = canonicalize_algorithm(value)
    assert canonical is not None
    spec = ALGORITHM_CATALOG[canonical]
    if problem_type not in spec.problem_types:
        raise ValueError(
            f"{spec.display_name} is not supported for {problem_type}."
        )
    return canonical


def validate_hyperparameters(
    algorithm: str, hyperparameters: dict[str, Any] | None
) -> dict[str, Any]:
    spec = get_algorithm(algorithm)
    if spec is None:
        raise ValueError(f"Unsupported algorithm '{algorithm}'.")
    values = dict(hyperparameters or {})
    unknown = sorted(
        set(values) - spec.supported_parameter_names - IGNORED_HYPERPARAMETER_KEYS
    )
    if unknown:
        raise ValueError(
            f"Unsupported hyperparameters for {spec.id}: {', '.join(unknown)}"
        )
    specs = {item.name: item for item in spec.hyperparameters}
    cleaned: dict[str, Any] = {}
    for key, value in values.items():
        if key in IGNORED_HYPERPARAMETER_KEYS:
            continue
        param = specs[key]
        cleaned[key] = _coerce_hyperparameter(param, value)
    return cleaned


def _coerce_hyperparameter(param: HyperparameterSpec, value: Any) -> Any:
    if value is None:
        if param.nullable:
            return None
        raise ValueError(f"Hyperparameter '{param.name}' cannot be null.")
    if param.type == "integer":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or (
            isinstance(value, float) and not float(value).is_integer()
        ):
            raise ValueError(
                f"Hyperparameter '{param.name}' must be an integer."
            )
        number = int(value)
        if param.minimum is not None and number < param.minimum:
            raise ValueError(
                f"Hyperparameter '{param.name}' must be >= {param.minimum}."
            )
        if param.maximum is not None and number > param.maximum:
            raise ValueError(
                f"Hyperparameter '{param.name}' must be <= {param.maximum}."
            )
        return number
    if param.type == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Hyperparameter '{param.name}' must be a number.")
        number = float(value)
        if param.minimum is not None and number < param.minimum:
            raise ValueError(
                f"Hyperparameter '{param.name}' must be >= {param.minimum}."
            )
        if param.maximum is not None and number > param.maximum:
            raise ValueError(
                f"Hyperparameter '{param.name}' must be <= {param.maximum}."
            )
        return number
    if param.type == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"Hyperparameter '{param.name}' must be a boolean.")
        return value
    if not isinstance(value, str):
        raise ValueError(f"Hyperparameter '{param.name}' must be a string.")
    return value


def default_algorithm_for_problem_type(problem_type: str) -> str:
    if problem_type == "regression":
        return "ridge"
    return "random_forest"
