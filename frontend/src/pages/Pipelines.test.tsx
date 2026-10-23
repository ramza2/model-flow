import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, type PipelineCopilotDraftResponse, type PipelineCopilotPatchResponse } from "../api";
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

const flowSetCenterMock = vi.fn();
const flowGetZoomMock = vi.fn(() => 1.5);

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    edges = [],
    onNodeClick,
    onInit,
    onNodesChange,
    onEdgesChange,
    onConnect,
    nodesDraggable,
    nodesConnectable,
    deleteKeyCode,
    children,
  }: {
    nodes: Array<{
      id: string;
      position?: { x: number; y: number };
      data: { label: string; node_type?: string };
    }>;
    edges?: Array<{ id: string; source: string; target: string; sourceHandle?: string | null }>;
    onNodeClick?: (_: unknown, node: { id: string; data: { label: string } }) => void;
    onInit?: (instance: {
      setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
      getZoom: () => number;
    }) => void;
    onNodesChange?: (
      changes: Array<{
        type: string;
        id?: string;
        position?: { x: number; y: number };
        dragging?: boolean;
      }>,
    ) => void;
    onEdgesChange?: (changes: Array<{ type: string; id?: string }>) => void;
    onConnect?: (connection: {
      source: string;
      target: string;
      sourceHandle?: string | null;
    }) => void;
    nodesDraggable?: boolean;
    nodesConnectable?: boolean;
    deleteKeyCode?: string[] | null;
    children?: ReactNode;
  }) => {
    useEffect(() => {
      onInit?.({ setCenter: flowSetCenterMock, getZoom: flowGetZoomMock });
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
            data-x={String(node.position?.x ?? 0)}
            data-y={String(node.position?.y ?? 0)}
            onClick={() => onNodeClick?.({}, node)}
          >
            {node.data.label}
          </button>
        ))}
        {edges.map((edge) => (
          <button
            key={edge.id}
            type="button"
            data-testid={`canvas-edge-${edge.id}`}
            data-source-handle={edge.sourceHandle || ""}
          >
            {edge.source}→{edge.target}
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
                onConnect?.({
                  source: nodes[0].id,
                  target: nodes.find((row) => row.id !== nodes[0].id)?.id || nodes[0].id,
                })
              }
            >
              force-connect
            </button>
            <button
              type="button"
              data-testid="react-flow-force-condition-connect"
              onClick={() => {
                const condition = nodes.find((row) => row.data.node_type === "condition");
                const target =
                  nodes.find((row) => row.id !== condition?.id) || nodes[0];
                if (!condition) return;
                onConnect?.({
                  source: condition.id,
                  target: target.id,
                  sourceHandle: "true",
                });
              }}
            >
              force-condition-connect
            </button>
            <button
              type="button"
              data-testid="react-flow-force-drag"
              onClick={() => {
                const id = nodes[0].id;
                onNodesChange?.([
                  { type: "position", id, position: { x: 11, y: 12 }, dragging: true },
                ]);
                onNodesChange?.([
                  { type: "position", id, position: { x: 40, y: 50 }, dragging: true },
                ]);
                onNodesChange?.([
                  { type: "position", id, position: { x: 120, y: 140 }, dragging: false },
                ]);
              }}
            >
              force-drag
            </button>
          </>
        )}
        {edges[0] && (
          <button
            type="button"
            data-testid="react-flow-force-remove-edge"
            onClick={() => onEdgesChange?.([{ type: "remove", id: edges[0].id }])}
          >
            force-remove-edge
          </button>
        )}
        {children}
      </div>
    );
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: ({
    pannable,
    ariaLabel,
    onClick,
    onNodeClick,
  }: {
    pannable?: boolean;
    ariaLabel?: string | null;
    onClick?: (_event: unknown, position: { x: number; y: number }) => void;
    onNodeClick?: (
      _event: unknown,
      node: { position: { x: number; y: number }; width?: number; height?: number },
    ) => void;
  }) => (
    <div
      data-testid="pipeline-minimap"
      data-pannable={String(Boolean(pannable))}
      aria-label={ariaLabel || undefined}
    >
      <button
        type="button"
        data-testid="pipeline-minimap-click"
        onClick={() => onClick?.({}, { x: 320, y: 180 })}
      >
        minimap-click
      </button>
      <button
        type="button"
        data-testid="pipeline-minimap-node-click"
        onClick={() =>
          onNodeClick?.({}, { position: { x: 100, y: 40 }, width: 200, height: 80 })
        }
      >
        minimap-node-click
      </button>
    </div>
  ),
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
    changes: Array<{
      type: string;
      id?: string;
      position?: { x: number; y: number };
    }>,
    nodes: Array<{ id: string; position?: { x: number; y: number } }>,
  ) => {
    let next = [...nodes];
    for (const change of changes) {
      if (change.type === "remove" && change.id) {
        next = next.filter((node) => node.id !== change.id);
      }
      if (change.type === "position" && change.id && change.position) {
        next = next.map((node) =>
          node.id === change.id ? { ...node, position: change.position! } : node,
        );
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
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/datasets") {
        return [
          ...datasets,
          {
            ...datasets[0],
            id: 4,
            name: "sales",
          },
        ];
      }
      if (path === "/projects/7/datasets/4/versions") {
        return [{ ...versions[0], id: 22, dataset_id: 4, version: 1 }];
      }
      return base(path, init);
    });
    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>({});
      return (
        <>
          <NodeConfigForm
            projectId="7"
            nodeType="dataset_load"
            config={config}
            onChange={setConfig}
          />
          <pre data-testid="dataset-load-config">{JSON.stringify(config)}</pre>
        </>
      );
    }
    render(<Harness />);
    expect(await screen.findByTestId("node-config-dataset-load-hint")).toHaveTextContent(
      "사용할 데이터셋을 선택합니다",
    );
    expect(screen.getByTestId("node-config-dataset-load")).toHaveTextContent("데이터셋");
    expect(screen.getByTestId("node-config-dataset-load")).toHaveTextContent("데이터 버전");
    expect(screen.getByTestId("node-config-dataset")).toHaveDisplayValue("데이터셋 선택…");
    fireEvent.change(screen.getByTestId("node-config-dataset"), { target: { value: "3" } });
    await waitFor(() => expect(screen.getByTestId("node-config-version")).not.toBeDisabled());
    expect(screen.getByTestId("dataset-load-config")).toHaveTextContent(
      '"dataset_version_id":null',
    );
    fireEvent.change(screen.getByTestId("node-config-version"), { target: { value: "11" } });
    await waitFor(() => {
      expect(screen.getByTestId("node-config-dataset")).toHaveValue("3");
      expect(screen.getByTestId("node-config-version")).toHaveValue("11");
    });
    expect(screen.getByTestId("dataset-load-config")).toHaveTextContent('"dataset_id":3');
    expect(screen.getByTestId("dataset-load-config")).toHaveTextContent(
      '"dataset_version_id":11',
    );
    fireEvent.change(screen.getByTestId("node-config-dataset"), { target: { value: "4" } });
    await waitFor(() => {
      expect(screen.getByTestId("dataset-load-config")).toHaveTextContent('"dataset_id":4');
      expect(screen.getByTestId("dataset-load-config")).toHaveTextContent(
        '"dataset_version_id":null',
      );
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
      /관측값/,
    );
    expect(screen.getByTestId("node-config-forecast-horizons-help")).toHaveTextContent(
      /시간 단위가 아닙니다/,
    );
    expect(screen.getByTestId("node-config-forecast-help")).toHaveTextContent(/Lag|이전값|Rolling|이동창/);

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
    expect(screen.getByTestId("node-config-split-time-help")).toHaveTextContent(
      /시간 컬럼 기준으로 정렬/,
    );
    expect(screen.getByTestId("node-config-split-seed-hint")).toHaveTextContent(
      /데이터를 섞지 않습니다/,
    );
    fireEvent.change(screen.getByTestId("node-config-time-column"), {
      target: { value: "event_time" },
    });
    expect(screen.getByTestId("split-config")).toHaveTextContent('"time_column":"event_time"');
    expect(screen.getByTestId("node-config-seed")).toBeInTheDocument();
    expect(screen.getByTestId("node-config-split-hint")).toHaveTextContent("0.7");
    expect(screen.getByTestId("node-config-split-strategy")).toHaveTextContent(
      "시간 순서 (Time ordered)",
    );
    fireEvent.change(screen.getByTestId("node-config-train-ratio"), {
      target: { value: "0.7" },
    });
    fireEvent.change(screen.getByTestId("node-config-val-ratio"), {
      target: { value: "0.15" },
    });
    fireEvent.change(screen.getByTestId("node-config-test-ratio"), {
      target: { value: "0.15" },
    });
    expect(screen.getByTestId("split-config")).toHaveTextContent('"train_ratio":0.7');
    expect(screen.getByTestId("split-config")).toHaveTextContent('"val_ratio":0.15');
    expect(screen.getByTestId("split-config")).toHaveTextContent('"test_ratio":0.15');
  });

  it("keeps Evaluation metric/minimum/fail_on_gate values while showing Korean gate guidance", () => {
    function Harness() {
      const [config, setConfig] = useState<Record<string, unknown>>({
        metric: "accuracy",
        minimum: 0.8,
        fail_on_gate: true,
      });
      return (
        <div>
          <pre data-testid="evaluation-config">{JSON.stringify(config)}</pre>
          <NodeConfigForm
            projectId="7"
            nodeType="evaluation"
            config={config}
            onChange={setConfig}
          />
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("node-config-evaluation-hint")).toHaveTextContent(">=");
    expect(screen.getByTestId("node-config-evaluation-rmse-hint")).toHaveTextContent(/RMSE|MAE/);
    expect(screen.getByTestId("node-config-metric")).toHaveValue("accuracy");
    expect(screen.getByTestId("node-config-minimum")).toHaveValue(0.8);
    expect(screen.getByTestId("node-config-fail-on-gate")).toBeChecked();
    fireEvent.change(screen.getByTestId("node-config-metric"), {
      target: { value: "f1" },
    });
    fireEvent.change(screen.getByTestId("node-config-minimum"), {
      target: { value: "0.55" },
    });
    fireEvent.click(screen.getByTestId("node-config-fail-on-gate"));
    expect(screen.getByTestId("evaluation-config")).toHaveTextContent('"metric":"f1"');
    expect(screen.getByTestId("evaluation-config")).toHaveTextContent('"minimum":0.55');
    expect(screen.getByTestId("evaluation-config")).toHaveTextContent('"fail_on_gate":false');
  });
});

