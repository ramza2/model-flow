import { describe, expect, it, vi } from "vitest";
import { centerFlowOnMiniMapNode, centerFlowOnMiniMapPoint } from "./flowMiniMapNav";

describe("flowMiniMapNav", () => {
  it("centers on a MiniMap click point while preserving zoom", () => {
    const setCenter = vi.fn();
    centerFlowOnMiniMapPoint({ setCenter, getZoom: () => 1.25 }, { x: 320, y: 180 });
    expect(setCenter).toHaveBeenCalledWith(320, 180, { zoom: 1.25, duration: 200 });
  });

  it("centers on a MiniMap node midpoint while preserving zoom", () => {
    const setCenter = vi.fn();
    centerFlowOnMiniMapNode(
      { setCenter, getZoom: () => 0.9 },
      { position: { x: 100, y: 40 }, width: 200, height: 80 },
    );
    expect(setCenter).toHaveBeenCalledWith(200, 80, { zoom: 0.9, duration: 200 });
  });

  it("no-ops when the flow instance is missing", () => {
    expect(() => centerFlowOnMiniMapPoint(null, { x: 1, y: 2 })).not.toThrow();
    expect(() =>
      centerFlowOnMiniMapNode(undefined, { position: { x: 0, y: 0 } }),
    ).not.toThrow();
  });
});
