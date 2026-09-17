import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PreparationLifecyclePage from "./PreparationLifecyclePage";

const apiMock = vi.fn();
const canCreatePipelineRef = { value: true };

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
  userCanProject: () => canCreatePipelineRef.value,
}));

vi.mock("./PreparationBuilder", () => ({
  default: () => <div data-testid="preparation-builder-stub">Preparation builder</div>,
}));

const datasets = [
  {
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
  },
];

const runs = [
  {
    id: 501,
    preparation_id: 5,
    preparation_version_id: 3,
    status: "succeeded",
    inputs: [],
    output_dataset_id: 17,
    output_dataset_version_id: 42,
    logs: "",
    error_message: null,
    created_at: "2026-09-17T00:00:00Z",
    started_at: "2026-09-17T00:00:01Z",
    finished_at: "2026-09-17T00:00:02Z",
  },
  {
    id: 502,
    preparation_id: 5,
    preparation_version_id: 4,
    status: "failed",
    inputs: [],
    output_dataset_id: null,
    output_dataset_version_id: null,
    logs: "",
    error_message: "boom",
    created_at: "2026-09-17T00:00:00Z",
    started_at: "2026-09-17T00:00:01Z",
    finished_at: "2026-09-17T00:00:02Z",
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/preparations/5"]}>
      <Routes>
        <Route
          path="/projects/:projectId/preparations/:preparationId"
          element={<PreparationLifecyclePage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PreparationLifecyclePage", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canCreatePipelineRef.value = true;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/dataset-preparations/5/runs") return runs;
      if (path === "/projects/7/datasets") return datasets;
      throw new Error(`Unhandled GET ${path}`);
    });
  });

  it("offers the exact historical output DatasetVersion as a pipeline input", async () => {
    renderPage();
    expect(screen.getByTestId("preparation-builder-stub")).toBeInTheDocument();
    const result = await screen.findByTestId("preparation-pipeline-result-501");
    expect(result).toHaveTextContent("DatasetVersion #42");
    expect(screen.queryByTestId("preparation-pipeline-result-502")).not.toBeInTheDocument();
    expect(screen.getByTestId("preparation-use-in-pipeline-501")).toHaveAttribute(
      "href",
      "/projects/7/pipelines/from-dataset?datasetId=17&datasetVersionId=42&from=preparation",
    );
  });

  it("withholds the pipeline mutation link when the project role cannot create pipelines", async () => {
    canCreatePipelineRef.value = false;
    renderPage();
    expect(await screen.findByTestId("preparation-pipeline-result-501")).toBeInTheDocument();
    expect(screen.queryByTestId("preparation-use-in-pipeline-501")).not.toBeInTheDocument();
  });
});
