/** Pure helpers for Visual Dataset Preparation Builder. */

import type {
  DatasetPreparationEdge,
  DatasetPreparationGraph,
  DatasetPreparationNode,
  DatasetPreparationNodeType,
} from "./api";

export const PREPARATION_NODE_TYPES = [
  "source",
  "join",
  "union",
  "select",
  "drop",
  "rename",
  "filter",
  "cast",
  "deduplicate",
  "fill_constant",
  "derived_column",
  "output",
] as const satisfies readonly DatasetPreparationNodeType[];

export const PREPARATION_TRANSFORM_TYPES = [
  "select",
  "drop",
  "rename",
  "filter",
  "cast",
  "deduplicate",
  "fill_constant",
  "derived_column",
] as const satisfies readonly DatasetPreparationNodeType[];

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "not_null",
  "in",
] as const;

export const FILTER_NULLARY_OPS = new Set(["is_null", "not_null"]);

export const CAST_TYPES = ["integer", "float", "string", "boolean", "datetime"] as const;

export const DERIVED_OPERATIONS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "concat",
] as const;

export type PreparationLibraryItem = {
  type: DatasetPreparationNodeType;
  label: string;
  description: string;
  icon: string;
};

export type PreparationLibraryGroup = {
  id: string;
  label: string;
  items: PreparationLibraryItem[];
};

const SOURCE_COMBINE_ITEMS: PreparationLibraryItem[] = [
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
];

const TRANSFORM_ITEMS: PreparationLibraryItem[] = [
  {
    type: "select",
    label: "Select",
    description: "Keep only the listed columns.",
    icon: "⊂",
  },
  {
    type: "drop",
    label: "Drop",
    description: "Remove the listed columns.",
    icon: "⊖",
  },
  {
    type: "rename",
    label: "Rename",
    description: "Rename columns with old = new mappings.",
    icon: "✎",
  },
  {
    type: "filter",
    label: "Filter",
    description: "Keep rows that match conditions.",
    icon: "▽",
  },
  {
    type: "cast",
    label: "Cast",
    description: "Convert column types.",
    icon: "Τ",
  },
  {
    type: "deduplicate",
    label: "Deduplicate",
    description: "Drop duplicate rows by key columns.",
    icon: "≡",
  },
  {
    type: "fill_constant",
    label: "Fill",
    description: "Fill missing values with constants.",
    icon: "◈",
  },
  {
    type: "derived_column",
    label: "Derived",
    description: "Add a column from an arithmetic or concat expression.",
    icon: "ƒ",
  },
];

const OUTPUT_ITEMS: PreparationLibraryItem[] = [
  {
    type: "output",
    label: "Output",
    description: "Final prepared dataset for this graph.",
    icon: "◎",
  },
];

/** Flat library list (all node types). Prefer PREPARATION_NODE_LIBRARY_GROUPS in the builder. */
export const PREPARATION_NODE_LIBRARY: PreparationLibraryItem[] = [
  ...SOURCE_COMBINE_ITEMS,
  ...TRANSFORM_ITEMS,
  ...OUTPUT_ITEMS,
];

