"""Helpers for reproducible dataset split configuration and time-ordered splits."""

from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

SPLIT_STRATEGY_RANDOM = "random"
SPLIT_STRATEGY_TIME = "time"
VALID_SPLIT_STRATEGIES = frozenset({SPLIT_STRATEGY_RANDOM, SPLIT_STRATEGY_TIME})


def normalize_split_strategy(value: str | None) -> str:
    strategy = (value or SPLIT_STRATEGY_RANDOM).strip().lower()
    if strategy not in VALID_SPLIT_STRATEGIES:
        raise ValueError(
            f"Unsupported split_strategy '{value}'. "
            f"Expected one of: {', '.join(sorted(VALID_SPLIT_STRATEGIES))}."
        )
    return strategy


def split_config_signature(
    train_ratio: float,
    val_ratio: float,
    test_ratio: float,
    random_seed: int,
    *,
    split_strategy: str = SPLIT_STRATEGY_RANDOM,
    time_column: str | None = None,
) -> str:
    """Canonical signature for duplicate detection across float ratio inputs.

    Random/default calls (strategy omitted or ``random``, no time column) keep the
    exact pre–Phase-6-A signature string for backward compatibility.
    """
    base = (
        f"{round(float(train_ratio), 6):.6f}:"
        f"{round(float(val_ratio), 6):.6f}:"
        f"{round(float(test_ratio), 6):.6f}:"
        f"{int(random_seed)}"
    )
    strategy = normalize_split_strategy(split_strategy)
    column = (time_column or "").strip()
    if strategy == SPLIT_STRATEGY_RANDOM and not column:
        return base
    # Keep under VARCHAR(120): hash the time column name rather than appending it raw.
    col_hash = hashlib.sha256(column.encode("utf-8")).hexdigest()[:16]
    return f"{base}:{strategy}:{col_hash}"


def content_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def validate_time_column_config(
    time_column: str | None,
    *,
    columns: list[str],
    target_columns: list[str] | None = None,
    feature_columns: list[str] | None = None,
) -> str:
    """Validate time_column as ordering metadata (not a target/feature)."""
    if time_column is None or not str(time_column).strip():
        raise ValueError("time_column is required when split_strategy is 'time'.")
    column = str(time_column).strip()
    if column not in columns:
        raise ValueError(
            f"Time column '{column}' was not found in the dataset. "
            f"Available columns: {', '.join(columns)}"
        )
    targets = list(target_columns or [])
    if column in targets:
        raise ValueError("time_column cannot be a target column.")
    features = list(feature_columns or [])
    if column in features:
        raise ValueError("time_column cannot be a feature column.")
    return column


def resolve_time_sort_key(series: pd.Series) -> pd.Series:
    """Build a deterministic sortable key; fail closed on bad values."""
    if series.isna().any():
        raise ValueError("Time column contains null values.")

    if pd.api.types.is_datetime64_any_dtype(series):
        return series

    if pd.api.types.is_numeric_dtype(series):
        numeric = pd.to_numeric(series, errors="coerce")
        values = numeric.astype(float)
        if values.isna().any() or not np.isfinite(values).all():
            raise ValueError("Time column contains NaN or infinite numeric values.")
        return values

    parsed = pd.to_datetime(series, errors="coerce", utc=True)
    if not parsed.isna().any():
        return parsed

    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().all():
        values = numeric.astype(float)
        if np.isfinite(values).all():
            return values

    raise ValueError("Time column contains unparseable time values.")


def order_frame_by_time(frame: pd.DataFrame, time_column: str) -> pd.DataFrame:
    """Stable ascending chronological order (earliest → latest).

    Only row order changes. Input columns and cell values are preserved exactly;
    no temporary columns are written into the frame (avoids colliding with a
    user column named ``__mf_time_key``).
    """
    if time_column not in frame.columns:
        raise ValueError(f"Time column '{time_column}' was not found in the dataset.")
    key = resolve_time_sort_key(frame[time_column])
    # Positional stable argsort: ignore frame index labels so duplicates cannot
    # rematerialize rows via label-based reindexing.
    aligned = pd.Series(np.asarray(key), index=pd.RangeIndex(len(frame)))
    positions = aligned.sort_values(kind="mergesort", ascending=True).index.to_numpy()
    return frame.iloc[positions].reset_index(drop=True)