describe("PipelineBuilder", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    flowSetCenterMock.mockReset();
    flowGetZoomMock.mockReset();
    flowGetZoomMock.mockReturnValue(1.5);
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
    expect(screen.getByTestId("pipeline-step-type")).toHaveTextContent(
      "데이터셋 불러오기 (Dataset Load)",
    );
    expect(screen.getByTestId("pipeline-step-name")).toHaveValue("Dataset Load");
  });

  it("shows Korean-first builder actions, dirty guidance, and beginner usage order", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    expect(screen.getByTestId("pipeline-validate")).toHaveTextContent("검증");
    expect(screen.getByTestId("pipeline-save")).toHaveTextContent("버전 저장");
    expect(screen.getByTestId("pipeline-publish")).toHaveTextContent("게시 (Publish)");
    expect(screen.getByTestId("pipeline-schedule-entry")).toHaveTextContent("일정 등록");
    expect(screen.getByTestId("pipeline-run")).toHaveTextContent("파이프라인 실행");
    expect(screen.getByTestId("pipeline-builder-guide")).toHaveTextContent("① 데이터셋 선택");
    expect(screen.getByTestId("pipeline-builder-guide-details")).toHaveTextContent(
      "자동 저장되지 않으며",
    );
    expect(screen.getByTestId("pipeline-builder-guide-details")).toHaveTextContent(
      "일정 등록은 게시된 파이프라인에서 가능합니다",
    );
    expect(screen.getByText("데이터셋으로 시작하세요")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    expect(screen.getByTestId("pipeline-dirty-hint")).toHaveTextContent(
      "게시하거나 실행하기 전에 버전을 저장하세요",
    );
    expect(screen.getByTestId("pipeline-publish")).toBeDisabled();
    expect(screen.getByTestId("pipeline-run")).toBeDisabled();
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
    expect(screen.getByTestId("pipeline-library-empty")).toHaveTextContent(
      "일치하는 노드가 없습니다",
    );
    fireEvent.change(screen.getByTestId("pipeline-library-search"), {
      target: { value: "분할" },
    });
    expect(screen.getByTestId("pipeline-library-split")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-library-split")).toHaveTextContent(
      "데이터 분할 (Split)",
    );
    expect(screen.queryByTestId("pipeline-library-notification")).not.toBeInTheDocument();
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
      /설정을 확인하세요/,
    );
    expect(screen.getByTestId("pipeline-inspector-hint")).not.toHaveTextContent(/노드 라이브러리/);
    const flow = await screen.findByTestId("react-flow");
    expect(flow).toHaveAttribute("data-draggable", "false");
    expect(flow).toHaveAttribute("data-connectable", "false");
    expect(flow).toHaveAttribute("data-delete-enabled", "false");
    expect(screen.queryByTestId("pipeline-library-dataset_load")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-add-node")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("canvas-node-dataset_load-1"));
    expect(await screen.findByTestId("pipeline-step-name")).toBeDisabled();
    expect(screen.getByText(/읽기 전용 설정입니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("react-flow-force-remove"));
    fireEvent.click(screen.getByTestId("react-flow-force-connect"));
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
  });

  it("shows a non-action empty state for read-only users", async () => {
    canWriteRef.value = false;
    stubBuilderApi();
    renderBuilder();
    expect(await screen.findByText(/이 파이프라인 버전에는 단계가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /데이터셋 불러오기 추가/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-builder-layout")).toHaveClass("is-readonly");
    expect(screen.getByTestId("pipeline-inspector-hint")).toHaveTextContent(
      /설정을 확인하세요/,
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
    expect(screen.getByTestId("pipeline-dirty-badge")).toHaveTextContent("저장되지 않은 변경사항");
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
  it("keeps undo/redo disabled until a graph edit exists", async () => {
    renderBuilder();
    expect(await screen.findByTestId("pipeline-undo")).toBeDisabled();
    expect(screen.getByTestId("pipeline-redo")).toBeDisabled();
  });

  it("undoes and redoes node add, delete-with-edges, condition connect, config, and drag", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") {
        return {
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
                    label: "Dataset Load",
                    node_type: "dataset_load",
                    config: defaultConfigFor("dataset_load"),
                  },
                },
              ],
              edges: [],
            },
          },
        };
      }
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
    await screen.findByTestId("canvas-node-dataset_load-1");
    expect(screen.getByTestId("pipeline-undo")).toBeDisabled();

    fireEvent.click(screen.getByTestId("pipeline-library-condition"));
    expect(await screen.findByTestId("canvas-node-condition-1")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-undo")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-condition-1")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("pipeline-redo")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("pipeline-redo"));
    expect(await screen.findByTestId("canvas-node-condition-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("react-flow-force-condition-connect"));
    await waitFor(() => {
      expect(screen.getByTestId("canvas-edge-e-0")).toHaveAttribute("data-source-handle", "true");
    });
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-edge-e-0")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("pipeline-redo"));
    expect(await screen.findByTestId("canvas-edge-e-0")).toHaveAttribute(
      "data-source-handle",
      "true",
    );

    fireEvent.click(screen.getByTestId("canvas-node-condition-1"));
    const nameInput = await screen.findByTestId("pipeline-step-name");
    fireEvent.change(nameInput, { target: { value: "Gate" } });
    expect(nameInput).toHaveValue("Gate");
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-step-name")).toHaveValue("Condition");
    });
    fireEvent.click(screen.getByTestId("pipeline-redo"));
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-step-name")).toHaveValue("Gate");
    });

    fireEvent.click(screen.getByTestId("react-flow-force-drag"));
    await waitFor(() => {
      expect(screen.getByTestId("canvas-node-dataset_load-1")).toHaveAttribute("data-x", "120");
    });
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.getByTestId("canvas-node-dataset_load-1")).toHaveAttribute("data-x", "0");
    });
    expect(screen.getByTestId("pipeline-undo")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("react-flow-force-remove"));
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-dataset_load-1")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-edge-e-0")).toBeInTheDocument();
  });

  it("handles keyboard shortcuts, input focus, redo discard, readonly, and stale validate", async () => {
    const validateGate: {
      resolve?: (value: { valid: boolean; errors: string[] }) => void;
    } = {};
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") return { ...pipeline };
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/3/versions") return versions;
      if (path === "/projects/7/pipelines/9/versions" && method === "POST") {
        return { id: 2, version: 2, graph: JSON.parse(String(init?.body || "{}")).graph };
      }
      if (path === "/projects/7/pipelines/9/validate" && method === "POST") {
        return await new Promise<{ valid: boolean; errors: string[] }>((resolve) => {
          validateGate.resolve = resolve;
        });
      }
      throw new Error(`Unhandled ${path} ${method}`);
    });
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-dataset_load-1")).not.toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-dataset_load-1")).not.toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("canvas-node-dataset_load-1"));
    const nameInput = await screen.findByTestId("pipeline-step-name");
    fireEvent.keyDown(nameInput, { key: "z", ctrlKey: true });
    expect(screen.getByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-dataset_load-1")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("pipeline-redo")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("pipeline-library-split"));
    expect(await screen.findByTestId("canvas-node-split-1")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-redo")).toBeDisabled();

    fireEvent.click(screen.getByTestId("pipeline-validate"));
    fireEvent.click(screen.getByTestId("pipeline-library-training"));
    expect(await screen.findByTestId("canvas-node-training-1")).toBeInTheDocument();
    validateGate.resolve?.({ valid: false, errors: ["Node 'split-1' is missing ratios"] });
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-validation-errors")).not.toBeInTheDocument();
    });

    canWriteRef.value = false;
    cleanup();
    stubBuilderApi();
    renderBuilder();
    expect(await screen.findByTestId("pipeline-undo")).toBeDisabled();
    expect(screen.getByTestId("pipeline-redo")).toBeDisabled();
  });

  it("keeps edits made during an in-flight save undoable after success", async () => {
    const saveGate: { resolve?: (value: unknown) => void } = {};
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") return { ...pipeline };
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/3/versions") return versions;
      if (path === "/projects/7/pipelines/9/versions" && method === "POST") {
        return await new Promise((resolve) => {
          saveGate.resolve = resolve;
        });
      }
      throw new Error(`Unhandled ${path} ${method}`);
    });
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-save"));
    fireEvent.click(screen.getByTestId("pipeline-library-split"));
    expect(await screen.findByTestId("canvas-node-split-1")).toBeInTheDocument();
    saveGate.resolve?.({
      id: 2,
      version: 2,
      graph: {
        nodes: [
          {
            id: "dataset_load-1",
            position: { x: 80, y: 80 },
            data: {
              label: "Dataset Load",
              node_type: "dataset_load",
              config: defaultConfigFor("dataset_load"),
            },
          },
        ],
        edges: [],
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    });
    expect(screen.getByTestId("canvas-node-split-1")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-undo")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-split-1")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
  });

  it("restores Advanced JSON config on undo and keeps invalid JSON out of history", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-dataset_load");
    fireEvent.click(screen.getByTestId("pipeline-library-dataset_load"));
    fireEvent.click(await screen.findByTestId("canvas-node-dataset_load-1"));
    const details = screen.getByText("고급 JSON").closest("details");
    expect(details).toBeTruthy();
    if (details) details.open = true;
    const json = await screen.findByTestId("pipeline-advanced-json");
    fireEvent.change(json, {
      target: { value: '{"dataset_id":3,"dataset_version_id":11}' },
    });
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-undo")).not.toBeDisabled();
    });
    fireEvent.change(json, { target: { value: "{not-json" } });
    expect(screen.getByTestId("pipeline-json-error")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      const value = (screen.getByTestId("pipeline-advanced-json") as HTMLTextAreaElement).value;
      // Undo restores the last committed config (default {}), not the invalid draft text.
      expect(value.replace(/\s/g, "")).toBe("{}");
      expect(value).not.toContain("not-json");
    });
    expect(screen.queryByTestId("pipeline-json-error")).not.toBeInTheDocument();
  });

  it("centers the viewport from MiniMap click without dirty or history changes", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipelines/9") {
        return {
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
                    label: "Dataset Load",
                    node_type: "dataset_load",
                    config: defaultConfigFor("dataset_load"),
                  },
                },
              ],
              edges: [],
            },
          },
        };
      }
      if (path === "/projects/7/pipelines/9/runs") return [];
      if (path === "/projects/7/datasets") return datasets;
      throw new Error(`Unhandled ${path}`);
    });
    renderBuilder();
    const minimap = await screen.findByTestId("pipeline-minimap");
    expect(minimap).toHaveAttribute("data-pannable", "true");
    expect(minimap).toHaveAttribute("aria-label", expect.stringContaining("미니맵"));
    expect(screen.getByTestId("pipeline-undo")).toBeDisabled();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-minimap-click"));
    expect(flowSetCenterMock).toHaveBeenCalledWith(320, 180, {
      zoom: 1.5,
      duration: 200,
    });
    fireEvent.click(screen.getByTestId("pipeline-minimap-node-click"));
    expect(flowSetCenterMock).toHaveBeenCalledWith(200, 80, {
      zoom: 1.5,
      duration: 200,
    });
    expect(screen.getByTestId("pipeline-undo")).toBeDisabled();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
  });

  it("undoes Copilot Apply as a single history entry", async () => {
    stubBuilderApiWithCopilot();
    renderBuilder();
    await screen.findByTestId("pipeline-copilot-open");
    fireEvent.click(screen.getByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "build forecast" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-apply")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-copilot-apply"));
    fireEvent.click(await screen.findByTestId("pipeline-copilot-confirm-apply"));
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-undo"));
    await waitFor(() => {
      expect(screen.queryByTestId("canvas-node-dataset_load-1")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("pipeline-redo"));
    expect(await screen.findByTestId("canvas-node-dataset_load-1")).toBeInTheDocument();
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

describe("Pipeline deletion", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
  });

  it("deletes a pipeline with no run history after confirmation", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines" && method === "GET") {
        return [{ ...pipeline, id: 31, name: "Disposable pipe" }];
      }
      if (path === "/projects/7/pipelines/31" && method === "DELETE") {
        return { detail: "Pipeline deleted.", hint: null };
      }
      throw new Error(`Unhandled api call ${method} ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/pipelines"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines" element={<Pipelines />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Disposable pipe")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-delete-31"));

    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete pipeline "Disposable pipe"?'));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("/projects/7/pipelines/31", { method: "DELETE" });
      expect(screen.queryByText("Disposable pipe")).not.toBeInTheDocument();
    });
    expect(screen.getByText('Pipeline "Disposable pipe" deleted.')).toBeInTheDocument();
    confirmMock.mockRestore();
  });

  it("keeps the pipeline and explains the run-history delete block", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines" && method === "GET") {
        return [{ ...pipeline, id: 32, name: "Audited pipe" }];
      }
      if (path === "/projects/7/pipelines/32" && method === "DELETE") {
        throw new ApiRequestError(409, "A pipeline with run history cannot be deleted.");
      }
      throw new Error(`Unhandled api call ${method} ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/pipelines"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines" element={<Pipelines />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Audited pipe")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pipeline-delete-32"));

    expect(
      await screen.findByText(
        "This pipeline has run history and cannot be deleted. Run history is retained for auditability.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Audited pipe")).toBeInTheDocument();
    confirmMock.mockRestore();
  });

  it("does not expose delete controls to read-only users", async () => {
    canWriteRef.value = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/pipelines") {
        return [{ ...pipeline, id: 33, name: "Read-only pipe" }];
      }
      throw new Error(`Unhandled api call GET ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/pipelines"]}>
        <Routes>
          <Route path="/projects/:projectId/pipelines" element={<Pipelines />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Read-only pipe")).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-delete-33")).not.toBeInTheDocument();
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
    expect(draftSchedule).toHaveAttribute(
      "title",
      "일정을 등록하려면 먼저 파이프라인을 게시하세요.",
    );
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
      expect.stringContaining("일정 등록 전에 변경사항을 저장하세요"),
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

const forecastCopilotPatch: PipelineCopilotPatchResponse = {
  summary: "Changed the training algorithm to ridge.",
  model: "test-model",
  warnings: [],
  validation: { valid: true, errors: [], order: ["dataset_load-1", "training-1"] },
  patch: {
    operations: [
      {
        op: "update_node",
        node_id: "training-1",
        label: "Sales Forecast Training",
        config_patch: { algorithm: "ridge" },
      },
    ],
  },
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
          label: "Sales Forecast Training",
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
  patch?: PipelineCopilotPatchResponse | (() => PipelineCopilotPatchResponse);
  patchError?: ApiRequestError;
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
    if (path === "/projects/7/pipeline-copilot/patch" && method === "POST") {
      if (options?.patchError) throw options.patchError;
      const patch =
        typeof options?.patch === "function"
          ? options.patch()
          : options?.patch || forecastCopilotPatch;
      return patch;
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
    expect(screen.getByTestId("pipeline-copilot-proposal-note")).toHaveTextContent(
      /적용하기 전까지 편집기 그래프는 변경되지 않습니다/,
    );
    expect(screen.getByTestId("pipeline-copilot-proposal-note")).toHaveTextContent(
      /적용하면 편집기 그래프가 변경되지만/,
    );
    expect(screen.getByTestId("pipeline-copilot-proposal-note")).toHaveTextContent(
      /파이프라인 버전은 자동으로 저장되지 않습니다/,
    );
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent(/적용 가능한 초안/);
    expect(screen.getByTestId("pipeline-copilot-validation-status")).toHaveTextContent(/노드 2개/);
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
      /저장하지 않은 변경사항/,
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
    expect(screen.getByTestId("pipeline-copilot-error-title")).toHaveTextContent(
      /Copilot 설정·네트워크·서비스 상태/,
    );
    expect(screen.queryByTestId("pipeline-copilot-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid^='canvas-node-']")).toHaveLength(0);
  });

  it("shows structure-error guidance for invalid PipelineGraph proposals", async () => {
    stubBuilderApiWithCopilot({
      draftError: new ApiRequestError(
        502,
        "Edge at index 0 requires source and target.",
        "The provider returned an invalid PipelineGraph proposal.",
      ),
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "열수요 데이터로 Ridge 회귀 파이프라인" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-error-title")).toHaveTextContent(
      /파이프라인 구조를 올바르게 생성하지 못했습니다/,
    );
    expect(screen.getByTestId("pipeline-copilot-error")).toHaveTextContent(
      /requires source and target/i,
    );
    expect(screen.getByTestId("pipeline-copilot-error")).toHaveTextContent(
      /invalid PipelineGraph proposal/i,
    );
    expect(screen.queryByTestId("pipeline-copilot-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
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
    expect(screen.getByTestId("pipeline-copilot-generate")).toHaveTextContent(/^제안 생성$/);
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

describe("Pipeline Copilot patch (Phase 7-C)", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    canWriteRef.value = true;
    stubBuilderApiWithCopilot();
  });

  it("keeps Draft new flow and shows Modify for writers only", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-copilot-entry");
    expect(screen.getByTestId("pipeline-copilot-open")).toHaveTextContent(/새 파이프라인 초안 만들기/);
    expect(screen.getByTestId("pipeline-copilot-patch-open")).toHaveTextContent(
      /현재 파이프라인 수정 제안/,
    );
    cleanup();

    canWriteRef.value = false;
    renderBuilder();
    await screen.findByTestId("pipeline-builder-layout");
    expect(screen.queryByTestId("pipeline-copilot-patch-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-copilot-open")).not.toBeInTheDocument();
  });

  it("sends prompt + exact in-memory current_graph including unsaved edits", async () => {
    renderBuilder();
    await screen.findByTestId("pipeline-library-training");
    fireEvent.click(screen.getByTestId("pipeline-library-training"));
    await screen.findByTestId("canvas-node-training-1");
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Change training algorithm to ridge" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await screen.findByTestId("pipeline-copilot-preview");

    const patchCall = apiMock.mock.calls.find(
      ([path, init]) =>
        path === "/projects/7/pipeline-copilot/patch" &&
        (init?.method || "GET").toUpperCase() === "POST",
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String(patchCall?.[1]?.body || "{}"));
    expect(Object.keys(body).sort()).toEqual(["current_graph", "prompt"]);
    expect(body.prompt).toBe("Change training algorithm to ridge");
    expect(body.pipeline_id).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.current_graph.nodes.some((n: { id: string }) => n.id === "training-1")).toBe(
      true,
    );
    // Generate must not clear dirty or mutate live graph before Apply.
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    expect(
      screen.getByTestId("pipeline-canvas").querySelectorAll("[data-testid='canvas-node-training-1']"),
    ).toHaveLength(1);
  });

  it("renders proposed operations and blocks Apply for invalid or empty patches", async () => {
    stubBuilderApiWithCopilot({
      patch: {
        ...forecastCopilotPatch,
        validation: { valid: false, errors: ["target_column is required"], order: [] },
        warnings: ["Proposed changes failed strict validation"],
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Broken change" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-operations")).toHaveTextContent(
      /노드 수정 training-1/,
    );
    expect(screen.getByTestId("pipeline-copilot-apply-blocked")).toHaveTextContent(
      /적용할 수 없습니다/,
    );
    expect(screen.getByTestId("pipeline-copilot-apply")).toBeDisabled();

    cleanup();
    stubBuilderApiWithCopilot({
      patch: {
        ...forecastCopilotPatch,
        summary: "Nothing changed",
        patch: { operations: [] },
        warnings: ["Copilot proposed no graph changes."],
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Do nothing" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-noop")).toHaveTextContent(
      /변경할 내용이 없습니다/,
    );
    expect(screen.getByTestId("pipeline-copilot-apply")).toBeDisabled();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();
  });

  it("requires confirmation and Apply uses response.graph without Save/Publish/Run", async () => {
    const seeded = {
      ...pipeline,
      version: {
        id: 1,
        version: 1,
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
                  algorithm: "random_forest",
                  feature_columns: ["sales_lag_1"],
                  hyperparameters: {},
                  split_strategy: "time",
                  time_column: "event_time",
                  forecast_strategy: "direct_multioutput",
                  forecast_horizons: [1, 2, 3],
                },
              },
            },
            {
              id: "notification-1",
              position: { x: 600, y: 40 },
              data: {
                label: "Notify",
                node_type: "notification",
                config: {
                  alert_type: "pipeline",
                  severity: "info",
                  title: "done",
                  message: "ok",
                },
              },
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "dataset_load-1",
              target: "training-1",
              data: { branch: "always" },
            },
            {
              id: "edge-2",
              source: "training-1",
              target: "notification-1",
              data: { branch: "always" },
            },
          ],
        },
      },
    };
    stubBuilderApi();
    const base = apiMock.getMockImplementation();
    let versionPosts = 0;
    let publishPosts = 0;
    let runPosts = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipelines/9") return seeded;
      if (path === "/projects/7/pipeline-copilot/patch" && method === "POST") {
        return {
          ...forecastCopilotPatch,
          patch: {
            operations: [
              {
                op: "update_node",
                node_id: "training-1",
                label: "Sales Forecast Training",
                config_patch: { algorithm: "ridge" },
              },
              { op: "remove_node", node_id: "notification-1" },
              {
                op: "add_node",
                node: {
                  id: "evaluation-1",
                  position: { x: 600, y: 40 },
                  data: {
                    label: "Evaluate",
                    node_type: "evaluation",
                    config: { metric: "rmse", minimum: 0 },
                  },
                },
              },
            ],
          },
          graph: {
            nodes: [
              forecastCopilotPatch.graph.nodes[0],
              forecastCopilotPatch.graph.nodes[1],
              {
                id: "evaluation-1",
                position: { x: 600, y: 40 },
                data: {
                  label: "Evaluate",
                  node_type: "evaluation",
                  config: { metric: "rmse", minimum: 0 },
                },
              },
            ],
            edges: [forecastCopilotPatch.graph.edges[0]],
          },
        } satisfies PipelineCopilotPatchResponse;
      }
      if (path === "/projects/7/pipelines/9/versions" && method === "POST") {
        versionPosts += 1;
        return { id: 2, version: 2, graph: JSON.parse(String(init?.body || "{}")).graph };
      }
      if (path === "/projects/7/pipelines/9/publish" && method === "POST") {
        publishPosts += 1;
        return { ...seeded, status: "published" };
      }
      if (path === "/projects/7/pipelines/9/run" && method === "POST") {
        runPosts += 1;
        throw new Error("run should not be called");
      }
      if (path === "/projects/7/pipelines/9/validate" && method === "POST") {
        return { valid: true, errors: [], order: [] };
      }
      if (path === "/projects/7/training/algorithms") {
        return { algorithms: [{ id: "ridge", display_name: "Ridge", problem_types: ["regression"] }] };
      }
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/3/versions") return versions;
      if (path === "/projects/7/pipelines/9/runs") return [];
      return base?.(path, init);
    });

    renderBuilder();
    await screen.findByTestId("canvas-node-training-1");
    expect(screen.getByTestId("canvas-node-notification-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Change algorithm to ridge and remove notification" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await screen.findByTestId("pipeline-copilot-preview");
    expect(screen.getByTestId("pipeline-copilot-operations")).toHaveTextContent(
      /노드 삭제 notification-1/,
    );
    // Live canvas unchanged before Apply.
    expect(screen.getByTestId("canvas-node-notification-1")).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pipeline-copilot-apply"));
    expect(await screen.findByTestId("pipeline-copilot-confirm")).toHaveTextContent(
      /이 수정 제안을 적용할까요/,
    );
    fireEvent.click(screen.getByTestId("pipeline-copilot-confirm-back"));
    expect(screen.queryByTestId("pipeline-copilot-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-notification-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pipeline-copilot-apply"));
    fireEvent.click(await screen.findByTestId("pipeline-copilot-confirm-apply"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-copilot-drawer")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-publish")).toBeDisabled();
    expect(screen.getByTestId("pipeline-run")).toBeDisabled();
    expect(
      within(screen.getByTestId("pipeline-canvas")).queryByTestId("canvas-node-notification-1"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("pipeline-canvas")).getByTestId("canvas-node-evaluation-1"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("pipeline-canvas")).getByTestId("canvas-node-training-1"),
    ).toHaveTextContent(/Sales Forecast Training/i);
    expect(versionPosts).toBe(0);
    expect(publishPosts).toBe(0);
    expect(runPosts).toBe(0);

    fireEvent.click(screen.getByTestId("pipeline-save"));
    await waitFor(() => expect(versionPosts).toBe(1));
    await waitFor(() => expect(screen.queryByTestId("pipeline-dirty-badge")).not.toBeInTheDocument());
  });

  it("ignores stale patch responses and does not cross-contaminate draft mode", async () => {
    type Deferred = {
      promise: Promise<PipelineCopilotPatchResponse>;
      resolve: (value: PipelineCopilotPatchResponse) => void;
    };
    const deferreds: Deferred[] = [];
    stubBuilderApi();
    const base = apiMock.getMockImplementation();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/pipeline-copilot/patch" && method === "POST") {
        let resolve!: (value: PipelineCopilotPatchResponse) => void;
        const promise = new Promise<PipelineCopilotPatchResponse>((res) => {
          resolve = res;
        });
        deferreds.push({ promise, resolve });
        return promise;
      }
      if (path === "/projects/7/pipeline-copilot/draft" && method === "POST") {
        return { ...forecastCopilotDraft, summary: "Draft must not leak into patch" };
      }
      return base?.(path, init);
    });

    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "First patch" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await waitFor(() => expect(deferreds.length).toBe(1));

    fireEvent.click(screen.getByTestId("drawer-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("pipeline-copilot-drawer")).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Second patch" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    await waitFor(() => expect(deferreds.length).toBe(2));

    deferreds[1].resolve({
      ...forecastCopilotPatch,
      summary: "Second patch result",
    });
    expect(await screen.findByTestId("pipeline-copilot-summary")).toHaveTextContent(
      "Second patch result",
    );

    deferreds[0].resolve({
      ...forecastCopilotPatch,
      summary: "Stale first patch",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId("pipeline-copilot-summary")).toHaveTextContent("Second patch result");
    expect(screen.queryByText(/Stale first patch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Draft must not leak/i)).not.toBeInTheDocument();
  });

  it("leaves graph unchanged on patch 503/502 errors", async () => {
    stubBuilderApiWithCopilot({
      patchError: new ApiRequestError(503, "Pipeline Copilot is not configured."),
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("pipeline-library-training"));
    await screen.findByTestId("canvas-node-training-1");
    fireEvent.click(screen.getByTestId("pipeline-copilot-patch-open"));
    fireEvent.change(await screen.findByTestId("pipeline-copilot-prompt"), {
      target: { value: "Anything" },
    });
    fireEvent.click(screen.getByTestId("pipeline-copilot-generate"));
    expect(await screen.findByTestId("pipeline-copilot-error")).toHaveTextContent(/not configured/i);
    expect(
      within(screen.getByTestId("pipeline-canvas")).getByTestId("canvas-node-training-1"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-dirty-badge")).toBeInTheDocument();
  });
});
