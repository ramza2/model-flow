import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, type PipelineCopilotDraftResponse } from "../api";
import { NodeConfigForm } from "../pipelineForms";
import { defaultConfigFor } from "../pipelineHelpers";
import { PipelineBuilder, PipelineRunDetail, Pipelines } from "./Pipelines";

const apiMock = vi.fn();
const navigateMock = vi.fn();
const canWriteRef = { value: true };

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
  userCanProject: () => canWriteRef.value,
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
    onInit,
    onNodesChange,
    onConnect,
    nodesDraggable,
    nodesConnectable,
    deleteKeyCode,
    children,
  }: {
    nodes: Array<{ id: string; data: { label: string } }>;
    onNodeClick?: (_: unknown, node: { id: string; data: { label: string } }) => void;
    onInit?: (instance: { setCenter: () => void; getZoom: () => number }) => void;
    onNodesChange?: (changes: Array<{ type: string; id?: string }>) => void;
    onConnect?: (connection: { source: string; target: string }) => void;
    nodesDraggable?: boolean;
    nodesConnectable?: boolean;
    deleteKeyCode?: string[] | null;
    children?: ReactNode;
  }) => {
    useEffect(() => {
      onInit?.({ setCenter: () => undefined, getZoom: () => 1 });
    }, [onInit]);
    return (
      <div
        data-testid="react-flow"
        data-draggable={String(Boolean(nodesDraggable))}
        data-connectable={String(Boolean(nodesConnectable))}
        data-delete-enabled={deleteKeyCode == null ? "false" : "true"}
      >
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
        {nodes[0] && (
          <>
            <button
              type="button"
              data-testid="react-flow-force-remove"
              onClick={() => onNodesChange?.([{ type: "remove", id: nodes[0].id }])}
            >
              force-remove
            </button>
            <button
              type="button"
              data-testid="react-flow-force-connect"
              onClick={() =>
                onConnect?.({ source: nodes[0].id, target: nodes[0].id })
              }
            >
              force-connect
            </button>
          </>
        )}
        {children}
      </div>
    );
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  addEdge: (edge: Record<string, unknown>, edges: unknown[]) => [
    ...edges,
    { id: `e-${edges.length}`, ...edge },
  ],
  applyEdgeChanges: (changes: Array<{ type: string; id?: string }>, edges: Array<{ id: string }>) => {
    let next = [...edges];
    for (const change of changes) {
      if (change.type === "remove" && change.id) {
        next = next.filter((edge) => edge.id !== change.id);
      }
    }
    return next;
  },
  applyNodeChanges: (
    changes: Array<{ type: string; id?: string }>,
    nodes: Array<{ id: string }>,
  ) => {
    let next = [...nodes];
    for (const change of changes) {
      if (change.type === "remove" && change.id) {
        next = next.filter((node) => node.id !== change.id);
      }
    }
    return next;
  },
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

  it("excludes time column from target and feature choices in training form", async () => {
    apiMock.mockResolvedValue({
      algorithms: [
        {
          id: "random_forest",
          display_name: "Random forest",
          problem_types: ["classification", "regression"],
          default_hyperparameters: { n_estimators: 10 },
          supported_hyperparameters: [],
          hyperparameters: [],
        },
      ],
    });

    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>({
        target_column: "event_time",
        problem_type: "classification",
        algorithm: "random_forest",
        feature_columns: ["a", "b"],
        hyperparameters: { n_estimators: 10 },
        split_strategy: "random",
        time_column: "event_time",
      });
      return (
        <div>
          <pre data-testid="training-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm
            projectId="7"
            nodeType="training"
            config={config}
            onChange={setConfig}
            datasetColumns={["event_time", "a", "b", "target"]}
          />
        </div>
      );
    }
    render(<Harness />);
    await screen.findByTestId("node-config-split-strategy");
    // Enabling time mode while target == time_column must reassign the target.
    fireEvent.change(screen.getByTestId("node-config-split-strategy"), {
      target: { value: "time" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("training-config")).toHaveTextContent(
        '"split_strategy":"time"',
      );
      expect(screen.getByTestId("training-config")).not.toHaveTextContent(
        '"target_column":"event_time"',
      );
    });
    const targetSelect = screen.getByTestId("node-config-target") as HTMLSelectElement;
    expect([...targetSelect.options].map((option) => option.value)).not.toContain("event_time");
    expect(screen.getByTestId("node-config-features")).not.toHaveTextContent("event_time");
  });

  it("configures forecasting training with locked regression/time and capability filtering", async () => {
    apiMock.mockResolvedValue({
      algorithms: [
        {
          id: "sgd_regressor",
          display_name: "SGD regressor",
          problem_types: ["regression"],
          default_hyperparameters: {},
          supported_hyperparameters: [],
          hyperparameters: [],
          supports_forecasting: false,
          forecasting_strategy: "unsupported",
        },
        {
          id: "ridge",
          display_name: "Ridge",
          problem_types: ["regression"],
          default_hyperparameters: { alpha: 1 },
          supported_hyperparameters: [],
          hyperparameters: [],
          supports_forecasting: true,
          forecasting_strategy: "direct_multioutput",
        },
        {
          id: "random_forest",
          display_name: "Random forest",
          problem_types: ["classification", "regression"],
          default_hyperparameters: { n_estimators: 10 },
          supported_hyperparameters: [],
          hyperparameters: [],
          supports_forecasting: false,
          forecasting_strategy: "unsupported",
        },
      ],
    });

    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>({
        ...defaultConfigFor("training"),
        target_column: "sales",
        feature_columns: ["sales_lag_1", "sales_roll_avg_3", "event_time"],
        algorithm: "random_forest",
      });
      return (
        <div>
          <pre data-testid="training-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm
            projectId="7"
            nodeType="training"
            config={config}
            onChange={setConfig}
            datasetColumns={["event_time", "sales", "sales_lag_1", "sales_roll_avg_3"]}
          />
        </div>
      );
    }
    render(<Harness />);
    await screen.findByTestId("node-config-training-task");
    expect(screen.getByTestId("node-config-training-task")).toHaveValue("tabular");

    fireEvent.change(screen.getByTestId("node-config-training-task"), {
      target: { value: "forecasting" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("training-config")).toHaveTextContent('"training_task":"forecasting"');
      expect(screen.getByTestId("training-config")).toHaveTextContent('"problem_type":"regression"');
      expect(screen.getByTestId("training-config")).toHaveTextContent('"split_strategy":"time"');
      expect(screen.getByTestId("training-config")).toHaveTextContent(
        '"forecast_strategy":"direct_multioutput"',
      );
    });
    expect(screen.getByTestId("node-config-problem-type")).toBeDisabled();
    expect(screen.getByTestId("node-config-split-strategy")).toBeDisabled();
    expect(screen.getByTestId("node-config-forecast-horizons")).toBeInTheDocument();
    expect(screen.getByTestId("node-config-forecast-horizons-help")).toHaveTextContent(
      /observation steps/i,
    );
    expect(screen.getByTestId("node-config-forecast-help")).toHaveTextContent(/Lag \/ Rolling/i);

    await waitFor(() => {
      const algorithm = screen.getByTestId("node-config-algorithm") as HTMLSelectElement;
      const values = [...algorithm.options].map((option) => option.value);
      expect(values).toContain("ridge");
      expect(values).not.toContain("sgd_regressor");
      expect(values).not.toContain("random_forest");
    });

    fireEvent.change(screen.getByTestId("node-config-time-column"), {
      target: { value: "event_time" },
    });
    fireEvent.change(screen.getByTestId("node-config-target"), {
      target: { value: "sales" },
    });
    fireEvent.change(screen.getByTestId("node-config-forecast-horizons"), {
      target: { value: "1, 2, 3" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("training-config")).toHaveTextContent('"forecast_horizons":[1,2,3]');
      expect(screen.getByTestId("training-config")).toHaveTextContent('"time_column":"event_time"');
    });
    expect(screen.getByTestId("node-config-features")).toHaveTextContent("sales_lag_1");
    expect(screen.getByTestId("node-config-features")).toHaveTextContent("sales_roll_avg_3");
    expect(screen.getByTestId("node-config-features")).not.toHaveTextContent("event_time");
    const featureLabels = [...screen.getByTestId("node-config-features").querySelectorAll("label")].map(
      (label) => label.textContent?.trim(),
    );
    expect(featureLabels).not.toContain("sales");

    fireEvent.change(screen.getByTestId("node-config-forecast-horizons"), {
      target: { value: "1, 1, 2" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("node-config-forecast-horizon-error")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("node-config-training-task"), {
      target: { value: "tabular" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("training-config")).toHaveTextContent('"training_task":"tabular"');
      expect(screen.getByTestId("training-config")).toHaveTextContent('"forecast_strategy":null');
      expect(screen.getByTestId("training-config")).toHaveTextContent('"forecast_horizons":[]');
    });
    expect(screen.queryByTestId("node-config-forecast-fields")).not.toBeInTheDocument();
  });

  it("supports Split node Random / Time ordered UX", () => {
    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>(defaultConfigFor("split"));
      return (
        <div>
          <pre data-testid="split-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm
            projectId="7"
            nodeType="split"
            config={config}
            onChange={setConfig}
            datasetColumns={["event_time", "sales"]}
          />
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("node-config-split-strategy")).toHaveValue("random");
    expect(screen.queryByTestId("node-config-time-column")).not.toBeInTheDocument();
    expect(screen.queryByTestId("node-config-split-seed-hint")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("node-config-split-strategy"), {
      target: { value: "time" },
    });
    expect(screen.getByTestId("split-config")).toHaveTextContent('"split_strategy":"time"');
    expect(screen.getByTestId("node-config-time-column")).toBeInTheDocument();
    expect(screen.getByTestId("node-config-split-time-help")).toHaveTextContent(/chronologically/i);
    expect(screen.getByTestId("node-config-split-seed-hint")).toHaveTextContent(
      /does not shuffle/i,
    );
    fireEvent.change(screen.getByTestId("node-config-time-column"), {
      target: { value: "event_time" },
    });
    expect(screen.getByTestId("split-config")).toHaveTextContent('"time_column":"event_time"');
    expect(screen.getByTestId("node-config-seed")).toBeInTheDocument();
  });
});

