from __future__ import annotations

import json
import re
from collections.abc import Iterable
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Dataset,
    DatasetVersion,
    QualityCheck,
    QualityResult,
    QualityRule,
)

SUPPORTED_RULE_TYPES = {
    "required_columns",
    "dtype",
    "max_null_ratio",
    "value_range",
    "uniqueness",
    "no_duplicate_rows",
    "allowed_categories",
    # Aliases accepted by API / pipelines
    "not_null",
    "nonnull",
    "unique",
    "range",
    "between",
    "allowed_values",
    "in",
}


def _normalize_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """Map convenient aliases onto canonical rule types."""
    normalized = dict(rule)
    rule_type = str(normalized.get("type", "")).lower()
    if rule_type in {"not_null", "nonnull"}:
        normalized["type"] = "max_null_ratio"
        normalized.setdefault("max_ratio", 0)
        if "column" in normalized and "columns" not in normalized:
            normalized["columns"] = [normalized["column"]]
    elif rule_type == "unique":
        normalized["type"] = "uniqueness"
        if "column" in normalized and "columns" not in normalized:
            normalized["columns"] = [normalized["column"]]
    elif rule_type in {"range", "between"}:
        normalized["type"] = "value_range"
        if "column" in normalized and "columns" not in normalized:
            normalized["columns"] = [normalized["column"]]
    elif rule_type in {"allowed_values", "in"}:
        normalized["type"] = "allowed_categories"
        if "column" in normalized and "columns" not in normalized:
            normalized["columns"] = [normalized["column"]]
        if "values" in normalized and "allowed" not in normalized:
            normalized["allowed"] = normalized["values"]
    else:
        normalized["type"] = rule_type
    return normalized


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
    rule = _normalize_rule(rule)
    rule_type = str(rule.get("type", "")).lower()
    if rule_type not in SUPPORTED_RULE_TYPES - {
        "not_null",
        "nonnull",
        "unique",
        "range",
        "between",
        "allowed_values",
        "in",
    }:
        # After normalization only canonical types remain.
        canonical = {
            "required_columns",
            "dtype",
            "max_null_ratio",
            "value_range",
            "uniqueness",
            "no_duplicate_rows",
            "allowed_categories",
        }
        if rule_type not in canonical:
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


# ---------------------------------------------------------------------------
# Dataset-scoped API rule validation and training blockers
# ---------------------------------------------------------------------------

API_RULE_TYPES = frozenset(
    {"not_null", "unique", "range", "allowed_values", "regex"}
)
API_SEVERITIES = frozenset({"fail", "warning"})


class QualityRuleValidationError(ValueError):
    """Raised when a quality rule payload fails validation."""


def validate_api_rule_conditions(
    rules: list[dict[str, Any]] | None,
    *,
    columns: list[str],
) -> list[dict[str, Any]]:
    """Validate and normalize API rule conditions. Raises QualityRuleValidationError."""
    if not rules:
        raise QualityRuleValidationError("At least one rule condition is required.")
    column_set = set(columns)
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(rules):
        if not isinstance(raw, dict):
            raise QualityRuleValidationError(
                f"Rule condition {index + 1} must be an object."
            )
        rule_type = str(raw.get("type", "")).strip().lower()
        if rule_type not in API_RULE_TYPES:
            raise QualityRuleValidationError(
                f"Unsupported rule type '{raw.get('type')}'. "
                f"Supported types: {', '.join(sorted(API_RULE_TYPES))}."
            )
        column = raw.get("column")
        if not column or not isinstance(column, str) or not column.strip():
            raise QualityRuleValidationError(
                f"Rule condition {index + 1} requires a column."
            )
        column = column.strip()
        if column not in column_set:
            raise QualityRuleValidationError(
                f"Column '{column}' was not found in the dataset."
            )
        severity = str(raw.get("severity", "fail")).strip().lower()
        if severity not in API_SEVERITIES:
            raise QualityRuleValidationError(
                f"Severity must be 'fail' or 'warning' (got '{raw.get('severity')}')."
            )
        condition: dict[str, Any] = {
            "type": rule_type,
            "column": column,
            "severity": severity,
        }
        if rule_type == "range":
            minimum = raw.get("min", raw.get("minimum"))
            maximum = raw.get("max", raw.get("maximum"))
            if minimum is None and maximum is None:
                raise QualityRuleValidationError(
                    "Range rules require at least one of min or max."
                )
            if minimum is not None and maximum is not None:
                try:
                    if float(minimum) > float(maximum):
                        raise QualityRuleValidationError(
                            "Range min must be less than or equal to max."
                        )
                except (TypeError, ValueError) as exc:
                    raise QualityRuleValidationError(
                        "Range min and max must be numeric."
                    ) from exc
            if minimum is not None:
                condition["min"] = minimum
            if maximum is not None:
                condition["max"] = maximum
        elif rule_type == "allowed_values":
            values = raw.get("values", raw.get("allowed"))
            if not isinstance(values, list) or len(values) == 0:
                raise QualityRuleValidationError(
                    "Allowed values must be a non-empty array."
                )
            condition["values"] = values
        elif rule_type == "regex":
            pattern = raw.get("pattern")
            if not pattern or not isinstance(pattern, str):
                raise QualityRuleValidationError("Regex rules require a pattern.")
            try:
                re.compile(pattern)
            except re.error as exc:
                raise QualityRuleValidationError(
                    f"Invalid regular expression: {exc}."
                ) from exc
            condition["pattern"] = pattern
        normalized.append(condition)
    return normalized


def resolve_rule_dataset(
    db: Session,
    *,
    project_id: int,
    dataset_id: int,
) -> Dataset:
    """Return the dataset when it exists in the project; else raise QualityRuleValidationError."""
    dataset = db.get(Dataset, dataset_id)
    if not dataset or dataset.project_id != project_id:
        raise QualityRuleValidationError(
            f"Dataset {dataset_id} was not found in this project."
        )
    return dataset