export const PREPARATION_NODE_LIBRARY_GROUPS: PreparationLibraryGroup[] = [
  { id: "sources", label: "Sources & Combine", items: SOURCE_COMBINE_ITEMS },
  { id: "transform", label: "Transform", items: TRANSFORM_ITEMS },
  { id: "output", label: "Output", items: OUTPUT_ITEMS },
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

export type FilterCondition = {
  column: string;
  operator: string;
  value?: unknown;
};

export type DerivedOperand = {
  kind: "column" | "literal";
  value: string | number | boolean;
};

export type FillValueKind = "string" | "number" | "boolean";

export type FillValueRow = {
  column: string;
  kind: FillValueKind;
  value: string;
};

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

export function isPreparationTransformType(
  type: DatasetPreparationNodeType | string,
): boolean {
  return (PREPARATION_TRANSFORM_TYPES as readonly string[]).includes(type);
}

export function isPreparationRunActive(status: string | null | undefined): boolean {
  const value = String(status || "").toLowerCase();
  return value === "queued" || value === "running";
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
    case "select":
      return { columns: [] };
    case "drop":
      return { columns: [] };
    case "rename":
      return { mapping: {} };
    case "filter":
      return { combine: "and", conditions: [] };
    case "cast":
      return { casts: {} };
    case "deduplicate":
      return { columns: [], keep: "first" };
    case "fill_constant":
      return { values: {} };
    case "derived_column":
      return {
        name: "",
        operation: "add",
        left: { kind: "column", value: "" },
        right: { kind: "literal", value: 0 },
      };
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

function asNodeType(value: unknown): DatasetPreparationNodeType {
  if (typeof value === "string" && (PREPARATION_NODE_TYPES as readonly string[]).includes(value)) {
    return value as DatasetPreparationNodeType;
  }
  return "source";
}

export function apiGraphToFlow(graph: DatasetPreparationGraph | null | undefined): {
  nodes: PreparationFlowNode[];
  edges: PreparationFlowEdge[];
} {
  const rawNodes = graph?.nodes || [];
  const nodes: PreparationFlowNode[] = rawNodes.map((node, index) => {
    const nodeType = asNodeType(node.type);
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
    case "select": {
      const columns = Array.isArray(config.columns) ? config.columns : [];
      lines.push(columns.length ? columns.map(String).join(", ") : "No columns");
      break;
    }
    case "drop": {
      const columns = Array.isArray(config.columns) ? config.columns : [];
      lines.push(columns.length ? `Drop ${columns.map(String).join(", ")}` : "No columns");
      break;
    }
    case "rename": {
      const mapping =
        config.mapping && typeof config.mapping === "object" && !Array.isArray(config.mapping)
          ? (config.mapping as Record<string, unknown>)
          : {};
      const count = Object.keys(mapping).length;
      lines.push(count ? `${count} rename${count === 1 ? "" : "s"}` : "No renames");
      break;
    }
    case "filter": {
      const conditions = Array.isArray(config.conditions) ? config.conditions : [];
      lines.push(String(config.combine || "and").toUpperCase());
      lines.push(
        conditions.length
          ? `${conditions.length} condition${conditions.length === 1 ? "" : "s"}`
          : "No conditions",
      );
      break;
    }
    case "cast": {
      const casts =
        config.casts && typeof config.casts === "object" && !Array.isArray(config.casts)
          ? (config.casts as Record<string, unknown>)
          : {};
      const count = Object.keys(casts).length;
      lines.push(count ? `${count} cast${count === 1 ? "" : "s"}` : "No casts");
      break;
    }
    case "deduplicate": {
      const columns = Array.isArray(config.columns) ? config.columns : [];
      lines.push(config.keep === "last" ? "Keep last" : "Keep first");
      lines.push(columns.length ? columns.map(String).join(", ") : "All columns");
      break;
    }
    case "fill_constant": {
      const values =
        config.values && typeof config.values === "object" && !Array.isArray(config.values)
          ? (config.values as Record<string, unknown>)
          : {};
      const count = Object.keys(values).length;
      lines.push(count ? `${count} fill${count === 1 ? "" : "s"}` : "No fills");
      break;
    }
    case "derived_column": {
      const name = String(config.name || "").trim();
      lines.push(name || "Unnamed column");
      lines.push(String(config.operation || "add"));
      break;
    }
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

/** Parse rename lines: `old = new` (one per line; also tolerates `old: new`). */
export function parseRenameMapping(text: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(.+?)\s*(?:=|:)\s*(.+)$/.exec(line);
    if (!match) continue;
    const from = match[1].trim();
    const to = match[2].trim();
    if (from && to) mapping[from] = to;
  }
  return mapping;
}

export function formatRenameMapping(mapping: unknown): string {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return "";
  return Object.entries(mapping as Record<string, unknown>)
    .map(([from, to]) => `${from} = ${String(to ?? "")}`)
    .join("\n");
}

export function parseFilterConditions(value: unknown): FilterCondition[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    return {
      column: String(row.column ?? ""),
      operator: String(row.operator ?? "eq"),
      ...(FILTER_NULLARY_OPS.has(String(row.operator ?? "eq"))
        ? {}
        : { value: row.value }),
    };
  });
}

export function serializeFilterConditions(
  conditions: FilterCondition[],
  combine: "and" | "or" = "and",
): { combine: "and" | "or"; conditions: FilterCondition[] } {
  return {
    combine,
    conditions: conditions.map((condition) => {
      if (FILTER_NULLARY_OPS.has(condition.operator)) {
        return { column: condition.column, operator: condition.operator };
      }
      if (condition.operator === "in") {
        const list = Array.isArray(condition.value)
          ? condition.value
          : parseKeyList(String(condition.value ?? ""));
        return { column: condition.column, operator: "in", value: list };
      }
      return {
        column: condition.column,
        operator: condition.operator,
        value: condition.value ?? "",
      };
    }),
  };
}

export function parseCasts(value: unknown): Array<{ column: string; dtype: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([column, dtype]) => ({
    column,
    dtype: String(dtype ?? "string"),
  }));
}

export function serializeCasts(
  rows: Array<{ column: string; dtype: string }>,
): Record<string, string> {
  const casts: Record<string, string> = {};
  for (const row of rows) {
    const column = row.column.trim();
    if (!column) continue;
    casts[column] = row.dtype || "string";
  }
  return casts;
}

function detectFillKind(value: unknown): FillValueKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

export function parseFillValues(value: unknown): FillValueRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([column, fill]) => ({
    column,
    kind: detectFillKind(fill),
    value: String(fill ?? ""),
  }));
}

export function serializeFillValues(rows: FillValueRow[]): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const row of rows) {
    const column = row.column.trim();
    if (!column) continue;
    if (row.kind === "boolean") {
      values[column] = row.value === "true" || row.value === "1";
    } else if (row.kind === "number") {
      const number = Number(row.value);
      values[column] = Number.isFinite(number) ? number : 0;
    } else {
      values[column] = row.value;
    }
  }
  return values;
}

export function parseDerivedOperand(value: unknown, fallback: DerivedOperand): DerivedOperand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const row = value as Record<string, unknown>;
  const kind = row.kind === "literal" ? "literal" : "column";
  if (kind === "literal") {
    const raw = row.value;
    if (typeof raw === "boolean" || typeof raw === "number") {
      return { kind, value: raw };
    }
    return { kind, value: raw == null ? "" : String(raw) };
  }
  return { kind: "column", value: String(row.value ?? "") };
}

export function emptyPreparationGraph(): DatasetPreparationGraph {
  return { schema_version: 1, nodes: [], edges: [] };
}

/** Dataset ids referenced by source nodes in the current graph (for output warnings). */
export function sourceDatasetIdsInGraph(
  nodes: Array<{ data: { node_type: string; config: Record<string, unknown> } }>,
): Set<number> {
  const ids = new Set<number>();
  for (const node of nodes) {
    if (node.data.node_type !== "source") continue;
    const raw = node.data.config.dataset_id;
    if (raw == null || raw === "") continue;
    const id = Number(raw);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}