describe("PipelineBuilder", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    canWriteRef.value = true;
    stubBuilderApi();
  });

  it("adds a node from the library and marks dirty", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    expect(screen.getByTestId("pipeline-builder-layout")).toHaveAttribute("data-readonly", "false");
    expect(screen.getByTestId("pipeline-builder-layout")).not.toHaveClass("is-readonly");
    expect(screen.queryByTestId("pipeline-add-node")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    expect(await screen.findByTestId("pipeline-step-name")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-step-type")).toHaveTextContent(/Dataset Load/i);
  });

  it("preserves forecasting training config across save and reload", async () => {
    const forecastGraph = {
      nodes: [
        {
          id: "dataset_load-1",
          position: { x: 0, y: 0 },
          data: {
            label: "Load",
            node_type: "dataset_load",
            config: { dataset_id: 3, dataset_version_id: 11 },
          },
        },
        {
          id: "training-1",
          position: { x: 240, y: 0 },
          data: {
            label: "Forecast",
            node_type: "training",
            config: {
              training_task: "forecasting",
              target_column: "sales",
              problem_type: "regression",
              algorithm: "ridge",
              feature_columns: ["sales_lag_1", "sales_roll_avg_3"],
              hyperparameters: {},
              split_strategy: "time",
              time_column: "event_time",
              forecast_strategy: "direct_multioutput",
              forecast_horizons: [1, 2, 3],
            },
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "dataset_load-1",
          target: "training-1",
          sourceHandle: "data",
          targetHandle: "data",
          data: { branch: "always" },
        },
      ],
    };
    const existing = {
      ...pipeline,
      version: { id: 1, version: 1, graph: forecastGraph },
    };
    let savedGraph: unknown = null;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") {
        if (savedGraph) {
          return {
            ...existing,
            latest_version: 2,
            version: { id: 2, version: 2, graph: savedGraph },
          };
        }
        return existing;
      }
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") {
        return [
          {
            ...datasets[0],
            columns: ["event_time", "sales", "sales_lag_1", "sales_roll_avg_3"],
          },
        ];
      }
      if (path === "/projects/7/datasets/3/versions") {
        return [
          {
            ...versions[0],
            columns: ["event_time", "sales", "sales_lag_1", "sales_roll_avg_3"],
          },
        ];
      }
      if (path === "/projects/7/training/algorithms") {
        return {
          algorithms: [
            {
              id: "ridge",
              display_name: "Ridge",
              problem_types: ["regression"],
              default_hyperparameters: {},
              supported_hyperparameters: [],
              hyperparameters: [],
              supports_forecasting: true,
              forecasting_strategy: "direct_multioutput",
            },
          ],
        };
      }
      if (path === "/projects/7/pipelines/9/versions" && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        savedGraph = body.graph;
        return { id: 2, version: 2, graph: body.graph };
      }
      throw new Error(`Unhandled api call ${method} ${path}`);
    });

    renderBuilder();
    await screen.findByTestId("canvas-node-training-1");
    fireEvent.click(screen.getByTestId("canvas-node-training-1"));
    await screen.findByTestId("node-config-training-task");
    expect(screen.getByTestId("node-config-training-task")).toHaveValue("forecasting");
    expect(screen.getByTestId("node-config-forecast-horizons")).toHaveValue("1, 2, 3");
    expect(screen.getByTestId("node-config-time-column")).toHaveValue("event_time");
    expect(screen.getByTestId("node-config-problem-type")).toHaveValue("regression");
    expect(screen.getByTestId("node-config-split-strategy")).toHaveValue("time");

    fireEvent.click(screen.getByTestId("pipeline-library-notification"));
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-save"));
    await waitFor(() => expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument());
    expect(savedGraph).toBeTruthy();
    const trainingNode = (savedGraph as { nodes: Array<{ id: string; data: { config: Record<string, unknown> } }> })
      .nodes.find((node) => node.id === "training-1");
    expect(trainingNode?.data.config).toMatchObject({
      training_task: "forecasting",
      forecast_strategy: "direct_multioutput",
      forecast_horizons: [1, 2, 3],
      split_strategy: "time",
      time_column: "event_time",
      algorithm: "ridge",
    });
  });

  it("keeps new node ids unique against an existing saved graph", async () => {
    const existing = {
      ...pipeline,
      version: {
        id: 1,
        version: 1,
        graph: {
          nodes: [
            {
              id: "dataset_load-1",
              position: { x: 0, y: 0 },
              data: {
                label: "Saved load",
                node_type: "dataset_load",
                config: defaultConfigFor("dataset_load"),
              },
            },
          ],
          edges: [],
        },
      },
    };
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") return existing;
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      throw new Error(`Unhandled api call ${method} ${path}`);
    });
    renderBuilder();
    await screen.findByTestId("canvas-node-dataset_load-1");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    const newId = (await screen.findByTestId("pipeline-node-id")).textContent || "";
    expect(newId).toContain("dataset_load-2");
    expect(newId).not.toContain("dataset_load-1");
    expect(screen.getByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-dataset_load-2")).toBeInTheDocument();
  });

  it("filters the node library with client-side search", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-search");
    fireEvent.change(screen.getByTestId("pipeline-library-search"), {
      target: { value: "notification" },
    });
    expect(screen.getByTestId("pipeline-library-notification")).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-library-dataset_load")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("pipeline-library-search"), {
      target: { value: "zzzz-missing" },
    });
    expect(screen.getByTestId("pipeline-library-empty")).toHaveTextContent(/No matching nodes/i);
  });

  it("blocks graph mutation for read-only users", async () => {
    canWriteRef.value = false;
    const existing = {
      ...pipeline,
      version: {
        id: 1,
        version: 1,
        graph: {
          nodes: [
            {
              id: "dataset_load-1",
              position: { x: 0, y: 0 },
              data: {
                label: "Saved load",
                node_type: "dataset_load",
                config: defaultConfigFor("dataset_load"),
              },
            },
          ],
          edges: [],
        },
      },
    };
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipelines/9") return existing;
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      throw new Error(`Unhandled ${path}`);
    });
    renderBuilder();
    const layout = await screen.findByTestId("pipeline-builder-layout");
    expect(layout).toHaveClass("is-readonly");
    expect(layout).toHaveAttribute("data-readonly", "true");
    expect(screen.getByTestId("pipeline-inspector-hint")).toHaveTextContent(
      /inspect its configuration/i,
    );
    expect(screen.getByTestId("pipeline-inspector-hint")).not.toHaveTextContent(/node library/i);
    const flow = await screen.findByTestId("react-flow");
    expect(flow).toHaveAttribute("data-draggable", "false");
    expect(flow).toHaveAttribute("data-connectable", "false");
    expect(flow).toHaveAttribute("data-delete-enabled", "false");
    expect(screen.queryByTestId("pipeline-library-dataset_load")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-add-node")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("canvas-node-dataset_load-1"));
    expect(await screen.findByTestId("pipeline-step-name")).toBeDisabled();
    expect(screen.getByText(/Read-only configuration/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("react-flow-force-remove"));
    fireEvent.click(screen.getByTestId("react-flow-force-connect"));
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
  });

  it("shows a non-action empty state for read-only users", async () => {
    canWriteRef.value = false;
    stubBuilderApi();
    renderBuilder();
    expect(await screen.findByText(/This pipeline version contains no steps/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Dataset Load/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-builder-layout")).toHaveClass("is-readonly");
    expect(screen.getByTestId("pipeline-inspector-hint")).toHaveTextContent(
      /inspect its configuration/i,
    );
  });

  it("renames a step label", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    const nameInput = await screen.findByTestId("pipeline-step-name");
    fireEvent.change(nameInput, { target: { value: "Load iris" } });
    expect(nameInput).toHaveValue("Load iris");
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
  });

  it("marks dirty after add and clears after save", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
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
    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
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

  it("selects the failing node from a validation issue", async () => {
    const graphPipeline = {
      ...pipeline,
      version: {
        id: 1,
        version: 1,
        graph: {
          nodes: [
            {
              id: "training-1",
              position: { x: 40, y: 40 },
              data: {
                label: "Train model",
                node_type: "training",
                config: defaultConfigFor("training"),
              },
            },
          ],
          edges: [],
        },
      },
    };
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") return graphPipeline;
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/pipelines/9/validate" && method === "POST") {
        return {
          valid: false,
          errors: ["Node 'training-1' requires a non-empty target_column."],
        };
      }
      throw new Error(`Unhandled api call ${method} ${path}`);
    });
    renderBuilder();
    await screen.findByTestId("canvas-node-training-1");
    fireEvent.click(screen.getByTestId("pipeline-validate"));
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-validation-issue-training-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("pipeline-validation-issue-training-1"));
    expect(await screen.findByTestId("pipeline-node-id")).toHaveTextContent("training-1");
    expect(screen.getByTestId("pipeline-step-name")).toHaveValue("Train model");
  });
});

