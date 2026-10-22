/** In-memory undo/redo snapshots for the Pipeline Builder graph (presentation/editing only). */

export const PIPELINE_GRAPH_HISTORY_LIMIT = 50;

export type PipelineGraphNodeSnapshot = {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    node_type: string;
    config: Record<string, unknown>;
  };
};

export type PipelineGraphEdgeSnapshot = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  data?: { branch?: string; [key: string]: unknown };
};

export type PipelineGraphSnapshot = {
  nodes: PipelineGraphNodeSnapshot[];
  edges: PipelineGraphEdgeSnapshot[];
};

export type PipelineGraphHistoryState = {
  past: PipelineGraphSnapshot[];
  future: PipelineGraphSnapshot[];
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
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: unknown;
  data?: { branch?: string; [key: string]: unknown } | null;
};

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(config || {});
}

export function capturePipelineGraphSnapshot(
  nodes: SnapshotNodeInput[],
  edges: SnapshotEdgeInput[],
): PipelineGraphSnapshot {
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
    edges: edges.map((edge) => {
      const branch =
        edge.data && typeof edge.data.branch === "string" ? edge.data.branch : undefined;
      const label =
        typeof edge.label === "string"
          ? edge.label
          : branch
            ? branch
            : undefined;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
        ...(label ? { label } : {}),
        ...(edge.data
          ? {
              data: {
                ...structuredClone(edge.data),
                ...(branch ? { branch } : {}),
              },
            }
          : branch
            ? { data: { branch } }
            : {}),
      };
    }),
  };
}

function normalizeSnapshot(snapshot: PipelineGraphSnapshot): PipelineGraphSnapshot {
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
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
        ...(edge.label ? { label: edge.label } : {}),
        ...(edge.data ? { data: edge.data } : {}),
      })),
  };
}

export function pipelineGraphSnapshotsEqual(
  left: PipelineGraphSnapshot | null | undefined,
  right: PipelineGraphSnapshot | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right));
}

export function createEmptyPipelineGraphHistory(): PipelineGraphHistoryState {
  return { past: [], future: [] };
}

export function pushPipelineGraphHistory(
  history: PipelineGraphHistoryState,
  previous: PipelineGraphSnapshot,
  limit: number = PIPELINE_GRAPH_HISTORY_LIMIT,
): PipelineGraphHistoryState {
  const past = [...history.past, previous];
  if (past.length > limit) {
    past.splice(0, past.length - limit);
  }
  return { past, future: [] };
}

export function undoPipelineGraphHistory(
  history: PipelineGraphHistoryState,
  current: PipelineGraphSnapshot,
): { history: PipelineGraphHistoryState; snapshot: PipelineGraphSnapshot } | null {
  if (history.past.length === 0) return null;
  const past = [...history.past];
  const snapshot = past.pop()!;
  return {
    history: { past, future: [current, ...history.future] },
    snapshot,
  };
}

export function redoPipelineGraphHistory(
  history: PipelineGraphHistoryState,
  current: PipelineGraphSnapshot,
): { history: PipelineGraphHistoryState; snapshot: PipelineGraphSnapshot } | null {
  if (history.future.length === 0) return null;
  const [snapshot, ...future] = history.future;
  return {
    history: { past: [...history.past, current], future },
    snapshot,
  };
}
