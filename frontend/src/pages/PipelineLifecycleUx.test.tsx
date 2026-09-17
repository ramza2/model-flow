import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineBuilderLifecyclePage, PipelineRunLifecyclePage } from "./PipelineLifecycleUx";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("./Pipelines", () => ({
  PipelineBuilder: () => <div data-testid="pipeline-builder-stub">Builder</div>,
  PipelineRunDetail: () => <div data-testid="pipeline-run-detail-stub">Run detail</div>,
}));

const graph = {
  nodes: [
    { id: "load", position: { x: 0, y: 0 }, data: { node_type: "dataset_load", config: { dataset_id: 7, dataset_version_id: 42 } } },
    { id: "train", position: { x: 1, y: 0 }, data: { node_type: "training", config: {} } },
    { id: "deploy", position: { x: 2, y: 0 }, data: { node_type: "endpoint_deployment", config: {} } },
  ],
  edges: [],
};

const pipeline = {
  id: 3,
  project_id: 5,
  name: "Lifecycle pipeline",
  description: "",
  status: "published",
  latest_version: 4,
  is_template: false,
  version: { id: 44, version: 4, graph },
  created_at: "2026-09-17T00:00:00Z",
};

const run = {
  id: 70,
  pipeline_id: 3,
  pipeline_version_id: 44,
  status: "failed",
  parameters: {},
  node_states: {
    load: { status: "succeeded", node_type: "dataset_load" },
    train: { status: "succeeded", node_type: "training", output: { training_job_id: 91 } },
    deploy: { status: "failed", node_type: "endpoint_deployment", error: "deployment failed" },
  },
  node_artifacts: {
    load: { dataset_id: 7, dataset_version_id: 42 },
    train: { training_job_id: 91, model_version: { __modelflow_artifact__: "model_version", id: 12 } },
  },
  fail_policy: "stop",
  scheduled_for: null,
  logs: "",
  error_message: "deployment failed",
  created_at: "2026-09-17T00:00:00Z",
  started_at: "2026-09-17T00:00:01Z",
  finished_at: "2026-09-17T00:00:05Z",
};

const version = {
  id: 44,
  pipeline_id: 3,
  project_id: 5,
  version: 4,
  graph,
  created_at: "2026-09-17T00:00:00Z",
};

describe("Phase 3-C pipeline lifecycle pages", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/5/pipelines/3") return pipeline;
      if (path === "/projects/5/pipelines/3/runs") return [run];
      if (path === "/projects/5/pipeline-runs/70") return run;
      if (path === "/projects/5/pipeline-versions/44") return version;
      throw new Error(`Unhandled GET ${path}`);
    });
  });

  it("shows current graph lifecycle coverage and matching latest-run status above the builder", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/5/pipelines/3"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines/:pipelineId" element={<PipelineBuilderLifecyclePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("pipeline-builder-lifecycle-summary")).toHaveTextContent(
      "Latest run uses this saved pipeline version",
    );
    expect(screen.getByTestId("pipeline-lifecycle-stage-deploy")).toHaveTextContent("Deploy");
    expect(screen.getByTestId("pipeline-builder-stub")).toBeInTheDocument();
  });

  it("surfaces run progress, first failed-node recovery cue, and cross-lifecycle lineage", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/5/pipeline-runs/70"]}>
        <Routes>
          <Route path="/projects/:projectId/pipeline-runs/:runId" element={<PipelineRunLifecyclePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("pipeline-run-progress")).toHaveTextContent("100%");
    expect(screen.getByTestId("pipeline-run-recovery-cue")).toHaveTextContent("deploy");
    expect(screen.getByTestId("pipeline-lineage-dataset_version-42")).toHaveTextContent(
      "DatasetVersion #42",
    );
    expect(screen.getByTestId("pipeline-lineage-training_job-91")).toHaveTextContent(
      "Training Job #91",
    );
    expect(screen.getByTestId("pipeline-lineage-model_version-12")).toHaveTextContent(
      "Model Version #12",
    );
    expect(screen.getByTestId("pipeline-run-detail-stub")).toBeInTheDocument();
  });
});
