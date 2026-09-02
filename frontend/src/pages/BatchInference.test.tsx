import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchInference from "./BatchInference";

const apiMock = vi.fn();
const downloadApiFileMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
    downloadApiFile: (...args: unknown[]) => downloadApiFileMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => true,
}));

const datasets = [
  {
    id: 1,
    project_id: 7,
    name: "iris",
    description: "",
    latest_version: 1,
    row_count: 150,
    column_count: 5,
    columns: ["a"],
    stats: {},
    created_at: "2026-08-26T00:00:00Z",
  },
];

const versions = [
  {
    id: 11,
    dataset_id: 1,
    project_id: 7,
    version: 1,
    original_filename: "iris.csv",
    format: "csv",
    row_count: 150,
    column_count: 5,
    columns: ["a"],
    dtypes: {},
    stats: {},
    source_type: "upload",
    created_at: "2026-08-26T00:00:00Z",
  },
];

const endpoints = [
  {
    id: 3,
    project_id: 7,
    name: "iris-endpoint",
    model_name: "iris",
    model_version: 1,
    model_version_id: 9,
    model_uri: "models:/iris/1",
    status: "active",
    request_count: 0,
    success_count: 0,
    error_count: 0,
    success_rate: null,
    average_latency_ms: null,
    latency_p95_ms: 0,
    feature_schema: [],
    recent_errors: [],
    created_by: 1,
    created_at: "2026-08-26T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/batch-inference"]}>
      <Routes>
        <Route path="/projects/:projectId/batch-inference" element={<BatchInference />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BatchInference polling", () => {
  beforeEach(() => {
    apiMock.mockReset();
    downloadApiFileMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls batch jobs while an active job exists and updates status", async () => {
    const pending = {
      id: 42,
      project_id: 7,
      dataset_version_id: 11,
      endpoint_id: 3,
      model_version_id: null,
      status: "pending",
      result_object_key: null,
      result_format: "csv",
      error_message: null,
      failure_details: [],
      row_count: null,
      created_by: 1,
      created_at: "2026-08-28T00:00:00Z",
      finished_at: null,
    };
    const succeeded = {
      ...pending,
      status: "succeeded",
      row_count: 150,
      finished_at: "2026-08-28T00:00:05Z",
    };
    let batchCalls = 0;

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/batch-jobs") {
        batchCalls += 1;
        return batchCalls === 1 ? [pending] : [succeeded];
      }
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/1/versions") return versions;
      if (path === "/projects/7/endpoints") return endpoints;
      if (path === "/projects/7/models") return [];
      return [];
    });

    renderPage();
    await screen.findByText("Batch #42");
    expect(screen.getByText(/pending/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2600);
    await waitFor(() => expect(screen.getByText(/succeeded/i)).toBeInTheDocument());
    expect(batchCalls).toBeGreaterThanOrEqual(2);
  });

  it("does not keep polling when only terminal jobs exist", async () => {
    const succeeded = {
      id: 7,
      project_id: 7,
      dataset_version_id: 11,
      endpoint_id: 3,
      model_version_id: null,
      status: "succeeded",
      result_object_key: "results.csv",
      result_format: "csv",
      error_message: null,
      failure_details: [],
      row_count: 150,
      created_by: 1,
      created_at: "2026-08-28T00:00:00Z",
      finished_at: "2026-08-28T00:00:05Z",
    };
    let batchCalls = 0;

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/batch-jobs") {
        batchCalls += 1;
        return [succeeded];
      }
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/1/versions") return versions;
      if (path === "/projects/7/endpoints") return endpoints;
      if (path === "/projects/7/models") return [];
      return [];
    });

    renderPage();
    await screen.findByText("Batch #7");
    const initialCalls = batchCalls;
    await vi.advanceTimersByTimeAsync(5200);
    expect(batchCalls).toBe(initialCalls);
  });

  it("does not overlap batch job poll requests when responses are slow", async () => {
    const pending = {
      id: 55,
      project_id: 7,
      dataset_version_id: 11,
      endpoint_id: 3,
      model_version_id: null,
      status: "running",
      result_object_key: null,
      result_format: "csv",
      error_message: null,
      failure_details: [],
      row_count: null,
      created_by: 1,
      created_at: "2026-08-28T00:00:00Z",
      finished_at: null,
    };
    let inFlight = 0;
    let maxInFlight = 0;
    let batchCalls = 0;

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/batch-jobs") {
        batchCalls += 1;
        if (batchCalls === 1) {
          return [pending];
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 4000);
        });
        inFlight -= 1;
        return [pending];
      }
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/1/versions") return versions;
      if (path === "/projects/7/endpoints") return endpoints;
      if (path === "/projects/7/models") return [];
      return [];
    });

    renderPage();
    await screen.findByText("Batch #55");
    const callsAfterMount = batchCalls;
    await vi.advanceTimersByTimeAsync(12000);
    expect(maxInFlight).toBe(1);
    expect(batchCalls).toBeGreaterThan(callsAfterMount);
  });

  it("cleans up polling on unmount", async () => {
    const pending = {
      id: 99,
      project_id: 7,
      dataset_version_id: 11,
      endpoint_id: 3,
      model_version_id: null,
      status: "running",
      result_object_key: null,
      result_format: "csv",
      error_message: null,
      failure_details: [],
      row_count: null,
      created_by: 1,
      created_at: "2026-08-28T00:00:00Z",
      finished_at: null,
    };
    let batchCalls = 0;

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/batch-jobs") {
        batchCalls += 1;
        return [pending];
      }
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/1/versions") return versions;
      if (path === "/projects/7/endpoints") return endpoints;
      if (path === "/projects/7/models") return [];
      return [];
    });

    const view = renderPage();
    await screen.findByText("Batch #99");
    const callsAfterMount = batchCalls;
    view.unmount();
    await vi.advanceTimersByTimeAsync(5200);
    expect(batchCalls).toBe(callsAfterMount);
  });

  it("downloads succeeded batch jobs through authenticated stream endpoint", async () => {
    const succeeded = {
      id: 7,
      project_id: 7,
      dataset_version_id: 11,
      endpoint_id: 3,
      model_version_id: null,
      status: "succeeded",
      result_object_key: "results.csv",
      result_format: "csv",
      error_message: null,
      failure_details: [],
      row_count: 150,
      created_by: 1,
      created_at: "2026-08-28T00:00:00Z",
      finished_at: "2026-08-28T00:00:05Z",
    };

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/batch-jobs") return [succeeded];
      if (path === "/projects/7/datasets") return datasets;
      if (path === "/projects/7/datasets/1/versions") return versions;
      if (path === "/projects/7/endpoints") return endpoints;
      if (path === "/projects/7/models") return [];
      return [];
    });
    downloadApiFileMock.mockResolvedValue(undefined);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => {
      expect(downloadApiFileMock).toHaveBeenCalledWith(
        "/projects/7/batch-jobs/7/download?stream=true",
        {},
        "batch-7.csv",
      );
    });
    expect(apiMock).not.toHaveBeenCalledWith(
      "/projects/7/batch-jobs/7/download",
      expect.anything(),
    );
  });
});
