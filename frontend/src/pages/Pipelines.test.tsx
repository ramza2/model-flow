import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeConfigForm } from "../pipelineForms";
import { defaultConfigFor } from "../pipelineHelpers";
import { PipelineBuilder, PipelineRunDetail } from "./Pipelines";

const apiMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "PROJECT_ADMIN" } }),
  userCanProject: () => true,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    onNodeClick,
    children,
  }: {
    nodes: Array<{ id: string; data: { label: string } }>;
    onNodeClick?: (_: unknown, node: { id: string; data: { label: string } }) => void;
    children?: ReactNode;
  }) => (
    <div data-testid="react-flow">
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-testid={`canvas-node-${node.id}`}
          onClick={() => onNodeClick?.({}, node)}
        >
          {node.data.label}
        </button>
      ))}
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  addEdge: (edge: Record<string, unknown>, edges: unknown[]) => [
    ...edges,
    { id: `e-${edges.length}`, ...edge },
  ],
  applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
}));

const pipeline = {
  id: 9,
  project_id: 7,
  name: "Demo pipeline",
  description: "",
  status: "draft",
  latest_version: 1,
  is_template: false,
  version: {
    id: 1,
    version: 1,
    graph: { nodes: [], edges: [] },
  },
  created_at: "2026-08-10T10:00:00Z",
};

const datasets = [
  {
    id: 3,
    project_id: 7,
    name: "iris",
    description: "",
    latest_version: 1,
    row_count: 150,
    column_count: 5,
    columns: ["sepal_length", "sepal_width", "petal_length", "petal_width", "target"],
    stats: {},
    created_at: "2026-08-10T10:00:00Z",
  },
];

const versions = [
  {
    id: 11,
    dataset_id: 3,
    project_id: 7,
    version: 1,
    original_filename: "iris.csv",
    format: "csv",
    row_count: 150,
    column_count: 5,
    columns: datasets[0].columns,
    dtypes: {},
    stats: {},
    source_type: "upload",
    created_at: "2026-08-10T10:00:00Z",
  },
];

