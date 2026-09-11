"""Reusable Dataset Preparation graph DataFrame operations.

Phase 2-B uses sampled source frames (DatasetVersion.preview_json).
Phase 2-C can reuse execute_preparation_graph() with full frames.
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
    JOIN_HOWS,
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


def _execute_join(
    node_id: str,
    config: dict[str, Any],
    left: pd.DataFrame,
    right: pd.DataFrame,
) -> pd.DataFrame:
    how = config.get("how")
    if how not in JOIN_HOWS:
        raise PreparationExecutionError(
            f"Join preview could not run because join type on '{node_id}' is invalid."
        )
    left_on = config.get("left_on") or []
    right_on = config.get("right_on") or []
    if not isinstance(left_on, list) or not isinstance(right_on, list):
        raise PreparationExecutionError(
            f"Join preview could not run because keys on '{node_id}' are invalid."
        )
    left_keys = [str(item).strip() for item in left_on]
    right_keys = [str(item).strip() for item in right_on]
    for key in left_keys:
        if key not in left.columns:
            raise PreparationExecutionError(
                f"Join preview could not run because column '{key}' is missing from the left input."
            )
    for key in right_keys:
        if key not in right.columns:
            raise PreparationExecutionError(
                f"Join preview could not run because column '{key}' is missing from the right input."
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
            f"Union preview could not run because mode on '{node_id}' is invalid."
        )
    if len(frames) < 2:
        raise PreparationExecutionError(
            f"Union preview could not run because '{node_id}' needs at least two inputs."
        )
    if mode == "strict":
        first_cols = list(frames[0].columns)
        for idx, frame in enumerate(frames[1:], start=2):
            if list(frame.columns) != first_cols:
                raise PreparationExecutionError(
                    f"Union preview could not run because input schemas on '{node_id}' "
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


def execute_preparation_graph(
    graph: DatasetPreparationGraph | dict[str, Any],
    source_frames: dict[str, pd.DataFrame],
    *,
    target_node_id: str | None = None,
) -> pd.DataFrame:
    """Execute Source/Join/Union/Output operations on provided frames."""
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
                    f"Join preview could not run because '{node_id}' needs left and right inputs."
                )
            left_frame = results.get(left_edge["source"])
            right_frame = results.get(right_edge["source"])
            if left_frame is None or right_frame is None:
                raise PreparationExecutionError(
                    f"Join preview could not run because inputs for '{node_id}' are not ready."
                )
            results[node_id] = _execute_join(node_id, config, left_frame, right_frame)
        elif node_type == "union":
            frames: list[pd.DataFrame] = []
            for edge in incoming:
                frame = results.get(edge["source"])
                if frame is None:
                    raise PreparationExecutionError(
                        f"Union preview could not run because an input for '{node_id}' is not ready."
                    )
                frames.append(frame)
            results[node_id] = _execute_union(node_id, config, frames)
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

    payload = dataframe_preview_payload(result_frame, limit=limit)
    return {
        "node_id": effective_node_id,
        **payload,
        "sampled": True,
        "source_row_cap": PREVIEW_SOURCE_ROW_CAP,
        "source_versions": source_versions,
        "warnings": warnings,
    }
