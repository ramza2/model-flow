"""Dataset Preparation graph validation and source pinning (Phase 2-A foundation).

No transformation execution or materialization — validation and RunInput pinning only.
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import models
from app.schemas.v1 import DatasetPreparationGraph

NODE_TYPES = frozenset({"source", "join", "union", "output"})
VERSION_STRATEGIES = frozenset({"fixed", "latest"})
JOIN_HOWS = frozenset({"inner", "left", "right", "full"})
UNION_MODES = frozenset({"strict", "align_by_name"})


class PreparationValidationError(Exception):
    """Raised when graph validation fails with HTTP-mappable messages."""

    def __init__(self, errors: list[str], *, status_code: int = 400) -> None:
        self.errors = errors
        self.status_code = status_code
        super().__init__("; ".join(errors))


def parse_graph_json(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {"schema_version": 1, "nodes": [], "edges": []}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"schema_version": 1, "nodes": [], "edges": []}
    if not isinstance(data, dict):
        return {"schema_version": 1, "nodes": [], "edges": []}
    return data


def graph_to_dict(graph: DatasetPreparationGraph | dict[str, Any]) -> dict[str, Any]:
    if isinstance(graph, DatasetPreparationGraph):
        return graph.model_dump()
    return dict(graph)


def find_preparation_by_name(
    db: Session,
    project_id: int,
    name: str,
    *,
    exclude_id: int | None = None,
) -> models.DatasetPreparation | None:
    query = db.query(models.DatasetPreparation).filter(
        models.DatasetPreparation.project_id == project_id,
        func.lower(models.DatasetPreparation.name) == name.strip().lower(),
    )
    if exclude_id is not None:
        query = query.filter(models.DatasetPreparation.id != exclude_id)
    return query.first()


def _has_cycle(nodes: dict[str, dict], edges: list[dict]) -> bool:
    adjacency: dict[str, list[str]] = defaultdict(list)
    indegree: dict[str, int] = {node_id: 0 for node_id in nodes}
    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source not in nodes or target not in nodes:
            continue
        adjacency[source].append(target)
        indegree[target] = indegree.get(target, 0) + 1
        indegree.setdefault(source, indegree.get(source, 0))
    queue: deque[str] = deque(
        [node_id for node_id, degree in indegree.items() if degree == 0]
    )
    seen = 0
    while queue:
        current = queue.popleft()
        seen += 1
        for nxt in adjacency[current]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    return seen != len(nodes)


def _reachable_to_outputs(nodes: dict[str, dict], edges: list[dict]) -> set[str]:
    reverse: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        reverse[edge["target"]].append(edge["source"])
    outputs = [
        node_id for node_id, node in nodes.items() if node.get("type") == "output"
    ]
    seen: set[str] = set()
    queue: deque[str] = deque(outputs)
    while queue:
        current = queue.popleft()
        if current in seen:
            continue
        seen.add(current)
        for parent in reverse[current]:
            if parent not in seen:
                queue.append(parent)
    return seen


def _validate_source_config(
    db: Session,
    project_id: int,
    node_id: str,
    config: dict[str, Any],
    *,
    resolve_latest: bool,
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(config, dict):
        return [f"source node '{node_id}': config must be an object"], warnings

    dataset_id = config.get("dataset_id")
    strategy = config.get("version_strategy")
    version_id = config.get("dataset_version_id")

    if dataset_id is None:
        errors.append(f"source node '{node_id}': dataset_id is required")
        return errors, warnings
    if not isinstance(dataset_id, int) or isinstance(dataset_id, bool):
        errors.append(f"source node '{node_id}': dataset_id must be an integer")
        return errors, warnings
    if strategy not in VERSION_STRATEGIES:
        errors.append(
            f"source node '{node_id}': version_strategy must be 'fixed' or 'latest'"
        )
        return errors, warnings

    dataset = (
        db.query(models.Dataset)
        .filter(
            models.Dataset.id == dataset_id,
            models.Dataset.project_id == project_id,
        )
        .first()
    )
    if dataset is None:
        errors.append(f"source node '{node_id}': dataset not found in this project")
        return errors, warnings

    if strategy == "fixed":
        if version_id is None:
            errors.append(
                f"source node '{node_id}': dataset_version_id is required when "
                "version_strategy is 'fixed'"
            )
            return errors, warnings
        if not isinstance(version_id, int) or isinstance(version_id, bool):
            errors.append(
                f"source node '{node_id}': dataset_version_id must be an integer"
            )
            return errors, warnings
        version = (
            db.query(models.DatasetVersion)
            .filter(
                models.DatasetVersion.id == version_id,
                models.DatasetVersion.project_id == project_id,
            )
            .first()
        )
        if version is None:
            errors.append(
                f"source node '{node_id}': dataset version not found in this project"
            )
            return errors, warnings
        if version.dataset_id != dataset_id:
            errors.append(
                f"source node '{node_id}': dataset_version_id does not belong to dataset_id"
            )
            return errors, warnings
    else:
        if version_id is not None:
            errors.append(
                f"source node '{node_id}': dataset_version_id must not be set when "
                "version_strategy is 'latest'"
            )
            return errors, warnings
        if resolve_latest:
            if not dataset.latest_version or dataset.latest_version < 1:
                errors.append(
                    f"source node '{node_id}': dataset has no versions to resolve as latest"
                )
                return errors, warnings
            version = (
                db.query(models.DatasetVersion)
                .filter(
                    models.DatasetVersion.dataset_id == dataset_id,
                    models.DatasetVersion.project_id == project_id,
                    models.DatasetVersion.version == dataset.latest_version,
                )
                .first()
            )
            if version is None:
                errors.append(
                    f"source node '{node_id}': latest dataset version row not found"
                )
                return errors, warnings

    return errors, warnings


def _validate_join_config(node_id: str, config: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(config, dict):
        return [f"join node '{node_id}': config must be an object"]
    how = config.get("how")
    if how not in JOIN_HOWS:
        errors.append(
            f"join node '{node_id}': how must be one of inner, left, right, full"
        )
    left_on = config.get("left_on")
    right_on = config.get("right_on")
    if not isinstance(left_on, list) or not left_on:
        errors.append(
            f"join node '{node_id}': left_on must be a non-empty list of strings"
        )
    elif any(not isinstance(item, str) or not item.strip() for item in left_on):
        errors.append(
            f"join node '{node_id}': left_on entries must be non-empty strings"
        )
    if not isinstance(right_on, list) or not right_on:
        errors.append(
            f"join node '{node_id}': right_on must be a non-empty list of strings"
        )
    elif any(not isinstance(item, str) or not item.strip() for item in right_on):
        errors.append(
            f"join node '{node_id}': right_on entries must be non-empty strings"
        )
    if (
        isinstance(left_on, list)
        and isinstance(right_on, list)
        and left_on
        and right_on
        and len(left_on) != len(right_on)
    ):
        errors.append(
            f"join node '{node_id}': left_on and right_on must have the same length"
        )
    return errors


def _validate_union_config(node_id: str, config: dict[str, Any]) -> list[str]:
    if not isinstance(config, dict):
        return [f"union node '{node_id}': config must be an object"]
    mode = config.get("mode")
    if mode not in UNION_MODES:
        return [f"union node '{node_id}': mode must be 'strict' or 'align_by_name'"]
    return []


def validate_preparation_graph(
    db: Session,
    project_id: int,
    graph: DatasetPreparationGraph | dict[str, Any],
    *,
    strict: bool,
    resolve_latest: bool = False,
) -> dict[str, Any]:
    """Validate a preparation graph.

    Structural / reference / config syntax errors are always errors.
    Incomplete topology is warnings when strict=False, errors when strict=True.
    """
    data = graph_to_dict(graph)
    errors: list[str] = []
    warnings: list[str] = []

    schema_version = data.get("schema_version", 1)
    if schema_version != 1:
        errors.append("schema_version must be 1")

    raw_nodes = data.get("nodes") or []
    raw_edges = data.get("edges") or []
    if not isinstance(raw_nodes, list):
        return {"valid": False, "errors": ["nodes must be a list"], "warnings": []}
    if not isinstance(raw_edges, list):
        return {"valid": False, "errors": ["edges must be a list"], "warnings": []}

    nodes: dict[str, dict] = {}
    seen_node_ids: set[str] = set()
    for node in raw_nodes:
        if not isinstance(node, dict):
            errors.append("each node must be an object")
            continue
        node_id = node.get("id")
        if not node_id or not isinstance(node_id, str) or not node_id.strip():
            errors.append("node id must be a non-empty string")
            continue
        node_id = node_id.strip()
        if node_id in seen_node_ids:
            errors.append(f"duplicate node id '{node_id}'")
            continue
        seen_node_ids.add(node_id)
        node_type = node.get("type")
        if node_type not in NODE_TYPES:
            errors.append(f"unknown node type '{node_type}' on node '{node_id}'")
        config = node.get("config") if isinstance(node.get("config"), dict) else {}
        nodes[node_id] = {"id": node_id, "type": node_type, "config": config}

    edges: list[dict] = []
    seen_edge_ids: set[str] = set()
    for edge in raw_edges:
        if not isinstance(edge, dict):
            errors.append("each edge must be an object")
            continue
        edge_id = edge.get("id")
        if not edge_id or not isinstance(edge_id, str) or not edge_id.strip():
            errors.append("edge id must be a non-empty string")
            continue
        edge_id = edge_id.strip()
        if edge_id in seen_edge_ids:
            errors.append(f"duplicate edge id '{edge_id}'")
            continue
        seen_edge_ids.add(edge_id)
        source = edge.get("source")
        target = edge.get("target")
        if not isinstance(source, str) or not source.strip():
            errors.append(f"edge '{edge_id}': source must be a non-empty string")
            continue
        if not isinstance(target, str) or not target.strip():
            errors.append(f"edge '{edge_id}': target must be a non-empty string")
            continue
        source, target = source.strip(), target.strip()
        if source not in nodes:
            errors.append(f"edge '{edge_id}': source node '{source}' not found")
            continue
        if target not in nodes:
            errors.append(f"edge '{edge_id}': target node '{target}' not found")
            continue
        if source == target:
            errors.append(f"edge '{edge_id}': self-edges are not allowed")
            continue
        port = edge.get("target_port")
        if port is not None and (not isinstance(port, str) or not port.strip()):
            errors.append(
                f"edge '{edge_id}': target_port must be a non-empty string when set"
            )
            continue
        edges.append(
            {
                "id": edge_id,
                "source": source,
                "target": target,
                "target_port": (
                    port.strip() if isinstance(port, str) and port.strip() else None
                ),
            }
        )

    if nodes and not errors and _has_cycle(nodes, edges):
        errors.append("graph contains a cycle")

    for node_id, node in nodes.items():
        node_type = node["type"]
        config = node["config"]
        if node_type == "source":
            source_errors, source_warnings = _validate_source_config(
                db,
                project_id,
                node_id,
                config,
                resolve_latest=resolve_latest or strict,
            )
            errors.extend(source_errors)
            warnings.extend(source_warnings)
        elif node_type == "join":
            errors.extend(_validate_join_config(node_id, config))
        elif node_type == "union":
            errors.extend(_validate_union_config(node_id, config))
        elif node_type == "output" and config:
            warnings.append(f"output node '{node_id}': config should be an empty object")

    incoming: dict[str, list[dict]] = defaultdict(list)
    outgoing: dict[str, list[dict]] = defaultdict(list)
    for edge in edges:
        incoming[edge["target"]].append(edge)
        outgoing[edge["source"]].append(edge)

    sources = [node_id for node_id, node in nodes.items() if node["type"] == "source"]
    outputs = [node_id for node_id, node in nodes.items() if node["type"] == "output"]

    def soft(message: str) -> None:
        if strict:
            errors.append(message)
        else:
            warnings.append(message)

    if not sources:
        soft("graph must have at least one source node")
    if len(outputs) != 1:
        soft("graph must have exactly one output node")

    if nodes and not _has_cycle(nodes, edges) and outputs:
        reachable = _reachable_to_outputs(nodes, edges)
        for node_id in nodes:
            if node_id not in reachable:
                soft(f"node '{node_id}' does not participate in the path to output")

    for node_id, node in nodes.items():
        node_type = node["type"]
        incoming_edges = incoming.get(node_id, [])
        outgoing_edges = outgoing.get(node_id, [])
        if node_type == "source" and incoming_edges:
            soft(f"source node '{node_id}' must not have incoming edges")
        if node_type == "output":
            if len(incoming_edges) != 1:
                soft(f"output node '{node_id}' must have exactly one incoming edge")
            if outgoing_edges:
                soft(f"output node '{node_id}' must not have outgoing edges")
        if node_type == "join":
            if len(incoming_edges) != 2:
                soft(f"join node '{node_id}' must have exactly 2 incoming edges")
            else:
                ports = [edge.get("target_port") for edge in incoming_edges]
                if ports.count("left") != 1 or ports.count("right") != 1:
                    soft(
                        f"join node '{node_id}' must have target_port 'left' and "
                        "'right' exactly once each"
                    )
                sources_for_join = {edge["source"] for edge in incoming_edges}
                if len(sources_for_join) < 2:
                    soft(
                        f"join node '{node_id}' left and right inputs must come from "
                        "different sources"
                    )
        if node_type == "union" and len(incoming_edges) < 2:
            soft(f"union node '{node_id}' must have at least 2 incoming edges")

    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def resolve_source_pins(
    db: Session,
    project_id: int,
    graph: DatasetPreparationGraph | dict[str, Any],
) -> list[dict[str, Any]]:
    """Resolve each source node to a concrete DatasetVersion pin."""
    result = validate_preparation_graph(
        db, project_id, graph, strict=True, resolve_latest=True
    )
    if not result["valid"]:
        raise PreparationValidationError(result["errors"], status_code=400)

    data = graph_to_dict(graph)
    pins: list[dict[str, Any]] = []
    for node in data.get("nodes") or []:
        if not isinstance(node, dict) or node.get("type") != "source":
            continue
        node_id = str(node["id"]).strip()
        config = node.get("config") or {}
        dataset_id = int(config["dataset_id"])
        strategy = str(config["version_strategy"])
        if strategy == "fixed":
            version_id = int(config["dataset_version_id"])
        else:
            dataset = (
                db.query(models.Dataset)
                .filter(
                    models.Dataset.id == dataset_id,
                    models.Dataset.project_id == project_id,
                )
                .first()
            )
            if dataset is None or not dataset.latest_version:
                raise PreparationValidationError(
                    [
                        f"source node '{node_id}': dataset has no versions to resolve "
                        "as latest"
                    ],
                    status_code=409,
                )
            version = (
                db.query(models.DatasetVersion)
                .filter(
                    models.DatasetVersion.dataset_id == dataset_id,
                    models.DatasetVersion.project_id == project_id,
                    models.DatasetVersion.version == dataset.latest_version,
                )
                .first()
            )
            if version is None:
                raise PreparationValidationError(
                    [f"source node '{node_id}': latest dataset version row not found"],
                    status_code=409,
                )
            version_id = version.id
        pins.append(
            {
                "node_id": node_id,
                "dataset_id": dataset_id,
                "dataset_version_id": version_id,
                "version_strategy": strategy,
            }
        )
    return pins
