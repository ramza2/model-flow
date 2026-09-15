"""Reusable Dataset Preparation graph DataFrame operations.

Preview uses DatasetVersion.preview_json samples; Full Run uses full
DatasetVersion frames via the same execute_preparation_graph().
"""

from __future__ import annotations

import json
import math
from collections import defaultdict, deque
from datetime import date, datetime
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session

from app.db.models import DatasetVersion
from app.schemas.v1 import DatasetPreparationGraph
from app.services.dataset_preparation import (
    CAST_TYPES,
    DEDUP_KEEP,
    DERIVED_OPS,
    FILTER_COMBINES,
    FILTER_NULLARY_OPS,
    FILTER_OPERATORS,
    GROUP_BY_OPS,
    JOIN_HOWS,
    TRANSFORM_TYPES,
    UNION_MODES,
    PreparationValidationError,
    graph_to_dict,
    resolve_source_pins,
    validate_preparation_graph,
)

JOIN_HOW_PANDAS = {
    "inner": "inner",
    "left": "left",
    "right": "right",
    "full": "outer",
}

PREVIEW_SOURCE_ROW_CAP = 100
PREVIEW_WARNING = (
    "Preview uses stored DatasetVersion sample rows and may not represent the full dataset."
)
PREVIEW_GROUP_BY_WARNING = (
    "Group By preview is computed from sampled source rows; "
    "aggregate values and group counts may differ in a full run."
)

_BOOLEAN_STRING_MAP = {
    "true": True,
    "false": False,
    "1": True,
    "0": False,
    "yes": True,
    "no": False,
}