def validate_quality_rule_write(
    db: Session,
    *,
    project_id: int,
    name: str | None,
    dataset_id: int | None,
    rules: list[dict[str, Any]] | None,
    require_dataset: bool,
    require_rules: bool,
    existing_dataset_id: int | None = None,
) -> tuple[Dataset | None, list[dict[str, Any]] | None]:
    """Shared create/update validation. Returns (dataset, normalized_rules)."""
    if name is not None and not str(name).strip():
        raise QualityRuleValidationError("Rule name must not be empty.")

    dataset: Dataset | None = None
    if dataset_id is not None:
        dataset = resolve_rule_dataset(db, project_id=project_id, dataset_id=dataset_id)
    elif require_dataset:
        raise QualityRuleValidationError("dataset_id is required for new quality rules.")
    elif (
        existing_dataset_id is not None
        and dataset_id is None
        and require_dataset is False
    ):
        # Update without changing dataset — load columns from existing assignment when validating rules.
        pass

    columns: list[str] = []
    target_dataset_id = (
        dataset.id if dataset is not None else existing_dataset_id
    )
    if target_dataset_id is not None:
        if dataset is None:
            dataset = resolve_rule_dataset(
                db, project_id=project_id, dataset_id=target_dataset_id
            )
        columns = json.loads(dataset.columns_json or "[]")

    normalized_rules: list[dict[str, Any]] | None = None
    if rules is not None:
        if not columns and target_dataset_id is None:
            raise QualityRuleValidationError(
                "Assign a dataset before configuring rule conditions."
            )
        normalized_rules = validate_api_rule_conditions(rules, columns=columns)
    elif require_rules:
        raise QualityRuleValidationError("At least one rule condition is required.")

    return dataset, normalized_rules


def evaluate_api_rule(frame: pd.DataFrame, rule: dict[str, Any]) -> tuple[bool, str]:
    """Evaluate a single API quality condition against a dataframe."""
    rule_type = str(rule.get("type", "")).lower()
    column = rule.get("column")
    if column not in frame.columns:
        return False, f"Column '{column}' was not found"
    series = frame[column]
    if rule_type in {"not_null", "nonnull"}:
        count = int(series.isna().sum())
        return count == 0, f"{count} null values"
    if rule_type == "unique":
        count = int(series.duplicated().sum())
        return count == 0, f"{count} duplicate values"
    if rule_type in {"range", "between"}:
        minimum, maximum = rule.get("min"), rule.get("max")
        invalid = series.notna() & (
            ((series < minimum) if minimum is not None else False)
            | ((series > maximum) if maximum is not None else False)
        )
        count = int(invalid.sum())
        return count == 0, f"{count} values outside the configured range"
    if rule_type in {"allowed_values", "in"}:
        invalid = series.notna() & ~series.isin(rule.get("values", []))
        count = int(invalid.sum())
        return count == 0, f"{count} values are not allowed"
    if rule_type == "regex":
        try:
            pattern = str(rule.get("pattern", ""))
            re.compile(pattern)
        except re.error as exc:
            return False, f"Invalid regular expression: {exc}"
        invalid = series.notna() & ~series.astype(str).str.match(pattern)
        count = int(invalid.sum())
        return count == 0, f"{count} values do not match"
    return False, f"Unsupported rule type '{rule_type}'"


def _detail_is_fail_severity_failure(detail: dict[str, Any]) -> bool:
    if detail.get("passed", True):
        return False
    severity = detail.get("severity")
    if severity is None and isinstance(detail.get("rule"), dict):
        severity = detail["rule"].get("severity", "fail")
    return str(severity or "fail").lower() == "fail"


def get_training_quality_blockers(
    db: Session,
    dataset_version_id: int,
) -> list[dict[str, Any]]:
    """
    Return active blocking rules whose latest evaluation has a fail-severity failure.

    Walks quality checks newest-first and records the first (latest) result per rule.
    Rules with no evaluation history do not block training.
    """
    version = db.get(DatasetVersion, dataset_version_id)
    if version is None:
        return []

    active_blocking = db.scalars(
        select(QualityRule).where(
            QualityRule.project_id == version.project_id,
            QualityRule.dataset_id == version.dataset_id,
            QualityRule.is_active.is_(True),
            QualityRule.block_training_on_fail.is_(True),
        )
    ).all()
    if not active_blocking:
        return []

    pending: dict[int, QualityRule] = {rule.id: rule for rule in active_blocking}
    blockers: list[dict[str, Any]] = []

    checks = db.scalars(
        select(QualityCheck)
        .where(QualityCheck.dataset_version_id == dataset_version_id)
        .order_by(QualityCheck.id.desc())
    ).all()

    for check in checks:
        if not pending:
            break
        try:
            details = json.loads(check.details_json or "[]")
        except (TypeError, ValueError):
            details = []
        if not isinstance(details, list):
            continue

        seen_in_check: set[int] = set()
        for detail in details:
            if not isinstance(detail, dict):
                continue
            rule_id = detail.get("quality_rule_id")
            if rule_id not in pending or rule_id in seen_in_check:
                continue
            seen_in_check.add(rule_id)
            rule = pending.pop(rule_id)
            rule_details = [
                item
                for item in details
                if isinstance(item, dict) and item.get("quality_rule_id") == rule_id
            ]
            if any(_detail_is_fail_severity_failure(item) for item in rule_details):
                blockers.append(
                    {
                        "quality_rule_id": rule.id,
                        "name": rule.name,
                        "check_id": check.id,
                    }
                )

    return blockers
