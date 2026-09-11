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
];

const versions = [
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
];

const preparation = {
  id: 9,
  project_id: 7,
  name: "Demo prep",
  description: "Join demo",
  output_dataset_id: null,
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

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/preparations/9"]}>
      <Routes>
        <Route
          path="/projects/:projectId/preparations/:preparationId"
          element={<PreparationBuilder />}
        />
        <Route path="/projects/:projectId/preparations" element={<div>List</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function stubPreparationApi(overrides?: {
  validate?: { valid: boolean; errors: string[]; warnings: string[] };
  preview?: Record<string, unknown>;
  onSave?: (body: unknown) => void;
}) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    if (path === "/projects/7/dataset-preparations/9" && method === "GET") {
      return preparation;
    }
    if (path === "/projects/7/datasets" && method === "GET") {
      return datasets;
    }
    if (path === "/projects/7/datasets/2/versions" && method === "GET") {
      return versions;
    }
    if (path === "/projects/7/dataset-preparations/9/validate" && method === "POST") {
      return overrides?.validate || { valid: true, errors: [], warnings: [] };
    }
    if (path === "/projects/7/dataset-preparations/9/preview" && method === "POST") {
      return (
        overrides?.preview || {
          node_id: "source-1",
          columns: ["sepal_length", "target"],
          dtypes: { sepal_length: "float64", target: "int64" },
          rows: [{ sepal_length: 5.1, target: 0 }],
          row_count: 1,
          sampled: true,
          warnings: [
            "Preview uses stored DatasetVersion sample rows and may not represent the full dataset.",
          ],
        }
      );
    }
    if (path === "/projects/7/dataset-preparations/9/versions" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      overrides?.onSave?.(body);
      return {
        id: 2,
        preparation_id: 9,
        project_id: 7,
        version: 2,
        schema_version: 1,
        graph: body.graph,
        created_at: "2026-09-11T00:00:00Z",
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
    fireEvent.click(screen.getByTestId("preparation-library-join"));
    expect(await screen.findByTestId("canvas-node-join-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preparation-library-union"));
    expect(await screen.findByTestId("canvas-node-union-1")).toBeInTheDocument();
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

  it("keeps the builder read-only for viewers", async () => {
    canWriteRef.value = false;
    renderBuilder();
    await screen.findByTestId("preparation-builder");
    expect(screen.queryByTestId("preparation-library-source")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preparation-save-version")).not.toBeInTheDocument();
    expect(screen.getByTestId("react-flow")).toHaveAttribute("data-draggable", "false");
    expect(screen.getByTestId("react-flow")).toHaveAttribute("data-connectable", "false");
    fireEvent.click(screen.getByTestId("canvas-node-source-1"));
    expect(await screen.findByTestId("preparation-source-dataset")).toBeDisabled();
    expect(screen.queryByTestId("preparation-remove-node")).not.toBeInTheDocument();
  });
});