class PreparationExecutionError(Exception):
    """User-facing preview/execution failure."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def _loads(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def frame_from_preview(
    *,
    columns: list[str],
    preview_rows: list[dict[str, Any]] | None,
) -> pd.DataFrame:
    """Build a sampled DataFrame from DatasetVersion preview metadata."""
    cols = [str(col) for col in columns]
    rows = preview_rows if isinstance(preview_rows, list) else []
    if not cols and rows:
        seen: list[str] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            for key in row:
                name = str(key)
                if name not in seen:
                    seen.append(name)
        cols = seen
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            normalized.append({col: None for col in cols})
            continue
        normalized.append({col: row.get(col) for col in cols})
    if not cols:
        return pd.DataFrame()
    return pd.DataFrame(normalized, columns=cols)


def _topo_order(nodes: dict[str, dict[str, Any]], edges: list[dict[str, Any]]) -> list[str]:
    adjacency: dict[str, list[str]] = defaultdict(list)
    indegree: dict[str, int] = {node_id: 0 for node_id in nodes}
    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source not in nodes or target not in nodes:
            continue
        adjacency[source].append(target)
        indegree[target] = indegree.get(target, 0) + 1
    for source in list(adjacency):
        adjacency[source] = sorted(set(adjacency[source]))
    queue: deque[str] = deque(sorted(node_id for node_id, deg in indegree.items() if deg == 0))
    order: list[str] = []
    while queue:
        node_id = queue.popleft()
        order.append(node_id)
        for nxt in adjacency.get(node_id, []):
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                inserted = False
                for idx, existing in enumerate(queue):
                    if nxt < existing:
                        queue.insert(idx, nxt)
                        inserted = True
                        break
                if not inserted:
                    queue.append(nxt)
    if len(order) != len(nodes):
        raise PreparationExecutionError("Preparation graph contains a cycle.")
    return order


def _incoming_edges(edges: list[dict[str, Any]], node_id: str) -> list[dict[str, Any]]:
    return [edge for edge in edges if edge["target"] == node_id]


def _require_column(frame: pd.DataFrame, node_id: str, column: str) -> str:
    name = str(column)
    if name not in frame.columns:
        raise PreparationExecutionError(
            f"Node '{node_id}': column '{name}' is missing."
        )
    return name


def _execute_join(
    node_id: str,
    config: dict[str, Any],
    left: pd.DataFrame,
    right: pd.DataFrame,
) -> pd.DataFrame:
    how = config.get("how")
    if how not in JOIN_HOWS:
        raise PreparationExecutionError(
            f"Join could not run because join type on '{node_id}' is invalid."
        )
    left_on = config.get("left_on") or []
    right_on = config.get("right_on") or []
    if not isinstance(left_on, list) or not isinstance(right_on, list):
        raise PreparationExecutionError(
            f"Join could not run because keys on '{node_id}' are invalid."
        )
    left_keys = [str(item).strip() for item in left_on]
    right_keys = [str(item).strip() for item in right_on]
    for key in left_keys:
        if key not in left.columns:
            raise PreparationExecutionError(
                f"Join could not run because column '{key}' is missing from the left input."
            )
    for key in right_keys:
        if key not in right.columns:
            raise PreparationExecutionError(
                f"Join could not run because column '{key}' is missing from the right input."
            )
    return left.merge(
        right,
        how=JOIN_HOW_PANDAS[how],
        left_on=left_keys,
        right_on=right_keys,
        suffixes=("_left", "_right"),
    )


def _execute_union(
    node_id: str,
    config: dict[str, Any],
    frames: list[pd.DataFrame],
) -> pd.DataFrame:
    mode = config.get("mode")
    if mode not in UNION_MODES:
        raise PreparationExecutionError(
            f"Union could not run because mode on '{node_id}' is invalid."
        )
    if len(frames) < 2:
        raise PreparationExecutionError(
            f"Union could not run because '{node_id}' needs at least two inputs."
        )
    if mode == "strict":
        first_cols = list(frames[0].columns)
        for idx, frame in enumerate(frames[1:], start=2):
            if list(frame.columns) != first_cols:
                raise PreparationExecutionError(
                    f"Union could not run because input schemas on '{node_id}' "
                    f"do not match in strict mode (input {idx})."
                )
        return pd.concat(frames, ignore_index=True)

    ordered_cols: list[str] = []
    for frame in frames:
        for col in frame.columns:
            name = str(col)
            if name not in ordered_cols:
                ordered_cols.append(name)
    aligned = [frame.reindex(columns=ordered_cols) for frame in frames]
    return pd.concat(aligned, ignore_index=True)


def _execute_select(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    columns = config.get("columns") or []
    if not isinstance(columns, list):
        raise PreparationExecutionError(
            f"Node '{node_id}': columns must be a list."
        )
    selected: list[str] = []
    for item in columns:
        name = _require_column(frame, node_id, str(item))
        selected.append(name)
    return frame.loc[:, selected].copy()


def _execute_drop(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    columns = config.get("columns") or []
    if not isinstance(columns, list):
        raise PreparationExecutionError(
            f"Node '{node_id}': columns must be a list."
        )
    to_drop: list[str] = []
    for item in columns:
        name = _require_column(frame, node_id, str(item))
        to_drop.append(name)
    return frame.drop(columns=to_drop).copy()


def _execute_rename(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    mapping = config.get("mapping") or {}
    if not isinstance(mapping, dict):
        raise PreparationExecutionError(
            f"Node '{node_id}': mapping must be an object."
        )
    rename_map: dict[str, str] = {}
    for source, target in mapping.items():
        source_name = _require_column(frame, node_id, str(source))
        target_name = str(target).strip() if isinstance(target, str) else str(target)
        rename_map[source_name] = target_name

    sources = set(rename_map.keys())
    for source_name, target_name in rename_map.items():
        if (
            target_name in frame.columns
            and target_name != source_name
            and target_name not in sources
        ):
            raise PreparationExecutionError(
                f"Node '{node_id}': rename would create duplicate column names."
            )

    result_names = [
        rename_map[str(col)] if str(col) in rename_map else str(col)
        for col in frame.columns
    ]
    if len(result_names) != len(set(result_names)):
        raise PreparationExecutionError(
            f"Node '{node_id}': rename would create duplicate column names."
        )

    out = frame.rename(columns=rename_map).copy()
    out.columns = [str(col) for col in out.columns]
    return out


def _filter_condition_mask(
    frame: pd.DataFrame,
    node_id: str,
    condition: dict[str, Any],
) -> pd.Series:
    column = condition.get("column")
    if not isinstance(column, str) or not column.strip():
        raise PreparationExecutionError(
            f"Node '{node_id}': filter condition column is invalid."
        )
    col_name = _require_column(frame, node_id, column.strip())
    operator = condition.get("operator")
    if operator not in FILTER_OPERATORS:
        raise PreparationExecutionError(
            f"Node '{node_id}': unsupported filter operator '{operator}'."
        )

    series = frame[col_name]
    if operator in FILTER_NULLARY_OPS:
        if operator == "is_null":
            return series.isna()
        return series.notna()

    value = condition.get("value")
    if operator == "in":
        if not isinstance(value, list):
            raise PreparationExecutionError(
                f"Node '{node_id}': 'in' operator requires a list value."
            )
        try:
            return series.isin(value).fillna(False)
        except (TypeError, ValueError) as exc:
            raise PreparationExecutionError(
                f"Node '{node_id}': operator 'in' could not be applied to column "
                f"'{col_name}' with the supplied value."
            ) from exc

    try:
        if operator == "eq":
            return (series == value).fillna(False)
        if operator == "neq":
            return (series != value).fillna(False)
        if operator == "gt":
            return (series > value).fillna(False)
        if operator == "gte":
            return (series >= value).fillna(False)
        if operator == "lt":
            return (series < value).fillna(False)
        if operator == "lte":
            return (series <= value).fillna(False)
    except (TypeError, ValueError) as exc:
        raise PreparationExecutionError(
            f"Node '{node_id}': operator '{operator}' could not be applied to column "
            f"'{col_name}' with the supplied value."
        ) from exc

    # String matchers: convert to string; null rows are false.
    as_str = series.astype("string")
    needle = "" if value is None else str(value)
    if operator == "contains":
        return as_str.str.contains(needle, regex=False, na=False)
    if operator == "starts_with":
        return as_str.str.startswith(needle, na=False)
    if operator == "ends_with":
        return as_str.str.endswith(needle, na=False)

    raise PreparationExecutionError(
        f"Node '{node_id}': unsupported filter operator '{operator}'."
    )


def _execute_filter(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    combine = config.get("combine", "and")
    if combine not in FILTER_COMBINES:
        raise PreparationExecutionError(
            f"Node '{node_id}': combine must be 'and' or 'or'."
        )
    conditions = config.get("conditions") or []
    if not isinstance(conditions, list) or not conditions:
        raise PreparationExecutionError(
            f"Node '{node_id}': conditions must be a non-empty list."
        )

    mask: pd.Series | None = None
    for condition in conditions:
        if not isinstance(condition, dict):
            raise PreparationExecutionError(
                f"Node '{node_id}': filter conditions must be objects."
            )
        condition_mask = _filter_condition_mask(frame, node_id, condition)
        if mask is None:
            mask = condition_mask
        elif combine == "and":
            mask = mask & condition_mask
        else:
            mask = mask | condition_mask

    assert mask is not None
    return frame.loc[mask.fillna(False)].copy()


def _coerce_boolean_series(
    series: pd.Series,
    node_id: str,
    column: str,
) -> pd.Series:
    """Cast values to nullable boolean; only true/false/1/0/yes/no (case-insensitive)."""
    values: list[Any] = []
    for value in series.tolist():
        try:
            if value is None or pd.isna(value):
                values.append(pd.NA)
                continue
        except (TypeError, ValueError):
            pass
        if isinstance(value, bool):
            values.append(value)
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if value == 1 or value == 0:
                values.append(bool(value == 1))
                continue
            raise PreparationExecutionError(
                f"Node '{node_id}': cannot cast column '{column}' to boolean."
            )
        text = str(value).strip().lower()
        if text in _BOOLEAN_STRING_MAP:
            values.append(_BOOLEAN_STRING_MAP[text])
            continue
        raise PreparationExecutionError(
            f"Node '{node_id}': cannot cast column '{column}' to boolean."
        )
    return pd.Series(values, index=series.index, dtype="boolean")


def _execute_cast(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    casts = config.get("casts") or {}
    if not isinstance(casts, dict):
        raise PreparationExecutionError(
            f"Node '{node_id}': casts must be an object."
        )
    out = frame.copy()
    for column, cast_type in casts.items():
        col_name = _require_column(out, node_id, str(column))
        if cast_type not in CAST_TYPES:
            raise PreparationExecutionError(
                f"Node '{node_id}': unsupported cast type '{cast_type}'."
            )
        try:
            if cast_type == "integer":
                numeric = pd.to_numeric(out[col_name], errors="raise")
                out[col_name] = numeric.astype("Int64")
            elif cast_type == "float":
                out[col_name] = pd.to_numeric(out[col_name], errors="raise").astype(
                    "float64"
                )
            elif cast_type == "string":
                out[col_name] = out[col_name].astype("string")
            elif cast_type == "datetime":
                out[col_name] = pd.to_datetime(out[col_name], errors="raise")
            elif cast_type == "boolean":
                out[col_name] = _coerce_boolean_series(out[col_name], node_id, col_name)
        except PreparationExecutionError:
            raise
        except (ValueError, TypeError, OverflowError) as exc:
            raise PreparationExecutionError(
                f"Node '{node_id}': could not cast column '{col_name}' to {cast_type}."
            ) from exc
    return out


def _execute_deduplicate(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    columns = config.get("columns", [])
    if not isinstance(columns, list):
        raise PreparationExecutionError(
            f"Node '{node_id}': columns must be a list."
        )
    keep = config.get("keep", "first")
    if keep not in DEDUP_KEEP:
        raise PreparationExecutionError(
            f"Node '{node_id}': keep must be 'first' or 'last'."
        )
    if columns:
        subset = [_require_column(frame, node_id, str(item)) for item in columns]
    else:
        subset = None
    return frame.drop_duplicates(subset=subset, keep=keep).copy()


def _execute_fill_constant(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    values = config.get("values") or {}
    if not isinstance(values, dict):
        raise PreparationExecutionError(
            f"Node '{node_id}': values must be an object."
        )
    out = frame.copy()
    for column, fill_value in values.items():
        col_name = _require_column(out, node_id, str(column))
        try:
            out[col_name] = out[col_name].fillna(fill_value)
        except (TypeError, ValueError) as exc:
            raise PreparationExecutionError(
                f"Node '{node_id}': could not fill column '{col_name}' "
                f"with the supplied value."
            ) from exc
    return out


def _resolve_operand(
    node_id: str,
    frame: pd.DataFrame,
    operand: Any,
    *,
    side: str,
) -> pd.Series | Any:
    if not isinstance(operand, dict):
        raise PreparationExecutionError(
            f"Node '{node_id}': {side} operand must be an object."
        )
    kind = operand.get("kind")
    value = operand.get("value")
    if kind == "column":
        if not isinstance(value, str) or not value.strip():
            raise PreparationExecutionError(
                f"Node '{node_id}': {side} column value is invalid."
            )
        col_name = _require_column(frame, node_id, value.strip())
        return frame[col_name]
    if kind == "literal":
        return value
    raise PreparationExecutionError(
        f"Node '{node_id}': {side} operand kind must be column or literal."
    )


def _as_numeric_operand(value: pd.Series | Any, node_id: str) -> pd.Series | Any:
    try:
        if isinstance(value, pd.Series):
            return pd.to_numeric(value, errors="raise")
        return pd.to_numeric(pd.Series([value]), errors="raise").iloc[0]
    except (ValueError, TypeError) as exc:
        raise PreparationExecutionError(
            f"Node '{node_id}': operands must be numeric for arithmetic."
        ) from exc


def _as_concat_text(value: pd.Series | Any) -> pd.Series | str:
    """Stringify for concat; null / NA becomes empty string."""
    if isinstance(value, pd.Series):
        return value.astype("string").fillna("")
    try:
        if value is None or pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value)


def _execute_derived_column(
    node_id: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    name = config.get("name")
    if not isinstance(name, str) or not name.strip():
        raise PreparationExecutionError(
            f"Node '{node_id}': derived column name must be a non-empty string."
        )
    column_name = name.strip()
    if column_name in frame.columns:
        raise PreparationExecutionError(
            f"Node '{node_id}': column '{column_name}' already exists."
        )

    operation = config.get("operation")
    if operation not in DERIVED_OPS:
        raise PreparationExecutionError(
            f"Node '{node_id}': unsupported derived operation '{operation}'."
        )

    left = _resolve_operand(node_id, frame, config.get("left"), side="left")
    right = _resolve_operand(node_id, frame, config.get("right"), side="right")

    out = frame.copy()
    if operation == "concat":
        # Null becomes "" for both column and literal operands.
        out[column_name] = _as_concat_text(left) + _as_concat_text(right)
        return out

    left_num = _as_numeric_operand(left, node_id)
    right_num = _as_numeric_operand(right, node_id)

    if operation == "add":
        out[column_name] = left_num + right_num
    elif operation == "subtract":
        out[column_name] = left_num - right_num
    elif operation == "multiply":
        out[column_name] = left_num * right_num
    elif operation == "divide":
        if isinstance(right_num, pd.Series):
            if bool((right_num == 0).fillna(False).any()):
                raise PreparationExecutionError(
                    f"Node '{node_id}': division by zero."
                )
        else:
            try:
                is_zero = right_num == 0
            except (TypeError, ValueError):
                is_zero = False
            if is_zero:
                raise PreparationExecutionError(
                    f"Node '{node_id}': division by zero."
                )
        out[column_name] = left_num / right_num
    return out


def _group_by_aggfunc(op: str) -> str:
    if op == "sum":
        return "sum"
    if op == "avg":
        return "mean"
    if op == "min":
        return "min"
    if op == "max":
        return "max"
    if op == "count":
        return "count"
    raise ValueError(f"unsupported aggregation op '{op}'")


def _execute_group_by(node_id: str, config: dict[str, Any], frame: pd.DataFrame) -> pd.DataFrame:
    group_by = config.get("group_by")
    aggregations = config.get("aggregations")
    if not isinstance(group_by, list) or not group_by:
        raise PreparationExecutionError(
            f"Node '{node_id}': group_by requires at least one grouping column."
        )
    if not isinstance(aggregations, list) or not aggregations:
        raise PreparationExecutionError(
            f"Node '{node_id}': group_by requires at least one aggregation."
        )

    normalized_keys: list[str] = []
    for key in group_by:
        if not isinstance(key, str) or not key.strip():
            raise PreparationExecutionError(
                f"Node '{node_id}': group_by keys must be non-empty strings."
            )
        name = _require_column(frame, node_id, key.strip())
        if name in normalized_keys:
            raise PreparationExecutionError(
                f"Node '{node_id}': duplicate group_by key '{name}'."
            )
        normalized_keys.append(name)

    named_aggs: dict[str, pd.NamedAgg] = {}
    output_order: list[str] = []
    for index, row in enumerate(aggregations):
        if not isinstance(row, dict):
            raise PreparationExecutionError(
                f"Node '{node_id}': aggregations[{index}] must be an object."
            )
        column = row.get("column")
        op = row.get("op")
        output = row.get("output")
        if not isinstance(column, str) or not column.strip():
            raise PreparationExecutionError(
                f"Node '{node_id}': aggregations[{index}].column must be a non-empty string."
            )
        if not isinstance(op, str) or op not in GROUP_BY_OPS:
            raise PreparationExecutionError(
                f"Node '{node_id}': aggregations[{index}].op must be one of "
                "sum, avg, min, max, count."
            )
        if not isinstance(output, str) or not output.strip():
            raise PreparationExecutionError(
                f"Node '{node_id}': aggregations[{index}].output must be a non-empty string."
            )
        source_column = _require_column(frame, node_id, column.strip())
        output_name = output.strip()
        if output_name in normalized_keys:
            raise PreparationExecutionError(
                f"Node '{node_id}': aggregation output '{output_name}' "
                "collides with a group_by key."
            )
        if output_name in named_aggs:
            raise PreparationExecutionError(
                f"Node '{node_id}': duplicate aggregation output '{output_name}'."
            )
        series = frame[source_column]
        if op in {"sum", "avg"}:
            # Booleans are numeric in pandas; reject them for SUM/AVG (no implicit bool math).
            if pd.api.types.is_bool_dtype(series) or not pd.api.types.is_numeric_dtype(
                series
            ):
                raise PreparationExecutionError(
                    f"Node '{node_id}': aggregation '{op}' could not be applied "
                    f"to column '{source_column}'."
                )
        named_aggs[output_name] = pd.NamedAgg(
            column=source_column, aggfunc=_group_by_aggfunc(op)
        )
        output_order.append(output_name)

    try:
        grouped = frame.groupby(normalized_keys, dropna=False, sort=False)
        result = grouped.agg(**named_aggs)
    except PreparationExecutionError:
        raise
    except TypeError as exc:
        raise PreparationExecutionError(
            f"Node '{node_id}': aggregation could not be applied ({exc})."
        ) from exc
    except Exception as exc:  # noqa: BLE001 - normalize pandas aggregation failures
        message = str(exc)
        for output_name, named in named_aggs.items():
            op = next(
                (
                    row.get("op")
                    for row in aggregations
                    if isinstance(row, dict)
                    and isinstance(row.get("output"), str)
                    and row.get("output", "").strip() == output_name
                ),
                None,
            )
            if op in {"sum", "avg"} and named.column in message:
                raise PreparationExecutionError(
                    f"Node '{node_id}': aggregation '{op}' could not be applied "
                    f"to column '{named.column}'."
                ) from exc
        raise PreparationExecutionError(
            f"Node '{node_id}': aggregation could not be applied ({message})."
        ) from exc

    result = result.reset_index()
    ordered_columns = normalized_keys + output_order
    missing = [column for column in ordered_columns if column not in result.columns]
    if missing:
        raise PreparationExecutionError(
            f"Node '{node_id}': group_by result missing expected columns {missing}."
        )
    return result.loc[:, ordered_columns].reset_index(drop=True)


def _execute_transform(
    node_id: str,
    node_type: str,
    config: dict[str, Any],
    frame: pd.DataFrame,
) -> pd.DataFrame:
    if node_type == "select":
        return _execute_select(node_id, config, frame)
    if node_type == "drop":
        return _execute_drop(node_id, config, frame)
    if node_type == "rename":
        return _execute_rename(node_id, config, frame)
    if node_type == "filter":
        return _execute_filter(node_id, config, frame)
    if node_type == "cast":
        return _execute_cast(node_id, config, frame)
    if node_type == "deduplicate":
        return _execute_deduplicate(node_id, config, frame)
    if node_type == "fill_constant":
        return _execute_fill_constant(node_id, config, frame)
    if node_type == "derived_column":
        return _execute_derived_column(node_id, config, frame)
    if node_type == "group_by":
        return _execute_group_by(node_id, config, frame)
    if node_type == "unpivot":
        return _execute_unpivot(node_id, config, frame)
    raise PreparationExecutionError(
        f"Unsupported transform type '{node_type}' on '{node_id}'."
    )


def _unpivot_temp_name(prefix: str, reserved: set[str]) -> str:
    index = 0
    while True:
        candidate = f"__modelflow_unpivot_{prefix}_{index}__"
        if candidate not in reserved:
            reserved.add(candidate)
            return candidate
        index += 1


def _execute_unpivot(node_id: str, config: dict[str, Any], frame: pd.DataFrame) -> pd.DataFrame:
    id_columns = config.get("id_columns")
    value_columns = config.get("value_columns")
    variable_column = config.get("variable_column")
    value_column = config.get("value_column")

    if not isinstance(id_columns, list):
        raise PreparationExecutionError(
            f"Node '{node_id}': id_columns must be a list."
        )
    if not isinstance(value_columns, list) or not value_columns:
        raise PreparationExecutionError(
            f"Node '{node_id}': unpivot requires at least one value column."
        )
    if not isinstance(variable_column, str) or not variable_column.strip():
        raise PreparationExecutionError(
            f"Node '{node_id}': variable_column must be a non-empty string."
        )
    if not isinstance(value_column, str) or not value_column.strip():
        raise PreparationExecutionError(
            f"Node '{node_id}': value_column must be a non-empty string."
        )

    normalized_ids: list[str] = []
    for key in id_columns:
        if not isinstance(key, str) or not key.strip():
            raise PreparationExecutionError(
                f"Node '{node_id}': id_columns entries must be non-empty strings."
            )
        name = _require_column(frame, node_id, key.strip())
        if name in normalized_ids:
            raise PreparationExecutionError(
                f"Node '{node_id}': duplicate id_columns entry '{name}'."
            )
        normalized_ids.append(name)

    normalized_values: list[str] = []
    for key in value_columns:
        if not isinstance(key, str) or not key.strip():
            raise PreparationExecutionError(
                f"Node '{node_id}': value_columns entries must be non-empty strings."
            )
        name = _require_column(frame, node_id, key.strip())
        if name in normalized_values:
            raise PreparationExecutionError(
                f"Node '{node_id}': duplicate value_columns entry '{name}'."
            )
        if name in normalized_ids:
            raise PreparationExecutionError(
                f"Node '{node_id}': id_columns and value_columns must not overlap "
                f"(column '{name}')."
            )
        normalized_values.append(name)

    variable_alias = variable_column.strip()
    value_alias = value_column.strip()
    if variable_alias == value_alias:
        raise PreparationExecutionError(
            f"Node '{node_id}': variable_column and value_column must be different."
        )
    if variable_alias in normalized_ids:
        raise PreparationExecutionError(
            f"Node '{node_id}': variable_column '{variable_alias}' collides with an "
            "id_columns entry."
        )
    if value_alias in normalized_ids:
        raise PreparationExecutionError(
            f"Node '{node_id}': value_column '{value_alias}' collides with an "
            "id_columns entry."
        )

    selected = frame.loc[:, normalized_ids + normalized_values]
    reserved = set(selected.columns) | {variable_alias, value_alias}
    temp_var = _unpivot_temp_name("var", reserved)
    temp_val = _unpivot_temp_name("val", reserved)

    try:
        melted = selected.melt(
            id_vars=normalized_ids,
            value_vars=normalized_values,
            var_name=temp_var,
            value_name=temp_val,
            ignore_index=True,
        )
    except Exception as exc:  # noqa: BLE001 - normalize pandas melt failures
        raise PreparationExecutionError(
            f"Node '{node_id}': unpivot could not be applied ({exc})."
        ) from exc

    result = melted.rename(columns={temp_var: variable_alias, temp_val: value_alias})
    ordered = normalized_ids + [variable_alias, value_alias]
    missing = [column for column in ordered if column not in result.columns]
    if missing:
        raise PreparationExecutionError(
            f"Node '{node_id}': unpivot result missing expected columns {missing}."
        )
    return result.loc[:, ordered].reset_index(drop=True)


def _preview_path_includes_group_by(
    nodes: list[Any],
    edges: list[Any],
    target_node_id: str | None,
) -> bool:
    """True when target (or default Output) has a group_by ancestor, including itself."""
    node_map: dict[str, dict[str, Any]] = {}
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            continue
        node_map[str(node["id"]).strip()] = node
    if not node_map:
        return False

    effective = target_node_id
    if effective is None:
        outputs = [nid for nid, node in node_map.items() if node.get("type") == "output"]
        if len(outputs) != 1:
            return False
        effective = outputs[0]
    if effective not in node_map:
        return False

    parents: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "").strip()
        target = str(edge.get("target") or "").strip()
        if source in node_map and target in node_map:
            parents[target].append(source)

    seen: set[str] = set()
    stack = [effective]
    while stack:
        node_id = stack.pop()
        if node_id in seen:
            continue
        seen.add(node_id)
        node = node_map.get(node_id)
        if node is not None and node.get("type") == "group_by":
            return True
        stack.extend(parents.get(node_id, []))
    return False


def execute_preparation_graph(
    graph: DatasetPreparationGraph | dict[str, Any],
    source_frames: dict[str, pd.DataFrame],
    *,
    target_node_id: str | None = None,
) -> pd.DataFrame:
    """Execute Source/Join/Union/transform/Output operations on provided frames."""
    data = graph_to_dict(graph)
    raw_nodes = data.get("nodes") or []
    raw_edges = data.get("edges") or []

    nodes: dict[str, dict[str, Any]] = {}
    for node in raw_nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            continue
        nodes[node_id] = {
            "id": node_id,
            "type": node.get("type"),
            "config": node.get("config") if isinstance(node.get("config"), dict) else {},
        }

    edges: list[dict[str, Any]] = []
    for edge in raw_edges:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "").strip()
        target = str(edge.get("target") or "").strip()
        if not source or not target or source not in nodes or target not in nodes:
            continue
        port = edge.get("target_port")
        edges.append(
            {
                "id": str(edge.get("id") or "").strip(),
                "source": source,
                "target": target,
                "target_port": (
                    port.strip() if isinstance(port, str) and port.strip() else None
                ),
            }
        )

    if not nodes:
        raise PreparationExecutionError("Preparation graph has no nodes.")

    outputs = [nid for nid, node in nodes.items() if node["type"] == "output"]
    if target_node_id is None:
        if len(outputs) != 1:
            raise PreparationExecutionError(
                "Preparation graph must have exactly one output node for preview."
            )
        target_node_id = outputs[0]
    elif target_node_id not in nodes:
        raise PreparationExecutionError(
            f"Preview node '{target_node_id}' was not found in the graph."
        )

    results: dict[str, pd.DataFrame] = {}
    for node_id in _topo_order(nodes, edges):
        node = nodes[node_id]
        node_type = node["type"]
        config = node["config"]
        incoming = _incoming_edges(edges, node_id)

        if node_type == "source":
            if node_id not in source_frames:
                raise PreparationExecutionError(
                    f"Source frame for node '{node_id}' is missing."
                )
            results[node_id] = source_frames[node_id].copy()
        elif node_type == "join":
            by_port = {edge.get("target_port"): edge for edge in incoming}
            left_edge = by_port.get("left")
            right_edge = by_port.get("right")
            if left_edge is None or right_edge is None:
                raise PreparationExecutionError(
                    f"Join could not run because '{node_id}' needs left and right inputs."
                )
            left_frame = results.get(left_edge["source"])
            right_frame = results.get(right_edge["source"])
            if left_frame is None or right_frame is None:
                raise PreparationExecutionError(
                    f"Join could not run because inputs for '{node_id}' are not ready."
                )
            results[node_id] = _execute_join(node_id, config, left_frame, right_frame)
        elif node_type == "union":
            frames: list[pd.DataFrame] = []
            for edge in incoming:
                frame = results.get(edge["source"])
                if frame is None:
                    raise PreparationExecutionError(
                        f"Union could not run because an input for '{node_id}' is not ready."
                    )
                frames.append(frame)
            results[node_id] = _execute_union(node_id, config, frames)
        elif node_type in TRANSFORM_TYPES:
            if len(incoming) != 1:
                raise PreparationExecutionError(
                    f"Node '{node_id}': transform requires exactly one incoming edge."
                )
            upstream = results.get(incoming[0]["source"])
            if upstream is None:
                raise PreparationExecutionError(
                    f"Node '{node_id}': upstream result is missing."
                )
            results[node_id] = _execute_transform(
                node_id, node_type, config, upstream
            )
        elif node_type == "output":
            if len(incoming) != 1:
                raise PreparationExecutionError(
                    f"Output node '{node_id}' must have exactly one incoming edge."
                )
            upstream = results.get(incoming[0]["source"])
            if upstream is None:
                raise PreparationExecutionError(
                    f"Output node '{node_id}' upstream result is missing."
                )
            results[node_id] = upstream.copy()
        else:
            raise PreparationExecutionError(
                f"Unsupported node type '{node_type}' on '{node_id}'."
            )

        if node_id == target_node_id:
            return results[node_id]

    raise PreparationExecutionError(
        f"Preview node '{target_node_id}' was not produced during execution."
    )


def _json_safe_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return _json_safe_value(value.item())
        except (ValueError, TypeError):
            return str(value)
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


def dataframe_preview_payload(frame: pd.DataFrame, *, limit: int) -> dict[str, Any]:
    limited = frame.head(limit)
    columns = [str(col) for col in limited.columns]
    dtypes = {str(col): str(dtype) for col, dtype in limited.dtypes.items()}
    rows: list[dict[str, Any]] = []
    for record in limited.to_dict(orient="records"):
        rows.append({col: _json_safe_value(record.get(col)) for col in columns})
    return {
        "columns": columns,
        "dtypes": dtypes,
        "rows": rows,
        "row_count": len(rows),
    }


def preview_preparation_graph(
    db: Session,
    project_id: int,
    graph: DatasetPreparationGraph | dict[str, Any],
    *,
    node_id: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Strict-validate, resolve sampled sources, execute, return preview payload.

    Read-only: does not create versions, runs, run inputs, or dataset versions.
    """
    # Structural/config failures are 400. Latest-resolution conflicts come from
    # resolve_source_pins as 409 (same contract as run snapshot creation).
    validation = validate_preparation_graph(
        db, project_id, graph, strict=True, resolve_latest=False
    )
    if not validation["valid"]:
        raise PreparationValidationError(validation["errors"], status_code=400)

    data = graph_to_dict(graph)
    node_ids = {
        str(node.get("id")).strip()
        for node in (data.get("nodes") or [])
        if isinstance(node, dict) and node.get("id")
    }
    if node_id is not None and node_id not in node_ids:
        raise PreparationExecutionError(
            f"Preview node '{node_id}' was not found in the graph."
        )

    pins = resolve_source_pins(db, project_id, graph)

    warnings = [PREVIEW_WARNING]
    source_frames: dict[str, pd.DataFrame] = {}
    source_versions: list[dict[str, Any]] = []

    for pin in pins:
        version = db.get(DatasetVersion, pin["dataset_version_id"])
        if version is None or version.project_id != project_id:
            raise PreparationExecutionError(
                f"Dataset version for source node '{pin['node_id']}' was not found.",
                status_code=404,
            )
        columns = _loads(version.columns_json, [])
        if not isinstance(columns, list):
            columns = []
        preview_rows = _loads(version.preview_json, [])
        if not isinstance(preview_rows, list):
            preview_rows = []
        source_frames[pin["node_id"]] = frame_from_preview(
            columns=[str(col) for col in columns],
            preview_rows=preview_rows,
        )
        source_versions.append(
            {
                "node_id": pin["node_id"],
                "dataset_id": pin["dataset_id"],
                "dataset_version_id": pin["dataset_version_id"],
                "version_strategy": pin["version_strategy"],
            }
        )
        if int(version.row_count or 0) > len(preview_rows):
            warnings.append(
                f"Source '{pin['node_id']}' has {version.row_count} rows but preview "
                f"uses at most {PREVIEW_SOURCE_ROW_CAP} sampled rows."
            )

    result_frame = execute_preparation_graph(
        graph, source_frames, target_node_id=node_id
    )

    effective_node_id = node_id
    if effective_node_id is None:
        outputs = [
            str(node["id"]).strip()
            for node in (data.get("nodes") or [])
            if isinstance(node, dict) and node.get("type") == "output" and node.get("id")
        ]
        effective_node_id = outputs[0] if outputs else None

    if _preview_path_includes_group_by(
        data.get("nodes") or [],
        data.get("edges") or [],
        effective_node_id,
    ):
        warnings.append(PREVIEW_GROUP_BY_WARNING)

    payload = dataframe_preview_payload(result_frame, limit=limit)
    return {
        "node_id": effective_node_id,
        **payload,
        "sampled": True,
        "source_row_cap": PREVIEW_SOURCE_ROW_CAP,
        "source_versions": source_versions,
        "warnings": warnings,
    }
