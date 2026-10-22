import { describe, expect, it } from "vitest";
import {
  configSummary,
  defaultConfigFor,
  edgeBranch,
  filterNodeLibrary,
  labelForType,
  lifecycleCoverage,
  lifecycleStageForNodeType,
  nextPipelineNodeId,
  nodeConfigWarnings,
  parseValidationIssue,
  PIPELINE_LIFECYCLE_STAGES,
  PIPELINE_NODE_LIBRARY,
  PIPELINE_NODE_TYPES,
  pipelineNodeLibraryCategoryLabel,
  pipelineNodeTypeDescription,
  pipelineNodeTypeLabel,
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

  it("defaults and summarizes forecasting / time-aware split configs", () => {
    expect(defaultConfigFor("training")).toMatchObject({
      training_task: "tabular",
      forecast_strategy: null,
      forecast_horizons: [],
    });
    expect(defaultConfigFor("split")).toMatchObject({
      split_strategy: "random",
      time_column: null,
    });
    const forecastSummary = configSummary("training", {
      training_task: "forecasting",
      algorithm: "ridge",
      forecast_horizons: [1, 2, 3],
      split_strategy: "time",
      time_column: "event_time",
    });
    expect(forecastSummary[0]).toContain("Forecasting · t+1, t+2, t+3");
    expect(forecastSummary).toContain("ridge");
    expect(forecastSummary.some((line) => /time ordered · event_time/i.test(line))).toBe(true);

    const warnings = nodeConfigWarnings("training", {
      training_task: "forecasting",
      target_column: "",
      algorithm: "",
      feature_columns: [],
      split_strategy: "random",
      forecast_horizons: [],
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        "Exactly one forecast target required",
        "Time column required",
        "Forecast horizons required",
        "Forecasting algorithm required/supported",
        "Select at least one feature",
      ]),
    );
    expect(
      nodeConfigWarnings("split", {
        train_ratio: 0.7,
        val_ratio: 0.15,
        test_ratio: 0.15,
        random_seed: 42,
        split_strategy: "time",
        time_column: "",
      }),
    ).toContain("Time column required");
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

  it("exposes Korean display labels without changing saved English defaults", () => {
    const expected: Array<[string, string]> = [
      ["dataset_load", "데이터셋 불러오기 (Dataset Load)"],
      ["preprocessing", "데이터 전처리 (Preprocessing)"],
      ["split", "데이터 분할 (Split)"],
      ["quality_check", "품질 검사 (Quality Check)"],
      ["training", "모델 학습 (Training)"],
      ["evaluation", "모델 평가 (Evaluation)"],
      ["condition", "조건 분기 (Condition)"],
      ["model_registration", "모델 등록 (Model Registration)"],
      ["approval_request", "승인 요청 (Approval Request)"],
      ["endpoint_deployment", "엔드포인트 배포 (Endpoint Deployment)"],
      ["batch_prediction", "일괄 예측 (Batch Prediction)"],
      ["notification", "알림 (Notification)"],
    ];
    expect(expected).toHaveLength(12);
    for (const [type, label] of expected) {
      expect(pipelineNodeTypeLabel(type)).toBe(label);
      expect(labelForType(type)).toBe(
        type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      );
      expect(pipelineNodeTypeDescription(type).length).toBeGreaterThan(0);
    }
    expect(pipelineNodeLibraryCategoryLabel("1. Source & Transform")).toBe("1. 데이터 입력·변환");
    expect(pipelineNodeLibraryCategoryLabel("3. Train")).toBe("3. 모델 학습·평가");
  });

  it("matches Korean and English library search terms for Split/Training/Evaluation", () => {
    expect(
      filterNodeLibrary(PIPELINE_NODE_LIBRARY, "split").flatMap((group) =>
        group.items.map((item) => item.type),
      ),
    ).toContain("split");
    expect(
      filterNodeLibrary(PIPELINE_NODE_LIBRARY, "분할").flatMap((group) =>
        group.items.map((item) => item.type),
      ),
    ).toEqual(["split"]);
    expect(
      filterNodeLibrary(PIPELINE_NODE_LIBRARY, "training").flatMap((group) =>
        group.items.map((item) => item.type),
      ),
    ).toContain("training");
    expect(
      filterNodeLibrary(PIPELINE_NODE_LIBRARY, "학습").flatMap((group) =>
        group.items.map((item) => item.type),
      ),
    ).toContain("training");
    expect(
      filterNodeLibrary(PIPELINE_NODE_LIBRARY, "evaluation").flatMap((group) =>
        group.items.map((item) => item.type),
      ),
    ).toContain("evaluation");
    expect(
      filterNodeLibrary(PIPELINE_NODE_LIBRARY, "평가").flatMap((group) =>
        group.items.map((item) => item.type),
      ),
    ).toContain("evaluation");
  });
});
