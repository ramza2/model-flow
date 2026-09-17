import { describe, expect, it } from "vitest";
import {
  configSummary,
  edgeBranch,
  filterNodeLibrary,
  lifecycleCoverage,
  lifecycleStageForNodeType,
  nextPipelineNodeId,
  parseValidationIssue,
  PIPELINE_LIFECYCLE_STAGES,
  PIPELINE_NODE_LIBRARY,
  PIPELINE_NODE_TYPES,
} from "./pipelineHelpers";

describe("pipelineHelpers Phase 3-A", () => {
  it("exposes every runtime node exactly once across lifecycle-aligned library categories", () => {
    const types = PIPELINE_NODE_LIBRARY.flatMap((group) => group.items.map((item) => item.type));
    expect(new Set(types)).toEqual(new Set(PIPELINE_NODE_TYPES));
    expect(types).toHaveLength(PIPELINE_NODE_TYPES.length);
    expect(PIPELINE_NODE_LIBRARY.map((group) => group.category)).toEqual([
      "1. Source & Transform",
      "2. Quality",
      "3. Train",
      "4. Registry & Governance",
      "5. Deploy",
      "6. Predict",
      "7. Monitor",
    ]);
  });

  it("maps the runtime node catalog onto the end-to-end lifecycle", () => {
    expect(PIPELINE_LIFECYCLE_STAGES.map((stage) => stage.id)).toEqual([
      "source_transform",
      "quality",
      "train",
      "registry",
      "deploy",
      "predict",
      "monitor",
    ]);
    expect(lifecycleStageForNodeType("dataset_load")?.id).toBe("source_transform");
    expect(lifecycleStageForNodeType("quality_check")?.id).toBe("quality");
    expect(lifecycleStageForNodeType("training")?.id).toBe("train");
    expect(lifecycleStageForNodeType("model_registration")?.id).toBe("registry");
    expect(lifecycleStageForNodeType("endpoint_deployment")?.id).toBe("deploy");
    expect(lifecycleStageForNodeType("batch_prediction")?.id).toBe("predict");
    expect(lifecycleStageForNodeType("notification")?.id).toBe("monitor");
    expect(lifecycleStageForNodeType("unknown")).toBeNull();
  });

  it("summarizes lifecycle coverage without changing graph semantics", () => {
    expect(
      lifecycleCoverage([
        "dataset_load",
        "preprocessing",
        "quality_check",
        "training",
        "evaluation",
        "model_registration",
        "endpoint_deployment",
        "batch_prediction",
        "notification",
      ]),
    ).toEqual({
      source_transform: 2,
      quality: 1,
      train: 2,
      registry: 1,
      deploy: 1,
      predict: 1,
      monitor: 1,
    });
  });

  it("advertises materialized Preparation output through the existing exact DatasetVersion source", () => {
    const source = PIPELINE_NODE_LIBRARY.flatMap((group) => group.items).find(
      (item) => item.type === "dataset_load",
    );
    expect(source?.description).toContain("exact DatasetVersion");
    expect(source?.description).toContain("Dataset Preparation output");
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

  it("filters the node library by label, type, description, and lifecycle category", () => {
    const byLabel = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "dataset load");
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0].items.map((item) => item.type)).toEqual(["dataset_load"]);

    const byType = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "endpoint_deployment");
    expect(byType.flatMap((group) => group.items.map((item) => item.type))).toEqual([
      "endpoint_deployment",
    ]);

    const byCategory = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "predict");
    expect(byCategory.map((group) => group.category)).toEqual(["6. Predict"]);
    expect(byCategory[0].items.map((item) => item.type)).toEqual(["batch_prediction"]);

    const byPreparation = filterNodeLibrary(PIPELINE_NODE_LIBRARY, "preparation");
    expect(byPreparation.flatMap((group) => group.items.map((item) => item.type))).toEqual([
      "dataset_load",
    ]);

    expect(filterNodeLibrary(PIPELINE_NODE_LIBRARY, "zzzz-no-match")).toEqual([]);
  });
});
