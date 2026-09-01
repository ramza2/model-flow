"""Serialize sklearn predictions for API and batch outputs."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def _to_scalar(value: Any) -> Any:
    if hasattr(value, "item"):
        try:
            return value.item()
        except ValueError:
            pass
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    return value


def serialize_predictions(
    predictions: Any,
    *,
    target_columns: list[str] | None = None,
) -> list[Any]:
    array = np.asarray(predictions)

    if array.ndim == 0:
        return [_to_scalar(array)]

    if array.ndim == 1:
        if target_columns and len(target_columns) > 1:
            raise ValueError("Multi-output predictions require a 2D array.")
        return [_to_scalar(value) for value in array.tolist()]

    if array.ndim == 2:
        if target_columns:
            if len(target_columns) > 1:
                if len(target_columns) != array.shape[1]:
                    raise ValueError(
                        f"Prediction width {array.shape[1]} does not match "
                        f"{len(target_columns)} target columns."
                    )
                return [
                    {
                        name: _to_scalar(value)
                        for name, value in zip(target_columns, row, strict=True)
                    }
                    for row in array.tolist()
                ]
            if array.shape[1] != 1:
                raise ValueError(
                    f"Single-target predictions must have one column, got {array.shape[1]}."
                )
            return [_to_scalar(value) for value in array[:, 0].tolist()]

        return [[_to_scalar(cell) for cell in row] for row in array.tolist()]

    raise ValueError(f"Unsupported prediction shape: {array.shape}")


def assign_batch_prediction_columns(
    frame: pd.DataFrame,
    serialized: list[Any],
    *,
    target_columns: list[str] | None,
    prediction_column: str = "prediction",
) -> pd.DataFrame:
    """Add prediction columns to a batch result frame with collision checks."""

    result = frame.copy()
    if target_columns and len(target_columns) > 1:
        for name in target_columns:
            column_name = f"prediction_{name}"
            if column_name in result.columns:
                raise ValueError(
                    f"Batch result column '{column_name}' already exists in the input dataset."
                )
            result[column_name] = [row[name] for row in serialized]
        return result

    column_name = prediction_column
    if column_name in result.columns:
        raise ValueError(
            f"Batch result column '{column_name}' already exists in the input dataset."
        )
    result[column_name] = serialized
    return result
