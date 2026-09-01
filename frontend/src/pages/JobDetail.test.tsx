import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JobDetail from "./JobDetail";

const apiMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

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
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => true,
}));

const succeededJob = {
  id: 42,
  project_id: 7,
  dataset_id: 3,
  dataset_version_id: 30,
  split_id: null,
  name: "baseline",
  description: "",
  target_column: "target",
  problem_type: "classification",
  algorithm: "random_forest",
  hyperparameters: { n_estimators: 50 },
  preprocessing: {},
  feature_columns: ["a", "b"],
  metrics_config: [],
  resources: {},
  ratios: { train: 0.7, validation: 0.15, test: 0.15 },
  random_seed: 42,
  status: "succeeded",
  logs: "done",
  mlflow_run_id: "run-1",
  model_uri: "runs:/run-1/model",
  metrics: { accuracy: 0.9 },
  error_message: null,
  retry_count: 0,
  max_retries: 1,
  parent_job_id: null,
  retrain_source_job_id: 10,
  is_retrain: true,
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:01Z",
  finished_at: "2026-01-01T00:00:05Z",
};

const pendingJob = { ...succeededJob, id: 43, status: "pending", is_retrain: false, retrain_source_job_id: null };

function renderPage(jobId = "42") {
  return render(
    <MemoryRouter initialEntries={[`/projects/7/jobs/${jobId}`]}>
      <Routes>
        <Route path="/projects/:projectId/jobs/:jobId" element={<JobDetail />} />
        <Route path="/projects/:projectId/jobs/:newJobId" element={<JobDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("JobDetail retrain", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Retrain on succeeded jobs only", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) return succeededJob;
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-retrain")).toBeInTheDocument();
    expect(screen.queryByTestId("job-retry")).not.toBeInTheDocument();
  });

  it("hides Retrain on non-succeeded jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/43")) return pendingJob;
      return [];
    });
    renderPage("43");
    await screen.findByText("baseline");
    expect(screen.queryByTestId("job-retrain")).not.toBeInTheDocument();
  });

  it("opens retrain dialog with read-only source summary and submits", async () => {
    const versions = [
      {
        id: 30,
        dataset_id: 3,
        project_id: 7,
        version: 1,
        original_filename: "v1.csv",
        format: "csv",
        row_count: 10,
        column_count: 3,
        columns: ["a", "b", "target"],
        dtypes: {},
        stats: {},
        source_type: "upload",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 31,
        dataset_id: 3,
        project_id: 7,
        version: 2,
        original_filename: "v2.csv",
        format: "csv",
        row_count: 12,
        column_count: 3,
        columns: ["a", "b", "target"],
        dtypes: {},
        stats: {},
        source_type: "upload",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/jobs/42") && (!init || init.method === undefined)) return succeededJob;
      if (path.endsWith("/datasets/3/versions")) return versions;
      if (path.endsWith("/dataset-versions/31/splits")) return [];
      if (path.endsWith("/retrain")) {
        return { ...succeededJob, id: 99, name: "baseline (retrain)", dataset_version_id: 31, is_retrain: true, retrain_source_job_id: 42, status: "pending" };
      }
      return [];
    });
    renderPage("42");
    fireEvent.click(await screen.findByTestId("job-retrain"));
    expect(await screen.findByTestId("retrain-source-summary")).toHaveTextContent("target");
    expect(screen.getByTestId("retrain-source-summary")).toHaveTextContent("random forest");
    fireEvent.change(screen.getByTestId("retrain-dataset-version"), { target: { value: "31" } });
    fireEvent.change(screen.getByTestId("retrain-name"), { target: { value: "baseline v2 retrain" } });
    fireEvent.click(screen.getByTestId("retrain-submit"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/jobs/42/retrain",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            dataset_version_id: 31,
            split_id: null,
            name: "baseline v2 retrain",
          }),
        }),
      );
    });
    expect(navigateMock).toHaveBeenCalledWith("/projects/7/jobs/99");
  });

  it("shows retrain lineage link on retrained jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) return succeededJob;
      return [];
    });
    renderPage("42");
    const lineage = await screen.findByTestId("job-retrain-lineage");
    expect(lineage).toHaveTextContent("Job #10");
    expect(lineage.querySelector("a")).toHaveAttribute("href", "/projects/7/jobs/10");
  });
});
