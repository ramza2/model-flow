import { describe, expect, it } from "vitest";
import {
  configSummary,
  edgeBranch,
  filterNodeLibrary,
  nextPipelineNodeId,
  parseValidationIssue,
  PIPELINE_NODE_LIBRARY,
  PIPELINE_NODE_TYPES,
} from "./pipelineHelpers";

describe("pipelineHelpers Phase 1.5-B", () => {
  it("exposes all runtime node types in the library categories", () => {
    const types = PIPELINE_NODE_LIBRARY.flatMap((group) => group.items.map((item) => item.type));
    expect(new Set(types)).toEqual(new Set(PIPELINE_NODE_TYPES));
    expect(PIPELINE_NODE_LIBRARY.map((group) => group.category)).toEqual([
      "Data",
      "Train",
      "Logic",
      "Model Lifecycle",
      "Serving",
      "Operations",
    ]);
  });

  it("resolves condition branch from handle, data, or label", () => {
    expect(edgeBranch({ sourceHandle: "true" })).toBe("true");
    expect(edgeBranch({ sourceHandle: "false" })).toBe("false");
    expect(edgeBranch({ data: { branch: "always" } })).toBe("always");
    expect(edgeBranch({ label: "true" })).toBe("true");
    expect(edgeBranch({})).toBe("always");
  });

  it("summarizes multi-output training targets", () => {
    expect(
      configSummary("training", {
        target_columns: ["cooling_load", "power_usage"],
        algorithm: "ridge",
      }),
    ).toContain("2 targets");
  });

  it("parses validation issues to node ids when present", () => {
    expect(parseValidationIssue("Node 'training-1' is missing target", ["training-1", "split-1"])).toEqual({
      message: "Node 'training-1' is missing target",
      nodeId: "training-1",
    });
    expect(parseValidationIssue("Graph has a cycle", ["training-1"])).toEqual({
      message: "Graph has a cycle",
      nodeId: null,
    });
  });

  it("allocates unique node ids against an existing graph after reload", () => {
    expect(nextPipelineNodeId("dataset_load", ["dataset_load-1"])).toBe("dataset_load-2");
    expect(nextPipelineNodeId("dataset_load", ["dataset_load-1", "dataset_load-2"])).toBe(
      "dataset_load-3",
    );
    expect(nextPipelineNodeId("training", ["dataset_load-1", "training-9"])).toBe("training-10");
    const first = nextPipelineNodeId("split", []);
    const second = nextPipelineNodeId("split", [first]);
    expect(first).toBe("split-1");
    expect(second).toBe("split-2");
    expect(new Set([first, second, "dataset_load-1"]).size).toBe(3);
  });

  it("filters the node library by label, type, description, and category", () => {
    const byLabel = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "dataset load");
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0].items.map((item) => item.type)).toEqual(["dataset_load"]);

    const byType = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "endpoint_deployment");
    expect(byType.flatMap((group) => group.items.map((item) => item.type))).toEqual([
      "endpoint_deployment",
    ]);

    const byCategory = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "serving");
    expect(byCategory.map((group) => group.category)).toEqual(["Serving"]);
    expect(byCategory[0].items).toHaveLength(2);

    expect(filterNodeLibrary(PIPELINE_NODE_LIBRARY, "zzzz-no-match")).toEqual([]);
  });
});
