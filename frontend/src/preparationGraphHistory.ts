/** In-memory undo/redo snapshots for the Preparation graph canvas (presentation/editing only). */

export const PREPARATION_GRAPH_HISTORY_LIMIT = 50;

export type PrepGraphNodeSnapshot = {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    node_type: string;
    config: Record<string, unknown>;
  };
};

export type PrepGraphEdgeSnapshot = {
  id: string;
  source: string;
  target: string;
  targetHandle?: string | null;
  label?: string;
};

export type PrepGraphSnapshot = {
  nodes: PrepGraphNodeSnapshot[];
  edges: PrepGraphEdgeSnapshot[];
};

export type PrepGraphHistoryState = {
  past: PrepGraphSnapshot[];
  future: PrepGraphSnapshot[];
};

type SnapshotNodeInput = {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    node_type: string;
    config: Record<string, unknown>;
  };
};

type SnapshotEdgeInput = {
  id: string;
  source: string;
  target: string;
  targetHandle?: string | null;
  label?: unknown;
};

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(config || {});
}

export function capturePrepGraphSnapshot(
  nodes: SnapshotNodeInput[],
  edges: SnapshotEdgeInput[],
): PrepGraphSnapshot {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      position: { x: node.position.x, y: node.position.y },
      data: {
        label: node.data.label,
        node_type: node.data.node_type,
        config: cloneConfig(node.data.config),
      },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      ...(typeof edge.label === "string" ? { label: edge.label } : {}),
    })),
  };
}

function normalizeSnapshot(snapshot: PrepGraphSnapshot): PrepGraphSnapshot {
  return {
    nodes: [...snapshot.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => ({
        id: node.id,
        position: { x: node.position.x, y: node.position.y },
        data: {
          label: node.data.label,
          node_type: node.data.node_type,
          config: node.data.config,
        },
      })),
    edges: [...snapshot.edges]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
        ...(edge.label ? { label: edge.label } : {}),
      })),
  };
}

export function prepGraphSnapshotsEqual(
  left: PrepGraphSnapshot | null | undefined,
  right: PrepGraphSnapshot | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right));
}

export function createEmptyPrepGraphHistory(): PrepGraphHistoryState {
  return { past: [], future: [] };
}

export function pushPrepGraphHistory(
  history: PrepGraphHistoryState,
  previous: PrepGraphSnapshot,
  limit: number = PREPARATION_GRAPH_HISTORY_LIMIT,
): PrepGraphHistoryState {
  const past = [...history.past, previous];
  if (past.length > limit) {
    past.splice(0, past.length - limit);
  }
  return { past, future: [] };
}

export function undoPrepGraphHistory(
  history: PrepGraphHistoryState,
  current: PrepGraphSnapshot,
): { history: PrepGraphHistoryState; snapshot: PrepGraphSnapshot } | null {
  if (history.past.length === 0) return null;
  const past = [...history.past];
  const snapshot = past.pop()!;
  return {
    history: { past, future: [current, ...history.future] },
    snapshot,
  };
}

export function redoPrepGraphHistory(
  history: PrepGraphHistoryState,
  current: PrepGraphSnapshot,
): { history: PrepGraphHistoryState; snapshot: PrepGraphSnapshot } | null {
  if (history.future.length === 0) return null;
  const [snapshot, ...future] = history.future;
  return {
    history: { past: [...history.past, current], future },
    snapshot,
  };
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
