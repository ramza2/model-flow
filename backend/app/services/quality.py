from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import pandas as pd

from app.db.models import QualityResult

SUPPORTED_RULE_TYPES = {
    "required_columns",
    "dtype",
    "max_null_ratio",
    "value_range",
    "uniqueness",
    "no_duplicate_rows",
    "allowed_categories",
}


def _columns(rule: dict[str, Any]) -> list[str]:
    value = rule.get("columns", rule.get("required", rule.get("column", [])))
    if isinstance(value, str):
        return [value]
    return [str(column) for column in value]


def _dtype_matches(series: pd.Series, expected: str) -> bool:
    expected = expected.lower()
    if expected in {"number", "numeric"}:
        return pd.api.types.is_numeric_dtype(series)
    if expected in {"int", "integer"}:
        return pd.api.types.is_integer_dtype(series)
    if expected in {"float", "floating"}:
        return pd.api.types.is_float_dtype(series)
    if expected in {"str", "string", "text", "object"}:
        return pd.api.types.is_string_dtype(series) or series.dtype == object
    if expected in {"bool", "boolean"}:
        return pd.api.types.is_bool_dtype(series)
    if expected in {"datetime", "date", "timestamp"}:
        return pd.api.types.is_datetime64_any_dtype(series)
    if expected in {"category", "categorical"}:
        return isinstance(series.dtype, pd.CategoricalDtype)
    return str(series.dtype).lower() == expected


def _failure_status(rule: dict[str, Any]) -> str:
    severity = str(rule.get("severity", "FAIL")).upper()
    return QualityResult.WARNING.value if severity in {"WARN", "WARNING"} else QualityResult.FAIL.value


def _detail(
    rule: dict[str, Any],
    *,
    passed: bool,
    message: str,
    observed: Any = None,
    expected: Any = None,
) -> dict[str, Any]:
    return {
        "type": str(rule.get("type", "")),
        "name": rule.get("name"),
        "status": QualityResult.PASS.value if passed else _failure_status(rule),
        "message": message,
        "observed": observed,
        "expected": expected,
    }


def _missing_columns(df: pd.DataFrame, columns: Iterable[str]) -> list[str]:
    return [column for column in columns if column not in df.columns]


