import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import Schedules from "./Schedules";

const disabledSchedule = {
  id: 11,
  project_id: 7,
  name: "paused-import",
  description: "",
  target_type: "pipeline_run" as const,
  target_config: { pipeline_id: 1, pipeline_version_id: 1, parameters: {}, fail_policy: "stop" },
  cron_expression: "0 9 * * 1",
  timezone: "UTC",
  is_enabled: false,
  concurrency_policy: "skip" as const,
  max_concurrent_runs: 1,
  max_retries: 0,
  retry_delay_seconds: 60,
  last_run_at: null,
  next_run_at: null,
  created_by: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const apiMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path.endsWith("/schedules") && (!init || init.method === undefined)) {
    return [disabledSchedule];
  }
  if (path.endsWith("/run-now")) return { id: 99, status: "pending" };
  if (path.endsWith("/data-sources")) return [];
  if (path.endsWith("/datasets")) return [];
  if (path.endsWith("/endpoints")) return [];
  if (path.endsWith("/models")) return [];
  if (path.endsWith("/pipelines")) return [];
  return [];
});

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (path: string, init?: RequestInit) => apiMock(path, init),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => true,
}));

describe("Schedules page", () => {
  it("renders empty state", async () => {
    apiMock.mockImplementationOnce(async (path: string) => {
      if (path.endsWith("/schedules")) return [];
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/projects/7/schedules"]}>
        <Routes>
          <Route path="/projects/:projectId/schedules" element={<Schedules />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("No schedules yet")).toBeInTheDocument();
    expect(
      screen.getByText(/automate data imports, batch predictions, or pipeline runs/i),
    ).toBeInTheDocument();
  });

  it("allows Run now on disabled schedules", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/schedules"]}>
        <Routes>
          <Route path="/projects/:projectId/schedules" element={<Schedules />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("paused-import")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/schedules/11/run-now",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(
      await screen.findByText(/Run now queued for "paused-import"/i),
    ).toBeInTheDocument();
  });
});