describe("PipelineRunDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
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
    expect(screen.getByTestId("pipeline-rerun-note")).toHaveTextContent(
      /Restarted steps show Attempt 2 or higher/i,
    );
    expect(screen.getByTestId("pipeline-rerun-note")).not.toHaveTextContent(/reused/i);
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

describe("Pipeline contextual scheduling gates", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
  });

  it("exposes Schedule link only for published pipelines in the catalog", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipelines") {
        return [
          { ...pipeline, id: 1, name: "Draft pipe", status: "draft" },
          { ...pipeline, id: 2, name: "Live pipe", status: "published" },
        ];
      }
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/projects/7/pipelines"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines" element={<Pipelines />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Live pipe")).toBeInTheDocument();
    const published = screen.getByTestId("pipeline-schedule-2");
    expect(published.tagName).toBe("A");
    expect(published).toHaveAttribute(
      "href",
      "/projects/7/schedules?create=1&target_type=pipeline_run&pipeline_id=2",
    );
    const draft = screen.getByTestId("pipeline-schedule-1");
    expect(draft.tagName).toBe("BUTTON");
    expect(draft).toBeDisabled();
    expect(draft).toHaveAttribute("title", "Publish this pipeline before scheduling.");
  });

  it("blocks builder Schedule when draft or dirty, allows when published and clean", async () => {
    stubBuilderApi();
    renderBuilder();
    const draftSchedule = await screen.findByTestId("pipeline-schedule-entry");
    expect(draftSchedule.tagName).toBe("BUTTON");
    expect(draftSchedule).toBeDisabled();
    expect(draftSchedule).toHaveAttribute("title", "Publish this pipeline before scheduling.");
  });

  it("allows builder Schedule for clean published pipelines and blocks when dirty", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") return { ...pipeline, status: "published" };
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/3/versions") return versions;
      if (path === "/projects/7/pipelines/9/versions" && method === "POST") {
        return { id: 2, version: 2, graph: JSON.parse(String(init?.body || "{}")).graph };
      }
      if (path === "/projects/7/pipelines/9/validate" && method === "POST") {
        return { valid: true, errors: [] };
      }
      throw new Error(`Unhandled ${path} ${method}`);
    });
    renderBuilder();
    const publishedClean = await screen.findByTestId("pipeline-schedule-entry");
    await waitFor(() => expect(publishedClean.tagName).toBe("A"));
    expect(publishedClean).toHaveAttribute(
      "href",
      "/projects/7/schedules?create=1&target_type=pipeline_run&pipeline_id=9",
    );
    expect(publishedClean).not.toHaveAttribute("aria-disabled");

    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    await waitFor(() => expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument());
    const dirtySchedule = screen.getByTestId("pipeline-schedule-entry");
    expect(dirtySchedule.tagName).toBe("BUTTON");
    expect(dirtySchedule).toBeDisabled();
    expect(dirtySchedule).toHaveAttribute(
      "title",
      expect.stringContaining("Save your changes before scheduling"),
    );
  });
});

