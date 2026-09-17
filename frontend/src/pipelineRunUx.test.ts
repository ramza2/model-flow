import { describe, expect, it } from "vitest";
import type { PipelineGraph, PipelineRun } from "./api";
import {
  collectPipelineLineage,
  normalizePipelineRunStatus,
  summarizePipelineRunLifecycle,
} from "./pipelineRunUx";

const graph: PipelineGraph = {
  nodes: [
    { id: "load", position: { x: 0, y: 0 }, data: { node_type: "dataset_load", config: { dataset_id: 7, dataset_version_id: 42 } } },
    { id: "quality", position: { x: 1, y: 0 }, data: { node_type: "quality_check", config: {} } },
    { id: "train", position: { x: 2, y: 0 }, data: { node_type: "training", config: {} } },
    { id: "register", position: { x: 3, y: 0 }, data: { node_type: "model_registration", config: {} } },
    { id: "deploy", position: { x: 4, y: 0 }, data: { node_type: "endpoint_deployment", config: {} } },
  ],
  edges: [],
};

function runFixture(): Pick<PipelineRun, "node_states" | "node_artifacts"> {
  return {
    node_states: {
      load: { status: "succeeded", node_type: "dataset_load" },
      quality: { status: "reused", node_type: "quality_check" },
      train: {
        status: "succeeded",
        node_type: "training",
        output: { training_job_id: 91, mlflow_run_id: "abcdef1234567890" },
      },
      register: {
        status: "succeeded",
        node_type: "model_registration",
        output: { model_version_id: 12 },
      },
      deploy: { status: "failed", node_type: "endpoint_deployment", error: "boom" },
    },
    node_artifacts: {
      load: { dataset_id: 7, dataset_version_id: 42 },
      register: { model_version: { __modelflow_artifact__: "model_version", id: 12 } },
      deploy: { endpoint_id: 33 },
    },
  };
}

describe("pipeline run lifecycle UX helpers", () => {
  it("normalizes runtime aliases into one consistent status vocabulary", () => {
    expect(normalizePipelineRunStatus("queued")).toBe("pending");
    expect(normalizePipelineRunStatus("in_progress")).toBe("running");
    expect(normalizePipelineRunStatus("success")).toBe("succeeded");
    expect(normalizePipelineRunStatus("cached")).toBe("reused");
    expect(normalizePipelineRunStatus("error")).toBe("failed");
  });

  it("summarizes lifecycle progress and failure focus by the shared stage taxonomy", () => {
    const run = runFixture();
    const summary = summarizePipelineRunLifecycle(graph, run.node_states);

    expect(summary.total).toBe(5);
    expect(summary.terminal).toBe(5);
    expect(summary.progressPercent).toBe(100);
    expect(summary.failedNodeIds).toEqual(["deploy"]);
    expect(summary.statusCounts.reused).toBe(1);
    expect(summary.stages.find((stage) => stage.id === "quality")).toMatchObject({
      total: 1,
      terminal: 1,
      status: "reused",
    });
    expect(summary.stages.find((stage) => stage.id === "deploy")).toMatchObject({
      total: 1,
      status: "failed",
    });
  });

  it("extracts exact cross-lifecycle lineage from graph config and persisted node artifacts", () => {
    const lineage = collectPipelineLineage(5, graph, runFixture());

    expect(lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dataset_version",
          id: "42",
          to: "/projects/5/datasets/7",
        }),
        expect.objectContaining({
          kind: "training_job",
          id: "91",
          to: "/projects/5/jobs/91",
        }),
        expect.objectContaining({
          kind: "experiment_run",
          id: "abcdef1234567890",
          to: "/projects/5/experiments/runs/abcdef1234567890",
        }),
        expect.objectContaining({
          kind: "model_version",
          id: "12",
          to: "/projects/5/models/12",
        }),
        expect.objectContaining({
          kind: "deployment",
          id: "33",
          to: "/projects/5/deployments/33/predict",
        }),
      ]),
    );
    expect(lineage.filter((item) => item.kind === "dataset_version")).toHaveLength(1);
    expect(lineage.filter((item) => item.kind === "model_version")).toHaveLength(1);
  });
});
