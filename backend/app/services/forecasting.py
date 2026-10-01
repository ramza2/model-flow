"""Phase 6-C direct multi-horizon forecasting helpers.

Critical leakage rule: never build shift(-h) future targets on the full frame
before train/validation/test partitions. Each partition builds its own labels.
"""

from __future__ import annotations

import json
from typing import Any

import pandas as pd

TRAINING_TASK_TABULAR = "tabular"
TRAINING_TASK_FORECASTING = "forecasting"
FORECAST_STRATEGY_DIRECT = "direct_multioutput"
MAX_HORIZON_ENTRIES = 50
MAX_HORIZON_VALUE = 1000
MIN_USABLE_SUPERVISED_ROWS = 2


class ForecastingError(ValueError):
    """User-facing forecasting configuration / construction failure."""


def is_forecasting_task(training_task: str | None) -> bool:
    return (training_task or TRAINING_TASK_TABULAR) == TRAINING_TASK_FORECASTING


def forecast_output_name(target_column: str, horizon: int) -> str:
    return f"{target_column}__t_plus_{horizon}"


def forecast_output_names(target_column: str, horizons: list[int]) -> list[str]:
    return [forecast_output_name(target_column, horizon) for horizon in horizons]


def normalize_forecast_horizons(raw: Any) -> list[int]:
    """Validate and canonicalize horizons to ascending unique positive ints."""
    if raw is None:
        raise ForecastingError("forecast_horizons must be a non-empty list.")
    if not isinstance(raw, list):
        raise ForecastingError("forecast_horizons must be a list of positive integers.")
    if not raw:
        raise ForecastingError("forecast_horizons must be a non-empty list.")
    if len(raw) > MAX_HORIZON_ENTRIES:
        raise ForecastingError(
            f"forecast_horizons accepts at most {MAX_HORIZON_ENTRIES} entries."
        )

    horizons: list[int] = []
    for index, value in enumerate(raw):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ForecastingError(
                f"forecast_horizons[{index}] must be a positive integer."
            )
        if value <= 0:
            raise ForecastingError(
                f"forecast_horizons[{index}] must be a positive integer."
            )
        if value > MAX_HORIZON_VALUE:
            raise ForecastingError(
                f"forecast_horizons[{index}] must be <= {MAX_HORIZON_VALUE}."
            )
        horizons.append(value)

    if len(horizons) != len(set(horizons)):
        raise ForecastingError("forecast_horizons must not contain duplicates.")
    return sorted(horizons)


def dumps_forecast_horizons(horizons: list[int]) -> str:
    return json.dumps(list(horizons))


def loads_forecast_horizons(raw: str | None) -> list[int]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    try:
        return normalize_forecast_horizons(data) if data else []
    except ForecastingError:
        # Persisted rows should already be valid; fall back without raising.
        cleaned: list[int] = []
        for value in data:
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                cleaned.append(value)
        return sorted(set(cleaned))


def coerce_forecast_fields(
    training_task: str | None,
    forecast_strategy: str | None,
    forecast_horizons: Any,
) -> tuple[str, str | None, list[int]]:
    task = (training_task or TRAINING_TASK_TABULAR).strip().lower()
    if task not in {TRAINING_TASK_TABULAR, TRAINING_TASK_FORECASTING}:
        raise ForecastingError(
            "training_task must be 'tabular' or 'forecasting'."
        )
    if task == TRAINING_TASK_TABULAR:
        return TRAINING_TASK_TABULAR, None, []

    strategy = (forecast_strategy or FORECAST_STRATEGY_DIRECT).strip().lower()
    if strategy != FORECAST_STRATEGY_DIRECT:
        raise ForecastingError(
            "forecast_strategy must be 'direct_multioutput' for forecasting jobs."
        )
    horizons = normalize_forecast_horizons(forecast_horizons)
    return TRAINING_TASK_FORECASTING, FORECAST_STRATEGY_DIRECT, horizons


