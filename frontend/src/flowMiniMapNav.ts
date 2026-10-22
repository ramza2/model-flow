/** Shared MiniMap click-to-center helpers (viewport navigation only — not graph edits). */

export type FlowViewportApi = {
  setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
  getZoom: () => number;
};

export type FlowMiniMapPoint = { x: number; y: number };

export type FlowMiniMapNodeLike = {
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
};

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 80;
const CENTER_DURATION_MS = 200;

/** Center the viewport on a flow-space point from MiniMap onClick, keeping current zoom. */
export function centerFlowOnMiniMapPoint(
  instance: FlowViewportApi | null | undefined,
  position: FlowMiniMapPoint,
  options?: { duration?: number },
): void {
  if (!instance) return;
  instance.setCenter(position.x, position.y, {
    zoom: instance.getZoom(),
    duration: options?.duration ?? CENTER_DURATION_MS,
  });
}

/** Center the viewport on a node's midpoint from MiniMap onNodeClick, keeping current zoom. */
export function centerFlowOnMiniMapNode(
  instance: FlowViewportApi | null | undefined,
  node: FlowMiniMapNodeLike,
  options?: { duration?: number },
): void {
  if (!instance) return;
  const width =
    (typeof node.measured?.width === "number" && node.measured.width) ||
    (typeof node.width === "number" && node.width) ||
    DEFAULT_NODE_WIDTH;
  const height =
    (typeof node.measured?.height === "number" && node.measured.height) ||
    (typeof node.height === "number" && node.height) ||
    DEFAULT_NODE_HEIGHT;
  instance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
    zoom: instance.getZoom(),
    duration: options?.duration ?? CENTER_DURATION_MS,
  });
}
