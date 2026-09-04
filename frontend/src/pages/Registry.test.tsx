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
    fireEvent.click(await screen.findByRole("button", { name: /Register from run/i }));
    await waitFor(() => {
      expect(screen.getByTestId("register-name")).toHaveValue("multi_output_smoke_training");
    });
    expect(screen.getByTestId("register-name")).not.toHaveValue("classifier");
  });
});
