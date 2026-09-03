import { describe, expect, it } from "vitest";
import {
  configSummary,
  edgeBranch,
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
});
