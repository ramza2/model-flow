"""Serialize sklearn predictions for API and batch outputs."""

from __future__ import annotations

from typing import Any

import numpy as np


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
        if not target_columns:
            return [[_to_scalar(cell) for cell in row] for row in array.tolist()]
        if len(target_columns) != array.shape[1]:
            target_columns = [
                target_columns[index] if index < len(target_columns) else f"target_{index}"
                for index in range(array.shape[1])
            ]
        return [
            {name: _to_scalar(value) for name, value in zip(target_columns, row, strict=False)}
            for row in array.tolist()
        ]

    raise ValueError(f"Unsupported prediction shape: {array.shape}")