def require_numeric_forecast_target(frame: pd.DataFrame, target_column: str) -> None:
    if target_column not in frame.columns:
        raise ForecastingError(f"Target column '{target_column}' was not found.")
    series = frame[target_column]
    if pd.api.types.is_bool_dtype(series) or str(series.dtype) == "boolean":
        raise ForecastingError(
            f"Forecasting target '{target_column}' must be numeric (boolean is not allowed)."
        )
    if not pd.api.types.is_numeric_dtype(series):
        raise ForecastingError(
            f"Forecasting target '{target_column}' must be numeric."
        )


def min_raw_rows_for_horizons(horizons: list[int]) -> int:
    if not horizons:
        return MIN_USABLE_SUPERVISED_ROWS
    return max(horizons) + MIN_USABLE_SUPERVISED_ROWS


def build_forecast_supervised_partition(
    partition: pd.DataFrame,
    *,
    target_column: str,
    feature_columns: list[str],
    horizons: list[int],
    partition_label: str,
    require_min_rows: bool = True,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Build X/y for one already-chronological partition.

    Labels are created only from values inside this partition. Origins without a
    full future horizon window are dropped.
    """
    if not horizons:
        raise ForecastingError("forecast_horizons must be a non-empty list.")
    if target_column not in partition.columns:
        raise ForecastingError(
            f"Target column '{target_column}' was not found in the {partition_label} partition."
        )
    missing = [column for column in feature_columns if column not in partition.columns]
    if missing:
        raise ForecastingError(
            f"Feature columns missing in the {partition_label} partition: {', '.join(missing)}"
        )

    # Empty positive-ratio partitions are rejected upstream; zero-ratio parts may be empty.
    if partition.empty:
        empty_y = pd.DataFrame(columns=forecast_output_names(target_column, horizons))
        return partition.loc[:, feature_columns].copy(), empty_y

    if require_min_rows and len(partition) < min_raw_rows_for_horizons(horizons):
        raise ForecastingError(
            f"Not enough rows in the {partition_label} partition for forecast horizons "
            f"{horizons}. Need at least {min_raw_rows_for_horizons(horizons)} raw rows "
            f"(max horizon + {MIN_USABLE_SUPERVISED_ROWS}); got {len(partition)}."
        )

    require_numeric_forecast_target(partition, target_column)
    output_names = forecast_output_names(target_column, horizons)
    target_frame = pd.DataFrame(index=partition.index)
    for horizon, output in zip(horizons, output_names, strict=True):
        # Future labels from this partition only — never from later partitions.
        target_frame[output] = partition[target_column].shift(-horizon)

    usable = target_frame.notna().all(axis=1)
    # Also drop origins whose configured features are entirely unusable later in
    # preprocessing; here we only enforce complete future-target coverage.
    x = partition.loc[usable, feature_columns].copy().reset_index(drop=True)
    y = target_frame.loc[usable, output_names].copy().reset_index(drop=True)

    if require_min_rows and len(x) < MIN_USABLE_SUPERVISED_ROWS:
        raise ForecastingError(
            f"Not enough rows in the {partition_label} partition for forecast horizons "
            f"{horizons}. After dropping origins without full future targets, "
            f"need at least {MIN_USABLE_SUPERVISED_ROWS} supervised rows; got {len(x)}."
        )
    return x, y


def assert_no_cross_partition_labels(
    *,
    train_target_values: list[Any],
    forbidden_values: set[Any],
) -> None:
    """Test helper invariant: train labels must not include later-partition values."""
    leaked = [value for value in train_target_values if value in forbidden_values]
    if leaked:
        raise AssertionError(f"Cross-partition forecast label leakage detected: {leaked}")


def build_forecast_metrics_payload(
    *,
    target_column: str,
    horizons: list[int],
    output_names: list[str],
    per_target_metrics: dict[str, dict[str, float]] | None,
) -> dict[str, Any]:
    outputs: dict[str, Any] = {}
    if per_target_metrics:
        for name in output_names:
            if name in per_target_metrics:
                outputs[name] = per_target_metrics[name]
    return {
        "target": target_column,
        "horizons": list(horizons),
        "outputs": outputs,
    }
