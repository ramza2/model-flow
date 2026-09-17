import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PipelineBuilderLifecyclePage,
  PipelineRunLifecyclePage,
} from "./PipelineLifecyclePages";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("./Pipelines", () => ({
  PipelineBuilder: () => <div data-testid="pipeline-builder-stub">Builder</div>,
  PipelineRunDetail: () => <div data-testid="pipeline-run-detail-stub">Run detail</div>,
}));

const historicalVersion = {
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
    ],
    edges: [],
  },
  created_at: "2026-09-17T00:00:00Z",
};

const completedRun = {
  id: 55,
  pipeline_id: 9,
  pipeline_version_id: 12,
  status: "failed",
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
      attempt: 1,
      error: "training exploded",
      output: { training_job_id: 88, mlflow_run_id: "run-abc" },
    },
  },
  node_artifacts: {},
  fail_policy: "stop",
  scheduled_for: null,
  logs: "failed",
  error_message: "training exploded",
  created_at: "2026-09-17T00:00:00Z",
  started_at: "2026-09-17T00:00:01Z",
  finished_at: "2026-09-17T00:00:05Z",
};

function renderBuilderLifecycle() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/pipelines/9"]}>
      <Routes>
        <Route
          path="/projects/:projectId/pipelines/:pipelineId"
          element={<PipelineBuilderLifecyclePage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRunLifecycle() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/pipeline-runs/55"]}>
      <Routes>
        <Route
          path="/projects/:projectId/pipeline-runs/:runId"
          element={<PipelineRunLifecyclePage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Pipeline lifecycle page composition", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("keeps the existing builder and shows the latest run lifecycle summary", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipelines/9/runs") {
        return [
          { ...completedRun, id: 50, status: "succeeded", error_message: null },
          completedRun,
        ];
      }
      throw new Error(`Unhandled GET ${path}`);
    });

    renderBuilderLifecycle();
    expect(screen.getByTestId("pipeline-builder-stub")).toBeInTheDocument();
    expect(await screen.findByTestId("pipeline-run-overview")).toHaveTextContent("Run #55");
    expect(screen.getByTestId("pipeline-run-stage-source_transform")).toHaveTextContent(
      "Source & Transform",
    );
    expect(screen.getByTestId("pipeline-run-stage-train")).toHaveTextContent("Train");
    expect(screen.getByTestId("pipeline-run-overview-open")).toHaveAttribute(
      "href",
      "/projects/7/pipeline-runs/55",
    );
  });

  it("adds failed-step recovery and cross-lifecycle lineage around the existing run detail", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipeline-runs/55") return completedRun;
      if (path === "/projects/7/pipeline-versions/12") return historicalVersion;
      throw new Error(`Unhandled GET ${path}`);
    });

    renderRunLifecycle();
    expect(screen.getByTestId("pipeline-run-detail-stub")).toBeInTheDocument();
    expect(await screen.findByTestId("pipeline-run-recovery")).toHaveTextContent(
      "training exploded",
    );
    expect(screen.getByTestId("pipeline-run-progress")).toHaveTextContent("100%");
    const lineage = await screen.findByTestId("entity-lineage");
    expect(lineage).toHaveTextContent("Dataset #17 · Version #42");
    expect(lineage).toHaveTextContent("Job #88");
    expect(lineage).toHaveTextContent("run-abc");
    expect(screen.getByRole("link", { name: "Job #88" })).toHaveAttribute(
      "href",
      "/projects/7/jobs/88",
    );
  });
});
