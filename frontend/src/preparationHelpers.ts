/** Pure helpers for Visual Dataset Preparation Builder. */

import type {
  DatasetPreparationEdge,
  DatasetPreparationGraph,
  DatasetPreparationNode,
  DatasetPreparationNodeType,
} from "./api";

export const PREPARATION_NODE_TYPES = ["source", "join", "union", "output"] as const;

export const PREPARATION_NODE_LIBRARY: {
  type: DatasetPreparationNodeType;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    type: "source",
    label: "Source",
    description: "Load a project dataset version into the graph.",
    icon: "▤",
  },
  {
    type: "join",
    label: "Join",
    description: "Join two inputs on matching keys.",
    icon: "⋈",
  },
  {
    type: "union",
    label: "Union",
    description: "Stack rows from two or more inputs.",
    icon: "⋃",
  },
  {
    type: "output",
    label: "Output",
    description: "Final prepared dataset for this graph.",
    icon: "◎",
  },
];

export type PreparationFlowNodeData = {
  label: string;
  node_type: DatasetPreparationNodeType;
  config: Record<string, unknown>;
};

export type PreparationFlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: PreparationFlowNodeData;
};

export type PreparationFlowEdge = {
  id: string;
  source: string;
  target: string;
  targetHandle?: string | null;
  label?: string;
};

export const PREPARATION_FLOW_NODE_TYPE = "preparationStep";

/** Map React Flow targetHandle → API target_port. Never expose targetHandle in API graphs. */
export function targetHandleToPort(
  targetHandle: string | null | undefined,
): string | null {
  if (targetHandle === "left" || targetHandle === "right") return targetHandle;
  return null;
}

/** Map API target_port → React Flow targetHandle. */
export function portToTargetHandle(
  targetPort: string | null | undefined,
): string | undefined {
  if (targetPort === "left" || targetPort === "right") return targetPort;
  return undefined;
}

export function defaultConfigForPreparation(
  type: DatasetPreparationNodeType,
): Record<string, unknown> {
  switch (type) {
    case "source":
      return { dataset_id: null, version_strategy: "latest" };
    case "join":
      return { how: "inner", left_on: [], right_on: [] };
    case "union":
      return { mode: "strict" };
    case "output":
      return {};
    default:
      return {};
  }
}

export function labelForPreparationType(type: DatasetPreparationNodeType | string): string {
  const match = PREPARATION_NODE_LIBRARY.find((item) => item.type === type);
  if (match) return match.label;
  return String(type).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Allocate a readable node id that never collides with existing graph ids. */
export function nextPreparationNodeId(
  nodeType: DatasetPreparationNodeType | string,
  existingIds: Iterable<string>,
): string {
  const used = new Set(existingIds);
  const prefix = `${nodeType}-`;
  let max = 0;
  for (const id of used) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (/^\d+$/.test(rest)) {
      const value = Number(rest);
      if (value > max) max = value;
    }
  }
  let next = max + 1;
  let candidate = `${prefix}${next}`;
  while (used.has(candidate)) {
    next += 1;
    candidate = `${prefix}${next}`;
  }
  return candidate;
}

export function staggerPreparationPosition(index: number): { x: number; y: number } {
  return {
    x: 80 + (index % 3) * 240,
    y: 80 + Math.floor(index / 3) * 160,
  };
}

function asConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function apiGraphToFlow(graph: DatasetPreparationGraph | null | undefined): {
  nodes: PreparationFlowNode[];
  edges: PreparationFlowEdge[];
} {
  const rawNodes = graph?.nodes || [];
  const nodes: PreparationFlowNode[] = rawNodes.map((node, index) => {
    const nodeType = (PREPARATION_NODE_TYPES.includes(
      node.type as DatasetPreparationNodeType,
    )
      ? node.type
      : "source") as DatasetPreparationNodeType;
    const position =
      node.position && typeof node.position.x === "number" && typeof node.position.y === "number"
        ? { x: node.position.x, y: node.position.y }
        : staggerPreparationPosition(index);
    return {
      id: node.id,
      type: PREPARATION_FLOW_NODE_TYPE,
      position,
      data: {
        label: labelForPreparationType(nodeType),
        node_type: nodeType,
        config: asConfig(node.config),
      },
    };
  });

  const edges: PreparationFlowEdge[] = (graph?.edges || []).map((edge, index) => {
    const targetHandle = portToTargetHandle(edge.target_port);
    return {
      id: edge.id || `edge-${index}`,
      source: edge.source,
      target: edge.target,
      ...(targetHandle ? { targetHandle } : {}),
      ...(targetHandle ? { label: targetHandle.toUpperCase() } : {}),
    };
  });

  return { nodes, edges };
}

export function flowToApiGraph(
  nodes: PreparationFlowNode[],
  edges: PreparationFlowEdge[],
): DatasetPreparationGraph {
  const apiNodes: DatasetPreparationNode[] = nodes.map((node) => ({
    id: node.id,
    type: node.data.node_type,
    config: asConfig(node.data.config),
    position: {
      x: node.position.x,
      y: node.position.y,
    },
  }));

  const apiEdges: DatasetPreparationEdge[] = edges.map((edge, index) => {
    const targetPort = targetHandleToPort(edge.targetHandle);
    return {
      id: edge.id || `edge-${index + 1}`,
      source: edge.source,
      target: edge.target,
      ...(targetPort ? { target_port: targetPort } : { target_port: null }),
    };
  });

  return {
    schema_version: 1,
    nodes: apiNodes,
    edges: apiEdges,
  };
}

export function preparationConfigSummary(
  nodeType: DatasetPreparationNodeType | string,
  config: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  switch (nodeType) {
    case "source":
      if (config.dataset_id != null && config.dataset_id !== "") {
        lines.push(`Dataset #${config.dataset_id}`);
      } else {
        lines.push("Dataset not selected");
      }
      lines.push(config.version_strategy === "fixed" ? "Fixed version" : "Latest version");
      if (config.version_strategy === "fixed" && config.dataset_version_id != null) {
        lines.push(`Version id ${config.dataset_version_id}`);
      }
      break;
    case "join": {
      lines.push(String(config.how || "inner"));
      const left = Array.isArray(config.left_on) ? config.left_on : [];
      const right = Array.isArray(config.right_on) ? config.right_on : [];
      if (left.length || right.length) {
        lines.push(`${left.join(", ") || "?"} = ${right.join(", ") || "?"}`);
      } else {
        lines.push("Keys not set");
      }
      break;
    }
    case "union":
      lines.push(config.mode === "align_by_name" ? "Align by name" : "Strict");
      break;
    case "output":
      lines.push("Prepared output");
      break;
    default:
      break;
  }
  return lines;
}

/** Parse comma / newline separated key lists for join inspectors. */
export function parseKeyList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatKeyList(keys: unknown): string {
  if (!Array.isArray(keys)) return "";
  return keys.map(String).filter(Boolean).join(", ");
}

export function emptyPreparationGraph(): DatasetPreparationGraph {
  return { schema_version: 1, nodes: [], edges: [] };
}