def _evaluate_rule(df: pd.DataFrame, rule: dict[str, Any]) -> dict[str, Any]:
    rule_type = str(rule.get("type", "")).lower()
    if rule_type not in SUPPORTED_RULE_TYPES:
        raise ValueError(f"Unsupported quality rule type: {rule_type or '<empty>'}")

    if rule_type == "required_columns":
        required = _columns(rule)
        missing = _missing_columns(df, required)
        return _detail(
            rule,
            passed=not missing,
            message="All required columns are present." if not missing else f"Missing columns: {missing}",
            observed={"missing": missing},
            expected={"columns": required},
        )

    if rule_type == "dtype":
        expected_map = rule.get("dtypes")
        if not expected_map:
            columns = _columns(rule)
            expected_map = {column: rule.get("dtype", rule.get("expected")) for column in columns}
        missing = _missing_columns(df, expected_map)
        mismatches = {
            column: {"actual": str(df[column].dtype), "expected": str(expected)}
            for column, expected in expected_map.items()
            if column in df.columns and not _dtype_matches(df[column], str(expected))
        }
        passed = not missing and not mismatches
        return _detail(
            rule,
            passed=passed,
            message="Column dtypes match." if passed else "One or more column dtypes do not match.",
            observed={"missing": missing, "mismatches": mismatches},
            expected=expected_map,
        )

    if rule_type == "max_null_ratio":
        columns = _columns(rule) or [str(column) for column in df.columns]
        missing = _missing_columns(df, columns)
        threshold = float(rule.get("max_ratio", rule.get("threshold", rule.get("value", 0))))
        ratios = {
            column: float(df[column].isna().mean()) if len(df) else 0.0
            for column in columns
            if column in df.columns
        }
        failed = {column: ratio for column, ratio in ratios.items() if ratio > threshold}
        passed = not missing and not failed
        return _detail(
            rule,
            passed=passed,
            message="Null ratios are within the limit." if passed else "Null ratio limit exceeded.",
            observed={"missing": missing, "ratios": ratios, "exceeded": failed},
            expected={"max_ratio": threshold},
        )

    if rule_type == "value_range":
        columns = _columns(rule)
        missing = _missing_columns(df, columns)
        minimum = rule.get("min", rule.get("minimum"))
        maximum = rule.get("max", rule.get("maximum"))
        violations: dict[str, int] = {}
        observed: dict[str, dict[str, Any]] = {}
        for column in columns:
            if column not in df.columns:
                continue
            clean = df[column].dropna()
            mask = pd.Series(False, index=clean.index)
            if minimum is not None:
                mask |= clean < minimum
            if maximum is not None:
                mask |= clean > maximum
            violations[column] = int(mask.sum())
            observed[column] = {
                "min": clean.min().item() if hasattr(clean.min(), "item") else clean.min(),
                "max": clean.max().item() if hasattr(clean.max(), "item") else clean.max(),
            } if not clean.empty else {"min": None, "max": None}
        failed = {column: count for column, count in violations.items() if count}
        passed = not missing and not failed
        return _detail(
            rule,
            passed=passed,
            message="Values are within range." if passed else "Values outside allowed range found.",
            observed={"missing": missing, "ranges": observed, "violation_counts": failed},
            expected={"min": minimum, "max": maximum},
        )

    if rule_type == "uniqueness":
        columns = _columns(rule)
        missing = _missing_columns(df, columns)
        duplicate_count = (
            int(df.duplicated(subset=columns, keep=False).sum()) if columns and not missing else 0
        )
        passed = bool(columns) and not missing and duplicate_count == 0
        return _detail(
            rule,
            passed=passed,
            message="Values are unique." if passed else "Duplicate values found.",
            observed={"missing": missing, "duplicate_rows": duplicate_count},
            expected={"columns": columns, "duplicate_rows": 0},
        )

    if rule_type == "no_duplicate_rows":
        duplicate_count = int(df.duplicated(keep=False).sum())
        return _detail(
            rule,
            passed=duplicate_count == 0,
            message="No duplicate rows found." if not duplicate_count else "Duplicate rows found.",
            observed={"duplicate_rows": duplicate_count},
            expected={"duplicate_rows": 0},
        )

    columns = _columns(rule)
    missing = _missing_columns(df, columns)
    allowed = rule.get("allowed", rule.get("values", rule.get("categories", [])))
    allowed_set = set(allowed)
    unexpected: dict[str, list[Any]] = {}
    for column in columns:
        if column not in df.columns:
            continue
        values = df[column].dropna()
        bad = values[~values.isin(allowed_set)].unique().tolist()
        if bad:
            unexpected[column] = [value.item() if hasattr(value, "item") else value for value in bad[:20]]
    passed = not missing and not unexpected
    return _detail(
        rule,
        passed=passed,
        message="Categories are allowed." if passed else "Unexpected categories found.",
        observed={"missing": missing, "unexpected": unexpected},
        expected={"allowed": list(allowed)},
    )


def run_quality_rules(
    df: pd.DataFrame, rules: list[dict[str, Any]] | dict[str, Any]
) -> dict[str, Any]:
    """Evaluate quality rules and return an aggregate result with rule details."""

    if isinstance(rules, dict):
        rules = rules.get("rules", [rules])
    details = [_evaluate_rule(df, rule) for rule in rules]
    statuses = {detail["status"] for detail in details}
    if QualityResult.FAIL.value in statuses:
        result = QualityResult.FAIL.value
    elif QualityResult.WARNING.value in statuses:
        result = QualityResult.WARNING.value
    else:
        result = QualityResult.PASS.value
    return {"result": result, "details": details}


run_quality_checks = run_quality_rules
