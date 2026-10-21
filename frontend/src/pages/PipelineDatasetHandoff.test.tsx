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

  it("shows Korean-first create copy while pinning the exact DatasetVersion", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "데이터셋으로 파이프라인 만들기" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "파이프라인 목록으로" })).toBeInTheDocument();
    const context = screen.getByTestId("pipeline-handoff-context");
    expect(context).toHaveTextContent("사용할 데이터");
    expect(context).toHaveTextContent("DatasetVersion #42");
    expect(context).not.toHaveTextContent("DatasetVersion #99");
    expect(context).toHaveTextContent("v3");
    expect(screen.getByTestId("pipeline-handoff-pin-hint")).toHaveTextContent(
      "자동으로 바뀌지 않습니다",
    );
    expect(screen.getByTestId("pipeline-handoff-create-hint")).toHaveTextContent(
      "자동으로 실행되는 것은 아닙니다",
    );
    expect(screen.getByRole("link", { name: "데이터셋 열기" })).toHaveAttribute(
      "href",
      "/projects/7/datasets/17",
    );
    expect(screen.getByTestId("pipeline-handoff-create")).toHaveTextContent(
      "파이프라인 만들고 편집하기",
    );
    expect(screen.getByLabelText("파이프라인 이름")).toBeInTheDocument();
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
      expect(body.name).toBe("prepared-sales pipeline");
      expect(body.description).toBe("Starts from prepared-sales v3.");
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
    expect(
      await screen.findByText(/이 데이터셋에 속하지 않습니다/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/최신 버전으로 자동 대체하지 않았습니다/);
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
    expect(screen.getByTestId("pipeline-handoff-readonly")).toHaveTextContent(
      "파이프라인을 만들 권한이 없습니다",
    );
    expect(screen.queryByTestId("pipeline-handoff-form")).not.toBeInTheDocument();
  });
});
