import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PreparationBuilder from "./PreparationBuilder";

const apiMock = vi.fn();
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

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    onNodeClick,
    onNodesChange,
    onConnect,
    nodesDraggable,
    nodesConnectable,
    deleteKeyCode,
    children,
  }: {
    nodes: Array<{ id: string; data: { label: string; node_type: string } }>;
    onNodeClick?: (_: unknown, node: { id: string; data: { label: string; node_type: string } }) => void;
    onNodesChange?: (changes: Array<{ type: string; id?: string }>) => void;
    onConnect?: (connection: {
      source: string;
      target: string;
      targetHandle?: string | null;
    }) => void;
    nodesDraggable?: boolean;
    nodesConnectable?: boolean;
    deleteKeyCode?: string[] | null;
    children?: ReactNode;
  }) => {
    useEffect(() => undefined, []);
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
                onConnect?.({
                  source: nodes[0].id,
                  target: nodes.find((row) => row.data.node_type === "join")?.id || nodes[0].id,
                  targetHandle: "left",
                })
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

const datasets = [
  {
    id: 2,
    project_id: 7,
    name: "iris",
    description: "",
    latest_version: 1,
    row_count: 150,
    column_count: 5,
    columns: ["sepal_length", "target"],
    stats: {},
    created_at: "2026-09-01T00:00:00Z",
  },
  {
    id: 3,
    project_id: 7,
    name: "orders",
    description: "",
    latest_version: 1,
    row_count: 20,
    column_count: 3,
    columns: ["order_id", "amount", "region"],
    stats: {},
    created_at: "2026-09-02T00:00:00Z",
  },
];

const versionsByDataset: Record<number, Array<Record<string, unknown>>> = {
  2: [
    {
      id: 11,
      dataset_id: 2,
      project_id: 7,
      version: 1,
      original_filename: "iris.csv",
      format: "csv",
      row_count: 150,
      column_count: 5,
      columns: ["sepal_length", "target"],
      dtypes: {},
      stats: {},
      source_type: "upload",
      created_at: "2026-09-01T00:00:00Z",
    },
  ],
  3: [
    {
      id: 21,
      dataset_id: 3,
      project_id: 7,
      version: 1,
      original_filename: "orders.csv",
      format: "csv",
      row_count: 20,
      column_count: 3,
      columns: ["order_id", "amount", "region"],
      dtypes: {},
      stats: {},
      source_type: "upload",
      created_at: "2026-09-02T00:00:00Z",
    },
  ],
};

const defaultPreview = {
  node_id: "source-1",
  columns: ["sepal_length", "target"],
  dtypes: { sepal_length: "float64", target: "int64" },
  rows: [{ sepal_length: 5.1, target: 0 }],
  row_count: 1,
  sampled: true,
  warnings: [
    "Preview uses stored DatasetVersion sample rows and may not represent the full dataset.",
  ],
};

const preparation = {
  id: 9,
  project_id: 7,
  name: "Demo prep",
  description: "Join demo",
  output_dataset_id: null as number | null,
  latest_version: 1,
  created_at: "2026-09-10T10:00:00Z",
  version: {
    id: 1,
    preparation_id: 9,
    project_id: 7,
    version: 1,
    schema_version: 1,
    graph: {
      schema_version: 1 as const,
      nodes: [
        {
          id: "source-1",
          type: "source" as const,
          config: { dataset_id: 2, version_strategy: "latest" },
          position: { x: 40, y: 60 },
        },
      ],
      edges: [] as Array<{
        id: string;
        source: string;
        target: string;
        target_port?: string | null;
      }>,
    },
    created_at: "2026-09-10T10:00:00Z",
  },
};

let preparationState = { ...preparation, version: { ...preparation.version, graph: { ...preparation.version.graph, nodes: [...preparation.version.graph.nodes], edges: [...preparation.version.graph.edges] } } };
let runsState: Array<Record<string, unknown>> = [];
let datasetsState = [...datasets];

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/preparations/9"]}>
      <Routes>
        <Route
          path="/projects/:projectId/preparations/:preparationId"
          element={<PreparationBuilder />}
        />
        <Route path="/projects/:projectId/preparations" element={<div>List</div>} />
        <Route path="/projects/:projectId/datasets/:datasetId" element={<div>Dataset</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function stubPreparationApi(overrides?: {
  validate?: { valid: boolean; errors: string[]; warnings: string[] };
  preview?: Record<string, unknown>;
  previewDeferred?: Promise<Record<string, unknown>>;
  onSave?: (body: unknown) => void;
  preparation?: typeof preparationState;
  runs?: Array<Record<string, unknown>>;
}) {
  preparationState = overrides?.preparation
    ? structuredClone(overrides.preparation)
    : structuredClone(preparation);
  runsState = overrides?.runs ? structuredClone(overrides.runs) : [];
  datasetsState = structuredClone(datasets);

  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    if (path === "/projects/7/dataset-preparations/9" && method === "GET") {
      return preparationState;
    }
    if (path === "/projects/7/dataset-preparations/9" && method === "PATCH") {
      const body = JSON.parse(String(init?.body || "{}"));
      preparationState = {
        ...preparationState,
        ...body,
        version: preparationState.version,
      };
      return preparationState;
    }
    if (path === "/projects/7/datasets" && method === "GET") {
      return datasetsState;
    }
    if (path === "/projects/7/dataset-preparations/9/versions" && method === "GET") {
      return [preparationState.version];
    }
    if (path === "/projects/7/dataset-preparations/9/runs" && method === "GET") {
      return runsState;
    }
    const versionMatch = /^\/projects\/7\/datasets\/(\d+)\/versions$/.exec(path);
    if (versionMatch && method === "GET") {
      return versionsByDataset[Number(versionMatch[1])] || [];
    }
    if (path === "/projects/7/dataset-preparations/9/validate" && method === "POST") {
      return overrides?.validate || { valid: true, errors: [], warnings: [] };
    }
    if (path === "/projects/7/dataset-preparations/9/preview" && method === "POST") {
      const payload = overrides?.preview || defaultPreview;
      const deferred = overrides?.previewDeferred;
      if (!deferred) return payload;
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        deferred
          .then((value) => {
            if (init?.signal?.aborted) {
              onAbort();
              return;
            }
            resolve(value);
          })
          .catch(reject)
          .finally(() => {
            init?.signal?.removeEventListener("abort", onAbort);
          });
      });
    }
    if (path === "/projects/7/dataset-preparations/9/versions" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      overrides?.onSave?.(body);
      const version = {
        id: 2,
        preparation_id: 9,
        project_id: 7,
        version: 2,
        schema_version: 1,
        graph: body.graph,
        created_at: "2026-09-11T00:00:00Z",
      };
      preparationState = {
        ...preparationState,
        latest_version: 2,
        version,
      };
      return version;
    }
    if (path === "/projects/7/dataset-preparations/9/output-dataset" && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      const output = {
        id: 99,
        project_id: 7,
        name: body.name,
        description: body.description || "",
        latest_version: 0,
        row_count: 0,
        column_count: 0,
        columns: [] as string[],
        stats: {},
        created_at: "2026-09-11T00:00:00Z",
      };
      datasetsState = [...datasetsState, output];
      preparationState = {
        ...preparationState,
        output_dataset_id: output.id,
      };
      return { preparation: preparationState, output_dataset: output };
    }
    if (path === "/projects/7/dataset-preparations/9/runs" && method === "POST") {
      const run = {
        id: 50,
        project_id: 7,
        preparation_id: 9,
        preparation_version_id: preparationState.version.id,
        status: "created",
        output_dataset_id: preparationState.output_dataset_id,
        output_dataset_version_id: null,
        logs: "",
        error_message: null,
        created_at: "2026-09-11T01:00:00Z",
        started_at: null,
        finished_at: null,
      };
      runsState = [run, ...runsState];
      return run;
    }
    const executeMatch = /^\/projects\/7\/dataset-preparation-runs\/(\d+)\/execute$/.exec(path);
    if (executeMatch && method === "POST") {
      const runId = Number(executeMatch[1]);
      runsState = runsState.map((run) =>
        run.id === runId ? { ...run, status: "queued" } : run,
      );
      return runsState.find((run) => run.id === runId);
    }
    const runDetailMatch = /^\/projects\/7\/dataset-preparation-runs\/(\d+)$/.exec(path);
    if (runDetailMatch && method === "GET") {
      const runId = Number(runDetailMatch[1]);
      const run = runsState.find((row) => row.id === runId);
      if (!run) throw new Error("Run not found");
      return {
        ...run,
        inputs: run.inputs || [
          {
            id: 1,
            run_id: runId,
            project_id: 7,
            node_id: "source-1",
            dataset_id: 2,
            dataset_version_id: 11,
            version_strategy: "latest",
            created_at: "2026-09-11T01:00:00Z",
          },
        ],
      };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
}

describe("PreparationBuilder", () => {
  beforeEach(() => {
    canWriteRef.value = true;
    apiMock.mockReset();
    stubPreparationApi();
  });

  it("loads saved node positions onto the canvas", async () => {
    renderBuilder();
    expect(await screen.findByTestId("preparation-builder")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-node-source-1")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Demo prep" }).length).toBeGreaterThan(0);
  });

  it("adds nodes from the library", async () => {
    renderBuilder();
    await screen.findByTestId("preparation-builder");
    expect(screen.getByTestId("preparation-library-group-transform")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-library-join"));
    expect(await screen.findByTestId("canvas-node-join-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-library-union"));
    expect(await screen.findByTestId("canvas-node-union-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-library-select"));
    expect(await screen.findByTestId("canvas-node-select-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-library-filter"));
    expect(await screen.findByTestId("canvas-node-filter-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-library-output"));
    expect(await screen.findByTestId("canvas-node-output-1")).toBeInTheDocument();
  });

  it("configures source latest/fixed and join/union settings", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("canvas-node-source-1"));
    expect(await screen.findByTestId("preparation-source-inspector")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("preparation-source-strategy"), {
      target: { value: "fixed" },
    });
    expect(await screen.findByTestId("preparation-source-version")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("preparation-source-version"), {
      target: { value: "11" },
    });
    fireEvent.change(screen.getByTestId("preparation-source-strategy"), {
      target: { value: "latest" },
    });
    expect(screen.queryByTestId("preparation-source-version")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("preparation-library-join"));
    fireEvent.click(await screen.findByTestId("canvas-node-join-1"));
    fireEvent.change(screen.getByTestId("preparation-join-how"), { target: { value: "full" } });
    fireEvent.change(screen.getByTestId("preparation-join-left-on"), {
      target: { value: "id, a" },
    });
    fireEvent.change(screen.getByTestId("preparation-join-right-on"), {
      target: { value: "uid" },
    });

    fireEvent.click(screen.getByTestId("preparation-library-union"));
    fireEvent.click(await screen.findByTestId("canvas-node-union-1"));
    fireEvent.change(screen.getByTestId("preparation-union-mode"), {
      target: { value: "align_by_name" },
    });
    expect(screen.getByTestId("preparation-union-mode")).toHaveValue("align_by_name");
  });

  it("saves a version payload with schema_version, positions, and target_port", async () => {
    let saved: { graph?: Record<string, unknown> } | null = null;
    stubPreparationApi({
      onSave: (body) => {
        saved = body as { graph?: Record<string, unknown> };
      },
    });
    renderBuilder();
    await screen.findByTestId("canvas-node-source-1");
    fireEvent.click(screen.getByTestId("preparation-library-join"));
    fireEvent.click(screen.getByTestId("react-flow-force-connect"));
    fireEvent.click(screen.getByTestId("preparation-save-version"));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved!.graph).toMatchObject({ schema_version: 1 });
    const nodes = saved!.graph!.nodes as Array<{
      id: string;
      position?: { x: number; y: number };
    }>;
    expect(nodes.find((node) => node.id === "source-1")?.position).toEqual({ x: 40, y: 60 });
    const edges = saved!.graph!.edges as Array<{ target_port?: string | null }>;
    expect(edges.some((edge) => edge.target_port === "left")).toBe(true);
    expect(JSON.stringify(saved!.graph)).not.toContain("targetHandle");
  });

  it("shows validation errors and success", async () => {
    stubPreparationApi({
      validate: {
        valid: false,
        errors: ["graph must have exactly one output node"],
        warnings: [],
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("preparation-validate"));
    expect(await screen.findByText("graph must have exactly one output node")).toBeInTheDocument();

    stubPreparationApi({ validate: { valid: true, errors: [], warnings: ["soft note"] } });
    fireEvent.click(screen.getByTestId("preparation-validate"));
    expect(await screen.findByText("Graph is valid")).toBeInTheDocument();
    expect(screen.getByText("soft note")).toBeInTheDocument();
  });

  it("shows preview table and sampled warning, then clears preview on graph edit", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("preparation-preview"));
    const panel = await screen.findByTestId("preparation-preview-panel");
    expect(within(panel).getByTestId("preparation-preview-warning")).toHaveTextContent(
      /may not represent the full dataset/,
    );
    expect(within(panel).getByTestId("preparation-preview-table")).toHaveTextContent("sepal_length");

    fireEvent.click(screen.getByTestId("preparation-library-source"));
    await waitFor(() => {
      expect(screen.queryByTestId("preparation-preview-panel")).not.toBeInTheDocument();
    });
  });

  it("unlocks actions when an in-flight preview is aborted by graph edit", async () => {
    let resolvePreview!: (value: Record<string, unknown>) => void;
    const previewDeferred = new Promise<Record<string, unknown>>((resolve) => {
      resolvePreview = resolve;
    });
    stubPreparationApi({ previewDeferred });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("preparation-preview"));
    await waitFor(() => {
      expect(screen.getByTestId("preparation-preview")).toBeDisabled();
      expect(screen.getByTestId("preparation-validate")).toBeDisabled();
      expect(screen.getByTestId("preparation-save-version")).toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("preparation-library-source"));
    await waitFor(() => {
      expect(screen.getByTestId("preparation-preview")).not.toBeDisabled();
      expect(screen.getByTestId("preparation-validate")).not.toBeDisabled();
      expect(screen.getByTestId("preparation-save-version")).not.toBeDisabled();
    });
    expect(screen.queryByTestId("preparation-preview-panel")).not.toBeInTheDocument();

    resolvePreview({
      ...defaultPreview,
      rows: [{ sepal_length: 9.9, target: 99 }],
      columns: ["stale_column"],
    });
    await waitFor(() => {
      expect(screen.queryByTestId("preparation-preview-panel")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("stale_column")).not.toBeInTheDocument();
  });

  it("clears stale fixed version when switching source dataset", async () => {
    let saved: { graph?: { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } } | null =
      null;
    stubPreparationApi({
      onSave: (body) => {
        saved = body as typeof saved;
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("canvas-node-source-1"));
    fireEvent.change(await screen.findByTestId("preparation-source-strategy"), {
      target: { value: "fixed" },
    });
    const versionSelect = await screen.findByTestId("preparation-source-version");
    fireEvent.change(versionSelect, { target: { value: "11" } });
    expect(versionSelect).toHaveValue("11");
    expect(await screen.findByTestId("preparation-source-known-columns")).toHaveTextContent(
      "sepal_length",
    );

    fireEvent.change(screen.getByTestId("preparation-source-dataset"), {
      target: { value: "3" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("preparation-source-version")).toHaveValue("");
    });
    expect(screen.getByTestId("preparation-source-known-columns")).toHaveTextContent(
      /Select a dataset\/version to inspect columns/,
    );

    fireEvent.click(screen.getByTestId("preparation-save-version"));
    await waitFor(() => expect(saved).not.toBeNull());
    const sourceConfig = saved!.graph!.nodes!.find((node) => node.id === "source-1")?.config;
    expect(sourceConfig).toMatchObject({
      dataset_id: 3,
      version_strategy: "fixed",
      dataset_version_id: null,
    });
    expect(sourceConfig?.dataset_version_id).not.toBe(11);

    fireEvent.change(screen.getByTestId("preparation-source-version"), {
      target: { value: "21" },
    });
    expect(await screen.findByTestId("preparation-source-known-columns")).toHaveTextContent(
      "order_id",
    );
    saved = null;
    fireEvent.click(screen.getByTestId("preparation-save-version"));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved!.graph!.nodes!.find((node) => node.id === "source-1")?.config).toMatchObject({
      dataset_id: 3,
      version_strategy: "fixed",
      dataset_version_id: 21,
    });
  });

  it("shows known columns for latest strategy and join/union helper copy", async () => {
    renderBuilder();
    fireEvent.click(await screen.findByTestId("canvas-node-source-1"));
    expect(await screen.findByTestId("preparation-source-known-columns")).toHaveTextContent(
      "sepal_length",
    );
    expect(screen.getByTestId("preparation-source-known-columns")).toHaveTextContent("target");

    fireEvent.click(screen.getByTestId("preparation-library-join"));
    fireEvent.click(await screen.findByTestId("canvas-node-join-1"));
    expect(screen.getByTestId("preparation-join-hint")).toHaveTextContent(
      "Connect one edge to LEFT and one edge to RIGHT.",
    );

    fireEvent.click(screen.getByTestId("preparation-library-union"));
    fireEvent.click(await screen.findByTestId("canvas-node-union-1"));
    expect(screen.getByTestId("preparation-union-hint")).toHaveTextContent(
      "Requires identical column names and order.",
    );
    fireEvent.change(screen.getByTestId("preparation-union-mode"), {
      target: { value: "align_by_name" },
    });
    expect(screen.getByTestId("preparation-union-hint")).toHaveTextContent(
      "Matches columns by name and fills missing values with null.",
    );
  });

  it("keeps the builder read-only for viewers", async () => {
    canWriteRef.value = false;
    renderBuilder();
    await screen.findByTestId("preparation-builder");
    expect(screen.queryByTestId("preparation-library-source")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preparation-save-version")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preparation-run")).not.toBeInTheDocument();
    expect(screen.getByTestId("react-flow")).toHaveAttribute("data-draggable", "false");
    expect(screen.getByTestId("react-flow")).toHaveAttribute("data-connectable", "false");
    fireEvent.click(screen.getByTestId("canvas-node-source-1"));
    expect(await screen.findByTestId("preparation-source-dataset")).toBeDisabled();
    expect(screen.queryByTestId("preparation-remove-node")).not.toBeInTheDocument();
    expect(await screen.findByTestId("preparation-source-known-columns")).toHaveTextContent(
      "sepal_length",
    );
  });

  it("configures transform inspectors", async () => {
    renderBuilder();
    await screen.findByTestId("preparation-builder");

    fireEvent.click(screen.getByTestId("preparation-library-select"));
    fireEvent.click(await screen.findByTestId("canvas-node-select-1"));
    fireEvent.change(screen.getByTestId("preparation-select-inspector-columns"), {
      target: { value: "a, b" },
    });
    expect(screen.getByTestId("preparation-select-inspector-columns")).toHaveValue("a, b");

    fireEvent.click(screen.getByTestId("preparation-library-rename"));
    fireEvent.click(await screen.findByTestId("canvas-node-rename-1"));
    fireEvent.change(screen.getByTestId("preparation-rename-mapping"), {
      target: { value: "a = alpha\nb = beta" },
    });
    expect(screen.getByTestId("preparation-rename-mapping")).toHaveValue("a = alpha\nb = beta");

    fireEvent.click(screen.getByTestId("preparation-library-filter"));
    fireEvent.click(await screen.findByTestId("canvas-node-filter-1"));
    fireEvent.click(screen.getByTestId("preparation-filter-add"));
    fireEvent.change(screen.getByTestId("preparation-filter-column-0"), {
      target: { value: "region" },
    });
    fireEvent.change(screen.getByTestId("preparation-filter-operator-0"), {
      target: { value: "eq" },
    });
    fireEvent.change(screen.getByTestId("preparation-filter-value-0"), {
      target: { value: "west" },
    });

    fireEvent.click(screen.getByTestId("preparation-library-cast"));
    fireEvent.click(await screen.findByTestId("canvas-node-cast-1"));
    fireEvent.click(screen.getByTestId("preparation-cast-add"));
    fireEvent.change(screen.getByTestId("preparation-cast-column-0"), {
      target: { value: "amount" },
    });
    fireEvent.change(screen.getByTestId("preparation-cast-dtype-0"), {
      target: { value: "float" },
    });

    fireEvent.click(screen.getByTestId("preparation-library-fill_constant"));
    fireEvent.click(await screen.findByTestId("canvas-node-fill_constant-1"));
    fireEvent.click(screen.getByTestId("preparation-fill-add"));
    fireEvent.change(screen.getByTestId("preparation-fill-column-0"), {
      target: { value: "region" },
    });
    fireEvent.change(screen.getByTestId("preparation-fill-kind-0"), {
      target: { value: "string" },
    });
    fireEvent.change(screen.getByTestId("preparation-fill-value-0"), {
      target: { value: "unknown" },
    });

    fireEvent.click(screen.getByTestId("preparation-library-derived_column"));
    fireEvent.click(await screen.findByTestId("canvas-node-derived_column-1"));
    fireEvent.change(screen.getByTestId("preparation-derived-name"), {
      target: { value: "total" },
    });
    fireEvent.change(screen.getByTestId("preparation-derived-operation"), {
      target: { value: "add" },
    });
  });

  it("saves transform configs in the version payload", async () => {
    let saved: { graph?: { nodes?: Array<{ id: string; type?: string; config?: Record<string, unknown> }> } } | null =
      null;
    stubPreparationApi({
      onSave: (body) => {
        saved = body as typeof saved;
      },
    });
    renderBuilder();
    await screen.findByTestId("canvas-node-source-1");
    fireEvent.click(screen.getByTestId("preparation-library-select"));
    fireEvent.click(await screen.findByTestId("canvas-node-select-1"));
    fireEvent.change(screen.getByTestId("preparation-select-inspector-columns"), {
      target: { value: "sepal_length, target" },
    });
    fireEvent.click(screen.getByTestId("preparation-save-version"));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved!.graph!.nodes!.find((node) => node.id === "select-1")).toMatchObject({
      type: "select",
      config: { columns: ["sepal_length", "target"] },
    });
  });

  it("creates and selects an output dataset", async () => {
    renderBuilder();
    await screen.findByTestId("preparation-output-empty");
    expect(screen.getByTestId("preparation-output-empty")).toHaveTextContent(
      "No output dataset configured.",
    );
    fireEvent.change(screen.getByTestId("preparation-output-name"), {
      target: { value: "prepared-iris" },
    });
    fireEvent.click(screen.getByTestId("preparation-output-create-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("preparation-output-select")).toHaveValue("99");
    });
    expect(screen.queryByTestId("preparation-output-empty")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("preparation-output-select"), {
      target: { value: "3" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("preparation-output-select")).toHaveValue("3");
    });
  });

  it("disables run when dirty or missing output, and enables when clean with output", async () => {
    stubPreparationApi({
      preparation: { ...preparation, output_dataset_id: null },
    });
    renderBuilder();
    const runButton = await screen.findByTestId("preparation-run");
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute("title", "Configure an output dataset before running");

    fireEvent.change(screen.getByTestId("preparation-output-name"), {
      target: { value: "out-ds" },
    });
    fireEvent.click(screen.getByTestId("preparation-output-create-submit"));
    await waitFor(() => {
      expect(screen.getByTestId("preparation-run")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("preparation-library-select"));
    await waitFor(() => {
      expect(screen.getByTestId("preparation-run")).toBeDisabled();
      expect(screen.getByTestId("preparation-run")).toHaveAttribute("title", "Save first");
    });

    fireEvent.click(screen.getByTestId("preparation-save-version"));
    await waitFor(() => {
      expect(screen.getByTestId("preparation-run")).not.toBeDisabled();
    });
  });

  it("posts run snapshot then execute and reloads runs", async () => {
    stubPreparationApi({
      preparation: {
        ...preparation,
        output_dataset_id: 3,
        version: preparation.version,
      },
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("preparation-run"));
    await waitFor(() => {
      const createCall = apiMock.mock.calls.find(
        ([path, init]) =>
          path === "/projects/7/dataset-preparations/9/runs" && init?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      expect(JSON.parse(String(createCall![1]?.body))).toEqual({ version: null });
      const executeCall = apiMock.mock.calls.find(
        ([path, init]) =>
          path === "/projects/7/dataset-preparation-runs/50/execute" &&
          init?.method === "POST",
      );
      expect(executeCall).toBeTruthy();
      expect(screen.getByTestId("preparation-run-row-50")).toBeInTheDocument();
    });
  });

  it("polls active runs and shows succeeded open-dataset link", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let pollCount = 0;
    stubPreparationApi({
      preparation: { ...preparation, output_dataset_id: 3 },
      runs: [
        {
          id: 60,
          project_id: 7,
          preparation_id: 9,
          preparation_version_id: 1,
          status: "queued",
          output_dataset_id: 3,
          output_dataset_version_id: null,
          logs: "",
          error_message: null,
          created_at: "2026-09-11T01:00:00Z",
          started_at: null,
          finished_at: null,
        },
      ],
    });
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/dataset-preparations/9/runs" && (!init?.method || init.method === "GET")) {
        pollCount += 1;
        if (pollCount >= 2) {
          return [
            {
              id: 60,
              project_id: 7,
              preparation_id: 9,
              preparation_version_id: 1,
              status: "succeeded",
              output_dataset_id: 3,
              output_dataset_version_id: 21,
              logs: "done",
              error_message: null,
              created_at: "2026-09-11T01:00:00Z",
              started_at: "2026-09-11T01:00:01Z",
              finished_at: "2026-09-11T01:00:05Z",
            },
          ];
        }
      }
      return base(path, init);
    });

    renderBuilder();
    expect(await screen.findByTestId("preparation-run-row-60")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => {
      expect(screen.getByTestId("preparation-run-open-60")).toHaveAttribute(
        "href",
        "/projects/7/datasets/3",
      );
    });
    vi.useRealTimers();
  });

  it("shows failed run logs and created Execute action", async () => {
    stubPreparationApi({
      preparation: { ...preparation, output_dataset_id: 3 },
      runs: [
        {
          id: 70,
          project_id: 7,
          preparation_id: 9,
          preparation_version_id: 1,
          status: "failed",
          output_dataset_id: 3,
          output_dataset_version_id: null,
          logs: "Traceback: boom",
          error_message: "Materialization failed",
          created_at: "2026-09-11T01:00:00Z",
          started_at: "2026-09-11T01:00:01Z",
          finished_at: "2026-09-11T01:00:02Z",
        },
        {
          id: 71,
          project_id: 7,
          preparation_id: 9,
          preparation_version_id: 1,
          status: "created",
          output_dataset_id: 3,
          output_dataset_version_id: null,
          logs: "",
          error_message: null,
          created_at: "2026-09-11T02:00:00Z",
          started_at: null,
          finished_at: null,
        },
      ],
    });
    renderBuilder();
    fireEvent.click(await screen.findByTestId("preparation-run-show-error-70"));
    expect(await screen.findByTestId("preparation-run-error-70")).toHaveTextContent(
      "Materialization failed",
    );
    expect(screen.getByTestId("preparation-run-logs-70")).toHaveTextContent("Traceback: boom");
    expect(screen.getByTestId("preparation-run-execute-71")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-run-execute-71"));
    await waitFor(() => {
      expect(
        apiMock.mock.calls.some(
          ([path, init]) =>
            path === "/projects/7/dataset-preparation-runs/71/execute" &&
            init?.method === "POST",
        ),
      ).toBe(true);
    });
  });
});
