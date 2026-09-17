import { describe, expect, it } from "vitest";
import type { PipelineRun, PipelineVersion } from "./api";
import {
  firstFailedPipelineNode,
  normalizePipelineRunStatus,
  pipelineRunLineageItems,
  pipelineRunNodeViews,
  summarizePipelineRunProgress,
  summarizePipelineRunStages,
} from "./pipelineRunUx";

const version: PipelineVersion = {
  id: 12,
  pipeline_id: 9,
  project_id: 7,
  version: 4,
  graph: {
    nodes: [
      {
        id: "dataset_load-1",
        position: { x: 0, y: 0 },
        data: {
          label: "Prepared input",
          node_type: "dataset_load",
          config: { dataset_id: 17, dataset_version_id: 42 },
        },
      },
      {
        id: "training-1",
        position: { x: 220, y: 0 },
        data: { label: "Train model", node_type: "training", config: {} },
      },
      {
        id: "model_registration-1",
        position: { x: 440, y: 0 },
        data: { label: "Register model", node_type: "model_registration", config: {} },
      },
      {
        id: "endpoint_deployment-1",
        position: { x: 660, y: 0 },
        data: { label: "Deploy", node_type: "endpoint_deployment", config: {} },
      },
    ],
    edges: [],
  },
  created_at: "2026-09-17T00:00:00Z",
};

function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 55,
    pipeline_id: 9,
    pipeline_version_id: 12,
    status: "running",
    parameters: {},
    node_states: {
      "dataset_load-1": {
        status: "succeeded",
        label: "Prepared input",
        node_type: "dataset_load",
        attempt: 1,
        output: { dataset_id: 17, dataset_version_id: 42 },
      },
      "training-1": {
        status: "failed",
        label: "Train model",
        node_type: "training",
        attempt: 2,
        error: "training exploded",
      },
      "model_registration-1": {
        status: "pending",
        label: "Register model",
        node_type: "model_registration",
        attempt: 2,
      },
      "endpoint_deployment-1": {
        status: "pending",
        label: "Deploy",
        node_type: "endpoint_deployment",
        attempt: 2,
      },
    },
    node_artifacts: {},
    fail_policy: "stop",
    scheduled_for: null,
    logs: "",
    error_message: "training exploded",
    created_at: "2026-09-17T00:00:00Z",
    started_at: "2026-09-17T00:00:01Z",
    finished_at: null,
    ...overrides,
  };
}

describe("pipeline run UX helpers", () => {
  it("normalizes runtime aliases into stable presentation statuses", () => {
    expect(normalizePipelineRunStatus("queued")).toBe("pending");
    expect(normalizePipelineRunStatus("in_progress")).toBe("running");
    expect(normalizePipelineRunStatus("completed")).toBe("succeeded");
    expect(normalizePipelineRunStatus("error")).toBe("failed");
    expect(normalizePipelineRunStatus("skipped")).toBe("skipped");
    expect(normalizePipelineRunStatus("cancelled")).toBe("cancelled");
  });

  it("derives reused upstream steps from rerun attempts without mutating backend state", () => {
    const nodes = pipelineRunNodeViews(run(), version);
    expect(nodes.find((node) => node.id === "dataset_load-1")?.status).toBe("reused");
    expect(nodes.find((node) => node.id === "training-1")?.status).toBe("failed");
    expect(nodes.find((node) => node.id === "training-1")?.stageLabel).toBe("Train");
  });

  it("summarizes lifecycle stages and terminal progress consistently", () => {
    const current = run();
    const stages = summarizePipelineRunStages(current, version);
    expect(stages.find((stage) => stage.id === "source_transform")).toMatchObject({
      status: "reused",
      total: 1,
    });
    expect(stages.find((stage) => stage.id === "train")).toMatchObject({
      status: "failed",
      total: 1,
    });
    expect(stages.find((stage) => stage.id === "registry")).toMatchObject({
      status: "pending",
      total: 1,
    });
    expect(summarizePipelineRunProgress(current, version)).toMatchObject({
      total: 4,
      terminal: 2,
      percent: 50,
    });
  });

  it("identifies the first failed node using graph order and keeps its recovery evidence", () => {
    expect(firstFailedPipelineNode(run(), version)).toMatchObject({
      id: "training-1",
      label: "Train model",
      nodeType: "training",
      error: "training exploded",
    });
  });

  it("builds cross-lifecycle links from exact graph input and persisted node outputs", () => {
    const succeeded = run({
      status: "succeeded",
      node_states: {
        "dataset_load-1": {
          status: "succeeded",
          node_type: "dataset_load",
          output: { dataset_id: 17, dataset_version_id: 42 },
        },
        "training-1": {
          status: "succeeded",
          node_type: "training",
          output: {
            dataset_id: 17,
            dataset_version_id: 42,
            training_job_id: 88,
            mlflow_run_id: "run-abc",
          },
        },
        "model_registration-1": {
          status: "succeeded",
          node_type: "model_registration",
          output: {
            training_job_id: 88,
            mlflow_run_id: "run-abc",
            model_version: { model_version_id: 123 },
          },
        },
        "endpoint_deployment-1": {
          status: "succeeded",
          node_type: "endpoint_deployment",
          output: { model_version_id: 123, endpoint_id: 77 },
        },
      },
      finished_at: "2026-09-17T00:01:00Z",
    });
    const items = pipelineRunLineageItems(succeeded, version, 7);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Pipeline", to: "/projects/7/pipelines/9" }),
        expect.objectContaining({
          label: "Dataset version",
          value: "Dataset #17 · Version #42",
          to: "/projects/7/datasets/17",
        }),
        expect.objectContaining({ label: "Training job", to: "/projects/7/jobs/88" }),
        expect.objectContaining({
          label: "Experiment run",
          to: "/projects/7/experiments/runs/run-abc",
        }),
        expect.objectContaining({ label: "Model version", to: "/projects/7/models/123" }),
        expect.objectContaining({ label: "Deployment", to: "/projects/7/deployments" }),
      ]),
    );
  });
});
