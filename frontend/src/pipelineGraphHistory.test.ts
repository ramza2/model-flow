import { describe, expect, it } from "vitest";
import {
  PIPELINE_GRAPH_HISTORY_LIMIT,
  capturePipelineGraphSnapshot,
  createEmptyPipelineGraphHistory,
  pipelineGraphSnapshotsEqual,
  pushPipelineGraphHistory,
  redoPipelineGraphHistory,
  undoPipelineGraphHistory,
} from "./pipelineGraphHistory";

const base = capturePipelineGraphSnapshot(
  [
    {
      id: "condition-1",
      position: { x: 0, y: 0 },
      data: { label: "Condition", node_type: "condition", config: { expression: "x > 0" } },
    },
    {
      id: "training-1",
      position: { x: 200, y: 0 },
      data: { label: "Training", node_type: "training", config: { algorithm: "ridge" } },
    },
  ],
  [
    {
      id: "e-true",
      source: "condition-1",
      target: "training-1",
      sourceHandle: "true",
      label: "TRUE",
      data: { branch: "true" },
    },
  ],
);

describe("pipelineGraphHistory", () => {
  it("pushes, undoes, redoes, and discards redo on new edits", () => {
    let history = createEmptyPipelineGraphHistory();
    const edited = capturePipelineGraphSnapshot(
      [
        ...base.nodes,
        {
          id: "evaluation-1",
          position: { x: 400, y: 0 },
          data: { label: "Evaluation", node_type: "evaluation", config: { metric: "accuracy" } },
        },
      ],
      base.edges,
    );
    history = pushPipelineGraphHistory(history, base);
    const undone = undoPipelineGraphHistory(history, edited);
    expect(undone?.snapshot).toEqual(base);
    history = undone!.history;
    const redone = redoPipelineGraphHistory(history, base);
    expect(redone?.snapshot).toEqual(edited);
    history = pushPipelineGraphHistory(redone!.history, edited);
    expect(history.future).toEqual([]);
    expect(history.past).toHaveLength(2);
    expect(history.past[0]).toEqual(base);
    expect(history.past[1]).toEqual(edited);
  });

  it("preserves condition branch metadata in snapshots", () => {
    expect(base.edges[0]).toMatchObject({
      sourceHandle: "true",
      label: "TRUE",
      data: { branch: "true" },
    });
    const moved = capturePipelineGraphSnapshot(
      base.nodes.map((node) =>
        node.id === "training-1"
          ? { ...node, position: { x: 240, y: 40 } }
          : node,
      ),
      base.edges,
    );
    expect(pipelineGraphSnapshotsEqual(base, moved)).toBe(false);
    expect(moved.edges[0].data?.branch).toBe("true");
    expect(moved.edges[0].sourceHandle).toBe("true");
  });

  it("caps history at the configured limit", () => {
    let history = createEmptyPipelineGraphHistory();
    let current = base;
    for (let index = 0; index < PIPELINE_GRAPH_HISTORY_LIMIT + 5; index += 1) {
      const next = capturePipelineGraphSnapshot(
        current.nodes.map((node) => ({
          ...node,
          position: { x: node.position.x + 1, y: node.position.y },
        })),
        current.edges,
      );
      history = pushPipelineGraphHistory(history, current);
      current = next;
    }
    expect(history.past).toHaveLength(PIPELINE_GRAPH_HISTORY_LIMIT);
  });

  it("treats identical graphs as equal even when edge order differs", () => {
    const shuffled = {
      nodes: [...base.nodes].reverse(),
      edges: [...base.edges],
    };
    expect(pipelineGraphSnapshotsEqual(base, shuffled)).toBe(true);
  });
});