const forecastCopilotDraft: PipelineCopilotDraftResponse = {
  summary: "Forecasting pipeline for sales",
  model: "test-model",
  warnings: [],
  validation: { valid: true, errors: [], order: ["dataset_load-1", "training-1"] },
  graph: {
    nodes: [
      {
        id: "dataset_load-1",
        position: { x: 40, y: 40 },
        data: {
          label: "Load sales",
          node_type: "dataset_load",
          config: { dataset_id: 3, dataset_version_id: 11 },
        },
      },
      {
        id: "training-1",
        position: { x: 320, y: 40 },
        data: {
          label: "Forecast train",
          node_type: "training",
          config: {
            training_task: "forecasting",
            target_column: "sales",
            problem_type: "regression",
            algorithm: "ridge",
            feature_columns: ["sales_lag_1", "sales_roll_avg_3"],
            hyperparameters: {},
            split_strategy: "time",
            time_column: "event_time",
            forecast_strategy: "direct_multioutput",
            forecast_horizons: [1, 2, 3],
          },
        },
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "dataset_load-1",
        target: "training-1",
        sourceHandle: "data",
        targetHandle: "data",
        data: { branch: "always" },
      },
    ],
  },
};

function stubBuilderApiWithCopilot(options?: {
  draft?: PipelineCopilotDraftResponse | (() => PipelineCopilotDraftResponse);
  draftError?: ApiRequestError;
}) {
  stubBuilderApi();
  const base = apiMock.getMockImplementation();
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    if (path === "/projects/7/pipeline-copilot/draft" && method === "POST") {
      if (options?.draftError) throw options.draftError;
      const draft =
        typeof options?.draft === "function"
          ? options.draft()
          : options?.draft || forecastCopilotDraft;
      return draft;
    }
    if (path === "/projects/7/training/algorithms") {
      return {
        algorithms: [
          {
            id: "ridge",
            display_name: "Ridge",
            problem_types: ["regression"],
            default_hyperparameters: {},
            supported_hyperparameters: [],
            hyperparameters: [],
            supports_forecasting: true,
            forecasting_strategy: "direct_multioutput",
          },
        ],
      };
    }
    if (path === "/projects/7/datasets") {
      return [
        {
          ...datasets[0],
          columns: ["event_time", "sales", "sales_lag_1", "sales_roll_avg_3"],
        },
      ];
    }
    if (path === "/projects/7/datasets/3/versions") {
      return [
        {
          ...versions[0],
          columns: ["event_time", "sales", "sales_lag_1", "sales_roll_avg_3"],
        },
      ];
    }
    if (path === "/projects/7/datasets/3/versions/11") {
      return {
        ...versions[0],
        columns: ["event_time", "sales", "sales_lag_1", "sales_roll_avg_3"],
      };
    }
    return base?.(path, init);
  });
}

