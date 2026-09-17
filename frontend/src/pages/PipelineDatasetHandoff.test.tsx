import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PipelineDatasetHandoff from "./PipelineDatasetHandoff";

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
  useAuth: () => ({ user: { id: 1, email: "a@b.c", is_system_admin: false } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => canWriteRef.value,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const dataset = {
  id: 17,
  project_id: 7,
  name: "prepared-sales",
  description: "",
  latest_version: 9,
  row_count: 2,
  column_count: 2,
  columns: ["region", "sales"],
  stats: {},
  created_at: "2026-09-17T00:00:00Z",
};

const versions = [
  {
    id: 42,
    dataset_id: 17,
    project_id: 7,
    version: 3,
    original_filename: "prepared-sales-v3.parquet",
    format: "parquet",
    row_count: 2,
    column_count: 2,
    columns: ["region", "sales"],
    dtypes: {},
    stats: {},
    source_type: "preparation",
    created_at: "2026-09-17T00:00:00Z",
  },
  {
    id: 99,
    dataset_id: 17,
    project_id: 7,
    version: 9,
    original_filename: "prepared-sales-v9.parquet",
    format: "parquet",
    row_count: 2,
    column_count: 2,
    columns: ["region", "sales"],
    dtypes: {},
    stats: {},
    source_type: "preparation",
    created_at: "2026-09-17T00:00:00Z",
  },
];

function renderPage(query = "datasetId=17&datasetVersionId=42&from=preparation") {
  return render(
    <MemoryRouter initialEntries={[`/projects/7/pipelines/from-dataset?${query}`]}>
      <Routes>
        <Route
          path="/projects/:projectId/pipelines/from-dataset"
          element={<PipelineDatasetHandoff />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PipelineDatasetHandoff", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    canWriteRef.value = true;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/datasets/17") return dataset;
      if (path === "/projects/7/datasets/17/versions") return versions;
      if (path === "/projects/7/pipelines" && method === "POST") {
        return {
          id: 88,
          project_id: 7,
          name: "prepared-sales pipeline",
          description: "",
          status: "draft",
          latest_version: 1,
          is_template: false,
          created_at: "2026-09-17T00:00:00Z",
        };
      }
      throw new Error(`Unhandled ${method} ${path}`);
    });
  });

  it("creates a pipeline pinned to the requested historical DatasetVersion, not latest", async () => {
    renderPage();
    expect(await screen.findByTestId("pipeline-handoff-context")).toHaveTextContent(
      "DatasetVersion #42",
    );
    expect(screen.getByTestId("pipeline-handoff-context")).not.toHaveTextContent(
      "DatasetVersion #99",
    );

    fireEvent.click(screen.getByTestId("pipeline-handoff-create"));

    await waitFor(() => {
      const post = apiMock.mock.calls.find(
        ([path, init]) =>
          path === "/projects/7/pipelines" &&
          ((init as RequestInit | undefined)?.method || "GET").toUpperCase() === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body));
      expect(body.graph.nodes).toHaveLength(1);
      expect(body.graph.nodes[0].data.config).toEqual({
        dataset_id: 17,
        dataset_version_id: 42,
      });
    });
    expect(navigateMock).toHaveBeenCalledWith("/projects/7/pipelines/88");
  });

  it("rejects a DatasetVersion that is not in the selected dataset without latest fallback", async () => {
    renderPage("datasetId=17&datasetVersionId=777&from=preparation");
    expect(await screen.findByText(/does not belong to this dataset/i)).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-handoff-form")).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith(
      "/projects/7/pipelines",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the exact dataset context readable but withholds mutation for read-only users", async () => {
    canWriteRef.value = false;
    renderPage();
    expect(await screen.findByTestId("pipeline-handoff-context")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-handoff-readonly")).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-handoff-form")).not.toBeInTheDocument();
  });
});
