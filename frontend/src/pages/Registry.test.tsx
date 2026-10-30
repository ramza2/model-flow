import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Registry from "./Registry";

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
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => canWriteRef.value,
}));

describe("Registry lifecycle UX", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
  });

  it("includes VALIDATING in the lifecycle filter", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/projects/7/models")) return [];
      if (path.startsWith("/projects/7/experiments/runs")) return [];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/projects/7/registry"]}>
        <Routes>
          <Route path="/projects/:projectId/registry" element={<Registry />} />
        </Routes>
      </MemoryRouter>,
    );
    const filter = await screen.findByTestId("registry-lifecycle-filter");
    const options = Array.from(filter.querySelectorAll("option")).map((option) => option.getAttribute("value"));
    expect(options).toContain("VALIDATING");
    expect(options).toEqual(expect.arrayContaining([
      "CANDIDATE",
      "VALIDATING",
      "PENDING_APPROVAL",
      "APPROVED",
      "PRODUCTION",
      "REJECTED",
      "ARCHIVED",
    ]));
  });

  it("suggests model name from run display name instead of classifier", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/projects/7/models")) return [];
      if (path.startsWith("/projects/7/experiments/runs")) {
        return [
          {
            run_id: "run-1",
            experiment_id: "1",
            status: "FINISHED",
            start_time: null,
            end_time: null,
            params: { algorithm: "ridge" },
            metrics: {},
            artifact_uri: null,
            tags: { "mlflow.runName": "Multi Output Smoke Training" },
          },
        ];
      }
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/projects/7/registry"]}>
        <Routes>
          <Route path="/projects/:projectId/registry" element={<Registry />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /학습 결과로 모델 등록/i }));
    await waitFor(() => {
      expect(screen.getByTestId("register-name")).toHaveValue("multi_output_smoke_training");
    });
    expect(screen.getByTestId("register-name")).not.toHaveValue("classifier");
  });

  it("shows Korean lifecycle labels while keeping API filter values unchanged", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/projects/7/models")) return [{
        id: 5,
        name: "heat-demand-ridge-t123-uat",
        version: "1",
        lifecycle: "CANDIDATE",
        gates_passed: true,
        metrics: { val_rmse: 22.185 },
        metadata: { problem_type: "regression" },
        created_at: "2026-10-29T00:00:00Z",
      }];
      if (path.startsWith("/projects/7/experiments/runs")) return [];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/projects/7/registry"]}>
        <Routes><Route path="/projects/:projectId/registry" element={<Registry />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("heat-demand-ridge-t123-uat")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "모델 관리" })).toBeInTheDocument();
    expect(screen.getByText("검증 · RMSE: 22.185")).toBeInTheDocument();
    expect(screen.getAllByText("후보 모델").length).toBeGreaterThanOrEqual(2);
    const filter = screen.getByTestId("registry-lifecycle-filter");
    expect(filter.querySelector('option[value="PENDING_APPROVAL"]')).toHaveTextContent("승인 대기");
    fireEvent.change(filter, { target: { value: "CANDIDATE" } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/projects/7/models?lifecycle=CANDIDATE"));
  });
});