function stubBuilderApi(overrides?: {
  validate?: { valid: boolean; errors: string[] };
  saveFail?: boolean;
}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    if (path === "/projects/7/pipelines/9") return { ...pipeline };
    if (path === "/projects/7/pipelines/9/runs") return [];
    if (path === "/projects/7/datasets") return datasets;
    if (path === "/projects/7/datasets/3/versions") return versions;
    if (path === "/projects/7/pipelines/9/versions" && method === "POST") {
      if (overrides?.saveFail) throw new Error("save failed");
      return { id: 2, version: 2, graph: JSON.parse(String(init?.body || "{}")).graph };
    }
    if (path === "/projects/7/pipelines/9/validate" && method === "POST") {
      return overrides?.validate || { valid: true, errors: [], order: [] };
    }
    if (path === "/projects/7/pipelines/9/publish" && method === "POST") {
      return { ...pipeline, status: "published" };
    }
    if (path === "/projects/7/pipelines/9/run" && method === "POST") {
      return {
        id: 55,
        pipeline_id: 9,
        pipeline_version_id: 1,
        status: "queued",
        parameters: {},
        node_states: {},
        node_artifacts: {},
        fail_policy: "stop",
        scheduled_for: null,
        logs: "",
        error_message: null,
        created_at: "2026-08-10T10:00:00Z",
        started_at: null,
        finished_at: null,
      };
    }
    throw new Error(`Unhandled api call ${method} ${path}`);
  });
}

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/pipelines/9"]}>
      <Routes>
        <Route path="/projects/:projectId/pipelines/:pipelineId" element={<PipelineBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRunDetail(runId = "42") {
  return render(
    <MemoryRouter initialEntries={[`/projects/7/pipeline-runs/${runId}`]}>
      <Routes>
        <Route path="/projects/:projectId/pipeline-runs/:runId" element={<PipelineRunDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NodeConfigForm", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("sets dataset_load config via dropdowns", async () => {
    stubBuilderApi();
    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>({});
      return (
        <NodeConfigForm
          projectId="7"
          nodeType="dataset_load"
          config={config}
          onChange={setConfig}
        />
      );
    }
    render(<Harness />);
    await screen.findByTestId("node-config-dataset");
    fireEvent.change(screen.getByTestId("node-config-dataset"), { target: { value: "3" } });
    await waitFor(() => expect(screen.getByTestId("node-config-version")).not.toBeDisabled());
    fireEvent.change(screen.getByTestId("node-config-version"), { target: { value: "11" } });
    await waitFor(() => {
      expect(screen.getByTestId("node-config-dataset")).toHaveValue("3");
      expect(screen.getByTestId("node-config-version")).toHaveValue("11");
    });
  });

  it("shows split ratio validation error when sum is invalid", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NodeConfigForm
        projectId="7"
        nodeType="split"
        config={{ train_ratio: 0.7, val_ratio: 0.15, test_ratio: 0.15, random_seed: 42 }}
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("node-config-split-error")).not.toBeInTheDocument();
    rerender(
      <NodeConfigForm
        projectId="7"
        nodeType="split"
        config={{ train_ratio: 0.5, val_ratio: 0.5, test_ratio: 0.5, random_seed: 42 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("node-config-split-error")).toHaveTextContent(/must equal 1\.0/i);
  });

  it("uses metric/value keys for condition defaults and form edits", () => {
    expect(defaultConfigFor("condition")).toEqual({
      metric: "accuracy",
      operator: ">=",
      value: 0.8,
      fail_on_false: false,
    });

    function Harness() {
      const [config, setConfig] = useState(defaultConfigFor("condition"));
      return (
        <div>
          <pre data-testid="condition-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm projectId="7" nodeType="condition" config={config} onChange={setConfig} />
        </div>
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByTestId("node-config-left"), { target: { value: "f1" } });
    fireEvent.change(screen.getByTestId("node-config-right"), { target: { value: "0.55" } });
    expect(screen.getByTestId("condition-config")).toHaveTextContent('"metric":"f1"');
    expect(screen.getByTestId("condition-config")).toHaveTextContent('"value":0.55');
    expect(screen.getByTestId("condition-config")).not.toHaveTextContent('"left"');
    expect(screen.getByTestId("condition-config")).not.toHaveTextContent('"right"');
  });

  it("clears stale quality_rule_id after upstream dataset rules reload", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("dataset_id=3")) {
        return [{ id: 10, name: "Rule A", dataset_id: 3, is_active: true, rules: [] }];
      }
      if (path.includes("dataset_id=4")) {
        return [{ id: 20, name: "Rule B", dataset_id: 4, is_active: true, rules: [] }];
      }
      throw new Error(`Unhandled ${path}`);
    });

    function Harness() {
      const [datasetId, setDatasetId] = useState<number | undefined>(3);
      const [config, setConfig] = useState<Record<string, unknown>>({
        quality_rule_id: 10,
        block_on_fail: true,
      });
      return (
        <div>
          <button type="button" data-testid="switch-dataset" onClick={() => setDatasetId(4)}>
            Switch
          </button>
          <pre data-testid="quality-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm
            projectId="7"
            nodeType="quality_check"
            config={config}
            onChange={setConfig}
            upstreamDatasetId={datasetId}
          />
        </div>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("node-config-quality-rule")).toHaveValue("10"));
    fireEvent.click(screen.getByTestId("switch-dataset"));
    await waitFor(() => {
      expect(screen.getByTestId("quality-config")).not.toHaveTextContent('"quality_rule_id":10');
    });
    expect(screen.getByTestId("node-config-quality-rule")).toHaveValue("");
  });

  it("keeps quality_rule_id when rule list fetch fails", async () => {
    apiMock.mockRejectedValue(new Error("rules unavailable"));
    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>({
        quality_rule_id: 10,
        block_on_fail: true,
      });
      return (
        <div>
          <pre data-testid="quality-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm
            projectId="7"
            nodeType="quality_check"
            config={config}
            onChange={setConfig}
            upstreamDatasetId={3}
          />
        </div>
      );
    }
    render(<Harness />);
    await screen.findByTestId("node-config-quality-hint");
    expect(screen.getByTestId("node-config-quality-hint")).toHaveTextContent(/unavailable/i);
    expect(screen.getByTestId("quality-config")).toHaveTextContent('"quality_rule_id":10');
  });
});

