import { describe, expect, it } from "vitest";
import {
  PREPARATION_GRAPH_HISTORY_LIMIT,
  capturePrepGraphSnapshot,
  createEmptyPrepGraphHistory,
  isEditableKeyboardTarget,
  prepGraphSnapshotsEqual,
  pushPrepGraphHistory,
  redoPrepGraphHistory,
  undoPrepGraphHistory,
} from "./preparationGraphHistory";

describe("preparationGraphHistory", () => {
  const base = capturePrepGraphSnapshot(
    [
      {
        id: "source-1",
        position: { x: 1, y: 2 },
        data: { label: "Source", node_type: "source", config: { dataset_id: 2 } },
      },
    ],
    [],
  );

  it("pushes, undoes, redoes, and discards redo on new edits", () => {
    let history = createEmptyPrepGraphHistory();
    const edited = capturePrepGraphSnapshot(
      [
        {
          id: "source-1",
          position: { x: 10, y: 20 },
          data: { label: "Source", node_type: "source", config: { dataset_id: 2 } },
        },
      ],
      [],
    );
    history = pushPrepGraphHistory(history, base);
    const undone = undoPrepGraphHistory(history, edited);
    expect(undone?.snapshot).toEqual(base);
    history = undone!.history;
    const redone = redoPrepGraphHistory(history, base);
    expect(redone?.snapshot).toEqual(edited);
    history = pushPrepGraphHistory(redone!.history, edited);
    expect(history.future).toEqual([]);
    expect(history.past[history.past.length - 1]).toEqual(edited);
  });

  it("caps history length and compares snapshots without order sensitivity", () => {
    let history = createEmptyPrepGraphHistory();
    for (let index = 0; index < PREPARATION_GRAPH_HISTORY_LIMIT + 5; index += 1) {
      history = pushPrepGraphHistory(
        history,
        capturePrepGraphSnapshot(
          [
            {
              id: "source-1",
              position: { x: index, y: 0 },
              data: { label: "Source", node_type: "source", config: {} },
            },
          ],
          [],
        ),
      );
    }
    expect(history.past).toHaveLength(PREPARATION_GRAPH_HISTORY_LIMIT);

    const left = capturePrepGraphSnapshot(
      [
        {
          id: "b",
          position: { x: 0, y: 0 },
          data: { label: "B", node_type: "filter", config: { combine: "and" } },
        },
        {
          id: "a",
          position: { x: 1, y: 1 },
          data: { label: "A", node_type: "source", config: {} },
        },
      ],
      [
        { id: "e2", source: "a", target: "b" },
        { id: "e1", source: "a", target: "b", targetHandle: "left", label: "LEFT" },
      ],
    );
    const right = capturePrepGraphSnapshot(
      [
        {
          id: "a",
          position: { x: 1, y: 1 },
          data: { label: "A", node_type: "source", config: {} },
        },
        {
          id: "b",
          position: { x: 0, y: 0 },
          data: { label: "B", node_type: "filter", config: { combine: "and" } },
        },
      ],
      [
        { id: "e1", source: "a", target: "b", targetHandle: "left", label: "LEFT" },
        { id: "e2", source: "a", target: "b" },
      ],
    );
    expect(prepGraphSnapshotsEqual(left, right)).toBe(true);
  });

  it("detects editable keyboard targets", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isEditableKeyboardTarget(input)).toBe(true);
    expect(isEditableKeyboardTarget(div)).toBe(false);
  });
});
