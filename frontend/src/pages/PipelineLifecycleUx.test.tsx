import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_LIFECYCLE_STAGES } from "../pipelineHelpers";
import { lifecycleStageDisplayLabel } from "../uiTerminology";
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

  it("shows Korean builder lifecycle coverage with matching latest-run status", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/5/pipelines/3"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines/:pipelineId" element={<PipelineBuilderLifecyclePage />} />
        </Routes>
      </MemoryRouter>,
    );

    const summary = await screen.findByTestId("pipeline-builder-lifecycle-summary");
    expect(summary).toHaveTextContent("단계별 구성 현황 (Lifecycle Coverage)");
    expect(summary).toHaveTextContent("파이프라인 전체 구성");
    expect(screen.getByTestId("pipeline-lifecycle-saved-hint")).toHaveTextContent(
      /마지막으로 저장된 파이프라인 버전/,
    );
    expect(screen.getByTestId("pipeline-lifecycle-run-hint")).toHaveTextContent(
      /최근 실행이 현재 저장 버전과 일치/,
    );
    expect(screen.getByTestId("pipeline-lifecycle-run-hint")).toHaveTextContent(/종료 진행률/);
    expect(screen.getByTestId("pipeline-lifecycle-run-hint")).toHaveTextContent(/성공률이 아님/);
    expect(screen.getByTestId("pipeline-lifecycle-stage-deploy")).toHaveTextContent("모델 배포");
    expect(screen.getByTestId("pipeline-lifecycle-stage-train")).toHaveTextContent("모델 학습·평가");
    expect(screen.getByTestId("pipeline-lifecycle-stage-source_transform")).toHaveTextContent(
      "데이터 입력·변환",
    );
    expect(screen.getByRole("link", { name: /최근 실행 #70/ })).toBeInTheDocument();
    expect(PIPELINE_LIFECYCLE_STAGES.map((stage) => stage.id)).toEqual([
      "source_transform",
      "quality",
      "train",
      "registry",
      "deploy",
      "predict",
      "monitor",
    ]);
    expect(PIPELINE_LIFECYCLE_STAGES.find((stage) => stage.id === "deploy")?.label).toBe("Deploy");
    expect(lifecycleStageDisplayLabel("deploy")).toBe("모델 배포");
    expect(screen.getByTestId("pipeline-builder-stub")).toBeInTheDocument();
  });

  it("shows composition-only guidance when latest run uses another version", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/5/pipelines/3") return pipeline;
      if (path === "/projects/5/pipelines/3/runs") {
        return [{ ...run, pipeline_version_id: 99 }];
      }
      throw new Error(`Unhandled GET ${path}`);
    });
    render(
      <MemoryRouter initialEntries={["/projects/5/pipelines/3"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines/:pipelineId" element={<PipelineBuilderLifecyclePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("pipeline-lifecycle-run-hint")).toHaveTextContent(
      /다른 저장 버전/,
    );
    expect(screen.getByTestId("pipeline-lifecycle-stage-deploy")).toHaveTextContent("노드 구성됨");
    expect(screen.getByTestId("pipeline-lifecycle-stage-quality")).toHaveTextContent(
      "구성된 노드 없음",
    );
  });

  it("shows composition-only guidance when there is no run history", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/5/pipelines/3") return pipeline;
      if (path === "/projects/5/pipelines/3/runs") return [];
      throw new Error(`Unhandled GET ${path}`);
    });
    render(
      <MemoryRouter initialEntries={["/projects/5/pipelines/3"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines/:pipelineId" element={<PipelineBuilderLifecyclePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("pipeline-lifecycle-run-hint")).toHaveTextContent(
      /실행 이력이 없습니다/,
    );
    expect(screen.queryByRole("link", { name: /최근 실행/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-lifecycle-stage-deploy")).toHaveTextContent("노드 구성됨");
  });

  it("keeps PipelineRunLifecyclePage English StageStrip and recovery cues", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/5/pipeline-runs/70"]}>
        <Routes>
          <Route path="/projects/:projectId/pipeline-runs/:runId" element={<PipelineRunLifecyclePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("pipeline-run-progress")).toHaveTextContent("100%");
    expect(screen.getByTestId("pipeline-run-progress")).toHaveTextContent("steps terminal");
    expect(screen.getByTestId("pipeline-lifecycle-stage-deploy")).toHaveTextContent("Deploy");
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