describe("PipelineBuilder", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    stubBuilderApi();
  });

  it("adds a node from the library and marks dirty", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    expect(await screen.findByTestId("pipeline-step-name")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-step-type")).toHaveTextContent(/Dataset Load/i);
  });

  it("renames a step label", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-add-node");
    fireEvent.click(screen.getByTestId("pipeline-add-node"));
    const nameInput = await screen.findByTestId("pipeline-step-name");
    fireEvent.change(nameInput, { target: { value: "Load iris" } });
    expect(nameInput).toHaveValue("Load iris");
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
  });

  it("marks dirty after add and clears after save", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-add-node");
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-add-node"));
    expect(screen.getByTestId("pipeline-dirty-badge")).toHaveTextContent("Unsaved changes");
    fireEvent.click(screen.getByTestId("pipeline-save"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    });
    expect(
      apiMock.mock.calls.some(
        ([path, init]) => path === "/projects/7/pipelines/9/versions" && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("disables publish and run while unsaved", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-add-node");
    fireEvent.click(screen.getByTestId("pipeline-add-node"));
    expect(screen.getByTestId("pipeline-publish")).toBeDisabled();
    expect(screen.getByTestId("pipeline-run")).toBeDisabled();
    expect(screen.getByTestId("pipeline-dirty-hint")).toBeInTheDocument();
  });

  it("blocks publish when validate returns invalid", async () => {
    stubBuilderApi({
      validate: {
        valid: false,
        errors: ["Node 'training-1' requires a non-empty target_column."],
      },
    });
    renderBuilder();
    await screen.findByTestId("pipeline-publish");
    expect(screen.getByTestId("pipeline-publish")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("pipeline-publish"));
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-validation-errors")).toHaveTextContent(
        /non-empty target_column/i,
      );
    });
    expect(
      apiMock.mock.calls.some(
        ([path, init]) => path === "/projects/7/pipelines/9/publish" && init?.method === "POST",
      ),
    ).toBe(false);
  });
});

describe("PipelineRunDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("shows label and attempt when present", async () => {
    const runPayload = {
      id: 42,
      pipeline_id: 9,
      pipeline_version_id: 1,
      status: "failed",
      parameters: {},
      node_states: {
        "training-1": {
          status: "failed",
          label: "Train model",
          node_type: "training",
          attempt: 2,
          error: "boom",
        },
      },
      node_artifacts: {},
      fail_policy: "stop",
      scheduled_for: null,
      logs: "failed",
      error_message: "boom",
      created_at: "2026-08-10T10:00:00Z",
      started_at: null,
      finished_at: null,
    };
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipeline-runs/42") return runPayload;
      if (path === "/projects/7/pipeline-versions/1") {
        return {
          id: 1,
          pipeline_id: 9,
          project_id: 7,
          version: 1,
          graph: {
            nodes: [
              {
                id: "training-1",
                position: { x: 0, y: 0 },
                data: {
                  label: "Train model",
                  node_type: "training",
                  config: {},
                },
              },
            ],
            edges: [],
          },
          created_at: "2026-08-10T10:00:00Z",
        };
      }
      throw new Error(`Unhandled ${path}`);
    });
    renderRunDetail();
    const card = await screen.findByTestId("pipeline-run-step-training-1");
    expect(within(card).getByRole("heading", { name: "Train model" })).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-run-attempt-training-1")).toHaveTextContent("Attempt 2");
    expect(screen.getByTestId("pipeline-rerun-note")).toHaveTextContent(/Rerun from failed/i);
  });

  it("renders legacy node_states without label or attempt", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipeline-runs/42") {
        return {
          id: 42,
          pipeline_id: 9,
          pipeline_version_id: 1,
          status: "succeeded",
          parameters: {},
          node_states: {
            "dataset_load-9": { status: "succeeded" },
          },
          node_artifacts: {},
          fail_policy: "stop",
          scheduled_for: null,
          logs: "ok",
          error_message: null,
          created_at: "2026-08-10T10:00:00Z",
          started_at: null,
          finished_at: null,
        };
      }
      if (path === "/projects/7/pipeline-versions/1") {
        return {
          id: 1,
          pipeline_id: 9,
          project_id: 7,
          version: 1,
          graph: { nodes: [], edges: [] },
          created_at: "2026-08-10T10:00:00Z",
        };
      }
      throw new Error(`Unhandled ${path}`);
    });
    renderRunDetail();
    const card = await screen.findByTestId("pipeline-run-step-dataset_load-9");
    expect(within(card).getByRole("heading", { name: "dataset_load-9" })).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-run-attempt-dataset_load-9")).toHaveTextContent("Attempt 1");
    expect(screen.queryByTestId("pipeline-rerun-note")).not.toBeInTheDocument();
  });
});
