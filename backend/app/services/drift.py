from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

DEFAULT_THRESHOLDS = {"watch": 0.1, "critical": 0.25}


def _finite_numeric(values: pd.Series | np.ndarray) -> np.ndarray:
    numeric = pd.to_numeric(pd.Series(values), errors="coerce").to_numpy(dtype=float)
    return numeric[np.isfinite(numeric)]


def population_stability_index(
    reference: pd.Series | np.ndarray,
    current: pd.Series | np.ndarray,
    *,
    bins: int = 10,
    epsilon: float = 1e-6,
) -> float:
    """Calculate PSI using quantile bins learned from the reference sample."""

    expected = _finite_numeric(reference)
    actual = _finite_numeric(current)
    if not len(expected) or not len(actual):
        return 0.0 if len(expected) == len(actual) else 1.0

    quantiles = np.linspace(0, 1, max(2, bins + 1))
    edges = np.unique(np.quantile(expected, quantiles))
    if len(edges) < 2:
        value = edges[0]
        return 0.0 if np.allclose(actual, value) else 1.0
    edges[0], edges[-1] = -np.inf, np.inf

    expected_counts, _ = np.histogram(expected, bins=edges)
    actual_counts, _ = np.histogram(actual, bins=edges)
    expected_pct = np.clip(expected_counts / len(expected), epsilon, None)
    actual_pct = np.clip(actual_counts / len(actual), epsilon, None)
    return float(np.sum((actual_pct - expected_pct) * np.log(actual_pct / expected_pct)))


def categorical_distribution_distance(
    reference: pd.Series | np.ndarray, current: pd.Series | np.ndarray
) -> float:
    """Return total variation distance between two categorical distributions."""

    expected = pd.Series(reference).fillna("<NULL>").astype(str)
    actual = pd.Series(current).fillna("<NULL>").astype(str)
    categories = expected.unique().tolist()
    categories.extend(value for value in actual.unique() if value not in categories)
    if not categories:
        return 0.0
    expected_dist = expected.value_counts(normalize=True).reindex(categories, fill_value=0.0)
    actual_dist = actual.value_counts(normalize=True).reindex(categories, fill_value=0.0)
    return float(0.5 * np.abs(expected_dist - actual_dist).sum())


def _status(score: float, thresholds: dict[str, float]) -> str:
    if score >= thresholds["critical"]:
        return "critical"
    if score >= thresholds["watch"]:
        return "watch"
    return "ok"


def compute_drift(
    reference: pd.DataFrame,
    current: pd.DataFrame,
    *,
    thresholds: dict[str, float] | None = None,
    include_ks: bool = True,
    bins: int = 10,
) -> dict[str, Any]:
    """Compare dataframes with PSI/KS for numeric and TVD for categorical data."""

    limits = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    if limits["watch"] < 0 or limits["critical"] < limits["watch"]:
        raise ValueError("Drift thresholds require 0 <= watch <= critical.")

    results: dict[str, dict[str, Any]] = {}
    all_columns = list(dict.fromkeys([*map(str, reference.columns), *map(str, current.columns)]))
    for column in all_columns:
        if column not in reference.columns or column not in current.columns:
            results[column] = {
                "kind": "schema",
                "score": 1.0,
                "status": "critical",
                "missing_from": "reference" if column not in reference.columns else "current",
            }
            continue

        expected = reference[column]
        actual = current[column]
        if pd.api.types.is_numeric_dtype(expected) and pd.api.types.is_numeric_dtype(actual):
            score = population_stability_index(expected, actual, bins=bins)
            result: dict[str, Any] = {
                "kind": "numeric",
                "psi": score,
                "score": score,
                "status": _status(score, limits),
            }
            if include_ks:
                try:
                    from scipy.stats import ks_2samp

                    expected_values = _finite_numeric(expected)
                    actual_values = _finite_numeric(actual)
                    if len(expected_values) and len(actual_values):
                        ks = ks_2samp(expected_values, actual_values)
                        result["ks_statistic"] = float(ks.statistic)
                        result["ks_pvalue"] = float(ks.pvalue)
                    else:
                        result["ks_statistic"] = None
                        result["ks_pvalue"] = None
                except ImportError:
                    result["ks_statistic"] = None
                    result["ks_pvalue"] = None
            results[column] = result
        else:
            score = categorical_distribution_distance(expected, actual)
            results[column] = {
                "kind": "categorical",
                "distribution_distance": score,
                "score": score,
                "status": _status(score, limits),
            }

    statuses = {result["status"] for result in results.values()}
    overall = "critical" if "critical" in statuses else "watch" if "watch" in statuses else "ok"
    return {
        "overall_status": overall,
        "thresholds": limits,
        "columns": results,
        "reference_rows": int(len(reference)),
        "current_rows": int(len(current)),
    }


calculate_drift = compute_drift
psi = population_stability_index