def time_partition_boundaries(
    n: int,
    train_ratio: float,
    val_ratio: float,
    test_ratio: float,
) -> tuple[int, int]:
    """Contiguous chronological cuts after sorting; reject empty positive-ratio parts."""
    ratios = (float(train_ratio), float(val_ratio), float(test_ratio))
    if any(value < 0 for value in ratios) or train_ratio <= 0:
        raise ValueError("Split ratios must be non-negative and train_ratio must be positive.")
    if not np.isclose(sum(ratios), 1.0):
        raise ValueError("train_ratio + val_ratio + test_ratio must equal 1.")
    if n < 1:
        raise ValueError("Cannot create a time-ordered split from an empty dataset.")

    train_end = int(n * float(train_ratio))
    val_end = train_end + int(n * float(val_ratio))
    train_count = train_end
    val_count = val_end - train_end
    test_count = n - val_end

    if train_ratio > 0 and train_count < 1:
        raise ValueError("Not enough rows for the requested time-ordered split ratios.")
    if val_ratio > 0 and val_count < 1:
        raise ValueError("Not enough rows for the requested time-ordered split ratios.")
    if test_ratio > 0 and test_count < 1:
        raise ValueError("Not enough rows for the requested time-ordered split ratios.")
    return train_end, val_end


def validate_frame_time_column(frame: pd.DataFrame, time_column: str) -> None:
    """Defense-in-depth: ensure the frame can form a deterministic time order."""
    if time_column not in frame.columns:
        raise ValueError(f"Time column '{time_column}' was not found in the dataset.")
    resolve_time_sort_key(frame[time_column])


def apply_time_ordered_partitions(
    frame: pd.DataFrame,
    *,
    time_column: str,
    train_ratio: float,
    val_ratio: float,
    test_ratio: float,
) -> dict[str, pd.DataFrame]:
    """Order by time and cut contiguous train / validation / test partitions."""
    ordered = order_frame_by_time(frame, time_column)
    train_end, val_end = time_partition_boundaries(
        len(ordered), train_ratio, val_ratio, test_ratio
    )
    return {
        "train": ordered.iloc[:train_end].copy(),
        "validation": ordered.iloc[train_end:val_end].copy(),
        "test": ordered.iloc[val_end:].copy(),
    }


def coerce_split_fields(
    split_strategy: str | None,
    time_column: str | None,
) -> tuple[str, str | None]:
    """Normalize persisted/API split fields for random vs time modes."""
    strategy = normalize_split_strategy(split_strategy)
    if strategy == SPLIT_STRATEGY_RANDOM:
        return strategy, None
    column = (time_column or "").strip() or None
    if column is None:
        raise ValueError("time_column is required when split_strategy is 'time'.")
    return strategy, column


def resolve_time_mode_feature_columns(
    *,
    columns: list[str],
    target_columns: list[str],
    feature_columns: list[str] | None,
    time_column: str,
) -> list[str]:
    """Resolve estimator features for time mode (time_column never a feature)."""
    targets = list(target_columns or [])
    explicit = list(feature_columns or [])
    if explicit:
        validate_time_column_config(
            time_column,
            columns=columns,
            target_columns=targets,
            feature_columns=explicit,
        )
        return explicit
    validate_time_column_config(
        time_column,
        columns=columns,
        target_columns=targets,
        feature_columns=[],
    )
    selected = [
        column
        for column in columns
        if column not in targets and column != time_column
    ]
    if not selected:
        raise ValueError("No usable feature columns were selected.")
    return selected
