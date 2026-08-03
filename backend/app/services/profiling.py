from __future__ import annotations

import json
from typing import Any

import numpy as np
import pandas as pd


def _scalar(value: Any) -> Any:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (pd.Timestamp, pd.Timedelta)):
        return value.isoformat()
    return value


def profile_dataframe(df: pd.DataFrame) -> dict[str, Any]:
    """Return a JSON-serializable profile and a preview of at most 20 rows."""

    columns = [str(column) for column in df.columns]
    dtypes = {str(column): str(df[column].dtype) for column in df.columns}
    stats: dict[str, dict[str, Any]] = {}
    row_count = int(len(df))

    for column in df.columns:
        name = str(column)
        series = df[column]
        nulls = int(series.isna().sum())
        entry: dict[str, Any] = {
            "nulls": nulls,
            "null_count": nulls,
            "null_ratio": float(nulls / row_count) if row_count else 0.0,
            "nunique": int(series.nunique(dropna=True)),
            "unique_count": int(series.nunique(dropna=True)),
        }
        if pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series):
            clean = series.dropna()
            entry.update(
                {
                    "min": _scalar(clean.min()) if not clean.empty else None,
                    "max": _scalar(clean.max()) if not clean.empty else None,
                    "mean": _scalar(clean.mean()) if not clean.empty else None,
                    "std": _scalar(clean.std()) if len(clean) > 1 else None,
                }
            )
        else:
            counts = series.dropna().value_counts().head(10)
            values = {str(_scalar(value)): int(count) for value, count in counts.items()}
            entry["value_counts"] = values
            entry["top_values"] = values
        stats[name] = entry

    # Pandas' JSON encoder consistently converts NaN/NaT to null and timestamps
    # to ISO strings, unlike DataFrame.to_dict.
    preview = json.loads(df.head(20).to_json(orient="records", date_format="iso"))
    return {
        "columns": columns,
        "dtypes": dtypes,
        "row_count": row_count,
        "column_count": int(len(columns)),
        "stats": stats,
        "preview": preview,
    }