describe("Pipeline Copilot (Phase 7-B)", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    canWriteRef.value = true;
    stubBuilderApiWithCopilot();
  });

  it("shows Copilot entry for writers and hides it for read-only users", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-copilot-entry");
    expect(screen.getByTestId("pipeline-copilot-open")).toBeInTheDocument();
    cleanup();

    canWriteRef.value = false;
    renderBuilder();
    await screen.findByTestId("pipeline-builder-layout");
    expect(screen.queryByTestId("pipeline-copilot-entry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-copilot-open")).not.toBeInTheDocument();
  });

  it("disables Generate for a blank trimmed prompt and sends only {prompt}", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    const generate = await screen.findByTestId("pipeline-copilot-generate");
    expect(generate).toBeDisabled();
    fireEvent.change(screen.getByTestId("pipeline-copilot-prompt"), {
      target: { value: "   " },
    });
    expect(generate).toBeDisabled();
    fireEvent.change(screen.getByTestId("pipeline-copilot-prompt"), {
      target: { value: "  Create a forecasting pipeline  " },
    });
    expect(generate).not.toBeDisabled();
    fireEvent.click(generate);
    await screen.findByTestId("pipeline-copilot-preview");
    const draftCall = apiMock.mock.calls.find(
      ([path, init]) =>
        path === "/projects/7/pipeline-copilot/draft" &&
        (init?.method || "GET").toUpperCase() === "POST",
    );
    expect(draftCall).toBeTruthy();
    expect(JSON.parse(String(draftCall?.[1]?.body))).toEqual({
      prompt: "Create a forecasting pipeline",
    });
  });

  it("renders preview metadata without mutating Builder or dirty state", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-copilot-open");
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Create a forecasting pipeline" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-summary")).toHaveTextContent(
      /Forecasting pipeline for sales/i,
    );
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent(/Valid draft/i);
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent(/2 nodes/i);
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent(/test-model/i);
    expect(
      within(screen.getByTestId("pipeline-copilot-preview-canvas")).getByTestId(
        "canvas-node-training-1",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']")).toHaveLength(0);
    expect(screen.getByTestId("pipeline-publish")).not.toBeDisabled();
  });

  it("closing Preview without Apply leaves Builder unchanged", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Draft something" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await screen.findByTestId("pipeline-copilot-preview");
    fireEvent.click(screen.getByTestId("drawer-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-copilot-drawer")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']")).toHaveLength(0);
  });

  it("blocks Apply for invalid drafts and shows validation errors", async () => {
    stubBuilderApiWithCopilot({
      draft: {
        ...forecastCopilotDraft,
        validation: {
          valid: false,
          errors: ["Node 'dataset_load-1' dataset_load requires an exact dataset_version_id."],
          order: [],
        },
        warnings: ["Draft is structurally safe but failed strict ModelFlow validation."],
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Incomplete draft" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-apply-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-copilot-validation-errors")).toHaveTextContent(
      /exact dataset_version_id/i,
    );
    expect(screen.getByTestId("pipeline-copilot-warnings")).toHaveTextContent(
      /failed strict ModelFlow validation/i,
    );
    expect(screen.getByTestId("pipeline-copilot-apply")).toBeDisabled();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
  });

  it("requires confirmation, warns when dirty, and applies without Save/Publish/Run", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-library-dataset_load"));
    expect(await screen.findByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    const versionPostsBefore = apiMock.mock.calls.filter(
      ([path, init]) =>
        path === "/projects/7/pipelines/9/versions" &&
        (init?.method || "").toUpperCase() === "POST",
    ).length;

    fireEvent.click(screen.getByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Create a forecasting pipeline" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await screen.findByTestId("pipeline-copilot-apply");
    fireEvent.click(screen.getByTestId("pipeline-copilot-apply"));
    expect(await screen.findByTestId("pipeline-copilot-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-copilot-dirty-warning")).toHaveTextContent(
      /unsaved Builder changes/i,
    );
    fireEvent.click(screen.getByTestId("pipeline-copilot-confirm-back"));
    expect(screen.queryByTestId("pipeline-copilot-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pipeline-copilot-apply"));
    fireEvent.click(await screen.findByTestId("pipeline-copilot-confirm-apply"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-copilot-drawer")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-publish")).toBeDisabled();
    expect(screen.getByTestId("pipeline-run")).toBeDisabled();
    expect(await screen.findByTestId("canvas-node-training-1")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("canvas-node-training-1"));
    expect(await screen.findByTestId("pipeline-step-name")).toHaveValue("Forecast train");
    await waitFor(() => {
      expect(screen.getByTestId("node-config-training-task")).toHaveValue("forecasting");
      expect(screen.getByTestId("node-config-target")).toHaveValue("sales");
      expect(screen.getByTestId("node-config-algorithm")).toHaveValue("ridge");
      expect(screen.getByTestId("node-config-forecast-horizons")).toHaveValue("1, 2, 3");
    });

    const versionPostsAfter = apiMock.mock.calls.filter(
      ([path, init]) =>
        path === "/projects/7/pipelines/9/versions" &&
        (init?.method || "").toUpperCase() === "POST",
    ).length;
    expect(versionPostsAfter).toBe(versionPostsBefore);
    expect(
      apiMock.mock.calls.some(
        ([path, init]) =>
          path === "/projects/7/pipelines/9/publish" &&
          (init?.method || "").toUpperCase() === "POST",
      ),
    ).toBe(false);
    expect(
      apiMock.mock.calls.some(
        ([path, init]) =>
          path === "/projects/7/pipelines/9/run" &&
          (init?.method || "").toUpperCase() === "POST",
      ),
    ).toBe(false);

    fireEvent.click(screen.getByTestId("pipeline-save"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    });
    const saveCall = apiMock.mock.calls.find(
      ([path, init]) =>
        path === "/projects/7/pipelines/9/versions" &&
        (init?.method || "").toUpperCase() === "POST",
    );
    const savedGraph = JSON.parse(String(saveCall?.[1]?.body)).graph;
    expect(savedGraph.nodes[1].data.config.training_task).toBe("forecasting");
    expect(savedGraph.nodes[1].data.config.forecast_horizons).toEqual([1, 2, 3]);
    expect(savedGraph.nodes[0].data.config.dataset_version_id).toBe(11);
  });

  it("leaves graph and dirty unchanged on Copilot 503 errors", async () => {
    stubBuilderApiWithCopilot({
      draftError: new ApiRequestError(
        503,
        "Pipeline Copilot is not configured.",
        "Set MODELFLOW_LLM_BASE_URL and MODELFLOW_LLM_MODEL on the backend.",
      ),
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Anything" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-error")).toHaveTextContent(
      /not configured/i,
    );
    expect(screen.queryByTestId("pipeline-copilot-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']")).toHaveLength(0);
  });

  it("Generate-again replaces preview only and resets confirmation", async () => {
    let call = 0;
    stubBuilderApiWithCopilot({
      draft: () => {
        call += 1;
        return {
          ...forecastCopilotDraft,
          summary: call === 1 ? "First draft" : "Second draft",
          model: call === 1 ? "model-a" : "model-b",
        };
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "First" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-summary")).toHaveTextContent("First draft");
    fireEvent.click(screen.getByTestId("pipeline-copilot-apply"));
    expect(await screen.findByTestId("pipeline-copilot-confirm")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("pipeline-copilot-prompt"), {
      target: { value: "Second" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-copilot-summary")).toHaveTextContent("Second draft");
    });
    expect(screen.queryByTestId("pipeline-copilot-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent("model-b");
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
  });

  it("ignores a Copilot response after the Drawer is closed mid-flight", async () => {
    let resolveDraft!: (value: PipelineCopilotDraftResponse) => void;
    const pending = new Promise<PipelineCopilotDraftResponse>((resolve) => {
      resolveDraft = resolve;
    });
    stubBuilderApi();
    const base = apiMock.getMockImplementation();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipeline-copilot/draft" && method === "POST") {
        return pending;
      }
      return base?.(path, init);
    });

    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Create a forecasting pipeline" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-loading")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-copilot-generate")).toBeDisabled();

    fireEvent.click(screen.getByTestId("drawer-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-copilot-drawer")).not.toBeInTheDocument();
    });

    resolveDraft({
      ...forecastCopilotDraft,
      summary: "Stale draft after close",
    });
    await Promise.resolve();

    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    expect(await screen.findByTestId("pipeline-copilot-drawer")).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-copilot-preview")).not.toBeInTheDocument();
    expect(screen.queryByText(/Stale draft after close/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-copilot-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-copilot-error")).not.toBeInTheDocument();
    // Prompt is preserved for editing, but stale loading/error/preview must not return.
    expect(screen.getByTestId("pipeline-copilot-generate")).not.toBeDisabled();
    expect(screen.getByTestId("pipeline-copilot-generate")).toHaveTextContent(/^Generate$/);
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']"),
    ).toHaveLength(0);
    expect(
      apiMock.mock.calls.some(
        ([path, init]) =>
          (path === "/projects/7/pipelines/9/versions" ||
            path === "/projects/7/pipelines/9/publish" ||
            path === "/projects/7/pipelines/9/run") &&
          (init?.method || "").toUpperCase() === "POST",
      ),
    ).toBe(false);
  });

  it("does not let an older Copilot response overwrite a newer generation", async () => {
    type Deferred = {
      promise: Promise<PipelineCopilotDraftResponse>;
      resolve: (value: PipelineCopilotDraftResponse) => void;
    };
    const deferreds: Deferred[] = [];
    stubBuilderApi();
    const base = apiMock.getMockImplementation();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipeline-copilot/draft" && method === "POST") {
        let resolve!: (value: PipelineCopilotDraftResponse) => void;
        const promise = new Promise<PipelineCopilotDraftResponse>((res) => {
          resolve = res;
        });
        deferreds.push({ promise, resolve });
        return promise;
      }
      return base?.(path, init);
    });

    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "First" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await waitFor(() => expect(deferreds.length).toBe(1));
    expect(screen.getByTestId("pipeline-copilot-loading")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("drawer-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-copilot-drawer")).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Second" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await waitFor(() => expect(deferreds.length).toBe(2));
    expect(screen.getByTestId("pipeline-copilot-loading")).toBeInTheDocument();

    deferreds[1].resolve({
      ...forecastCopilotDraft,
      summary: "Second draft",
      model: "model-b",
    });
    expect(await screen.findByTestId("pipeline-copilot-summary")).toHaveTextContent("Second draft");
    expect(screen.queryByTestId("pipeline-copilot-loading")).not.toBeInTheDocument();

    deferreds[0].resolve({
      ...forecastCopilotDraft,
      summary: "First draft",
      model: "model-a",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByTestId("pipeline-copilot-summary")).toHaveTextContent("Second draft");
    expect(screen.queryByText(/First draft/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent("model-b");
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']"),
    ).toHaveLength(0);
  });
});
