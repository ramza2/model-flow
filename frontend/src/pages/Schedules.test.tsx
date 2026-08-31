import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Schedules from "./Schedules";

const enabledSchedule = {
  id: 10,
  project_id: 7,
  name: "weekly-pipeline",
  description: "",
  target_type: "pipeline_run" as const,
  target_config: { pipeline_id: 1, pipeline_version_id: 1, parameters: {}, fail_policy: "stop" },
  cron_expression: "0 9 * * 1",
  timezone: "UTC",
  is_enabled: true,
  concurrency_policy: "skip" as const,
  max_concurrent_runs: 1,
  max_retries: 0,
  retry_delay_seconds: 60,
  last_run_at: null,
  next_run_at: "2026-02-01T09:00:00Z",
  created_by: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const disabledSchedule = {
  ...enabledSchedule,
  id: 11,
  name: "paused-import",
  is_enabled: false,
  next_run_at: null,
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/schedules"]}>
      <Routes>
        <Route path="/projects/:projectId/schedules" element={<Schedules />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Schedules page", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders empty state", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/schedules")) return [];
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });
    renderPage();
    expect(await screen.findByText("No schedules yet")).toBeInTheDocument();
    expect(
      screen.getByText(/automate data imports, batch predictions, or pipeline runs/i),
    ).toBeInTheDocument();
  });

  it("uses shared button classes across schedule actions", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/schedules")) return [enabledSchedule, disabledSchedule];
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });
    renderPage();
    expect(await screen.findByTestId("schedule-create-open")).toHaveClass("btn");
    expect(screen.getAllByRole("button", { name: "Run now" })[0]).toHaveClass("btn");
    expect(screen.getAllByRole("button", { name: "Disable" })[0]).toHaveClass("btn", "secondary");
    expect(screen.getAllByRole("button", { name: "Edit" })[0]).toHaveClass("btn", "secondary");
    expect(screen.getAllByRole("button", { name: "Delete" })[0]).toHaveClass(
      "btn",
      "link",
      "danger-text",
    );
    expect(screen.getAllByRole("button", { name: "History" })[0]).toHaveClass("btn", "secondary");
  });

  it("allows Run now on disabled schedules", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
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
    renderPage();
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

  it("uses checkbox-row for the Enabled field in the create form", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/schedules")) return [enabledSchedule];
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("schedule-create-open"));
    const enabledCheckbox = screen.getByRole("checkbox");
    expect(enabledCheckbox.closest("label")).toHaveClass("checkbox-row");
    expect(enabledCheckbox).toBeInTheDocument();
    expect(screen.getByTestId("schedule-submit")).toHaveClass("btn");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("btn", "secondary");
  });

  it("polls run history while active runs exist and stops at terminal status", async () => {
    const pendingRun = {
      id: 501,
      schedule_id: 11,
      project_id: 7,
      target_type: "pipeline_run" as const,
      scheduled_for: "2026-08-31T00:00:00Z",
      attempt: 1,
      trigger_source: "manual" as const,
      status: "pending",
      target_resource_id: null,
      error_message: null,
      ready_at: "2026-08-31T00:00:00Z",
      started_at: null,
      finished_at: null,
      created_at: "2026-08-31T00:00:00Z",
    };
    const succeededRun = {
      ...pendingRun,
      status: "succeeded",
      target_resource_id: 88,
      started_at: "2026-08-31T00:00:01Z",
      finished_at: "2026-08-31T00:00:05Z",
    };
    let historyCalls = 0;

    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/schedules") && (!init || init.method === undefined)) {
        return [disabledSchedule];
      }
      if (path.endsWith("/schedules/11/runs")) {
        historyCalls += 1;
        return historyCalls === 1 ? [pendingRun] : [succeededRun];
      }
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByText(/pending/i)).toBeInTheDocument();
    const initialCalls = historyCalls;

    await vi.advanceTimersByTimeAsync(2600);
    await waitFor(() => expect(screen.getByText(/succeeded/i)).toBeInTheDocument());
    expect(historyCalls).toBeGreaterThan(initialCalls);

    const callsAfterTerminal = historyCalls;
    await vi.advanceTimersByTimeAsync(5200);
    expect(historyCalls).toBe(callsAfterTerminal);
  });

  it("cleans up history polling when the panel is closed", async () => {
    const pendingRun = {
      id: 601,
      schedule_id: 11,
      project_id: 7,
      target_type: "pipeline_run" as const,
      scheduled_for: "2026-08-31T00:00:00Z",
      attempt: 1,
      trigger_source: "manual" as const,
      status: "pending",
      target_resource_id: null,
      error_message: null,
      ready_at: "2026-08-31T00:00:00Z",
      started_at: null,
      finished_at: null,
      created_at: "2026-08-31T00:00:00Z",
    };
    let historyCalls = 0;

    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/schedules")) return [disabledSchedule];
      if (path.endsWith("/schedules/11/runs")) {
        historyCalls += 1;
        return [pendingRun];
      }
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByText(/pending/i);
    const callsBeforeClose = historyCalls;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await vi.advanceTimersByTimeAsync(5200);
    expect(historyCalls).toBe(callsBeforeClose);
  });

  it("cleans up polling when switching to another schedule history", async () => {
    const pendingRun = {
      id: 701,
      schedule_id: 10,
      project_id: 7,
      target_type: "pipeline_run" as const,
      scheduled_for: "2026-08-31T00:00:00Z",
      attempt: 1,
      trigger_source: "manual" as const,
      status: "pending",
      target_resource_id: null,
      error_message: null,
      ready_at: "2026-08-31T00:00:00Z",
      started_at: null,
      finished_at: null,
      created_at: "2026-08-31T00:00:00Z",
    };
    const terminalRun = {
      ...pendingRun,
      id: 702,
      schedule_id: 11,
      status: "succeeded",
      target_resource_id: 44,
      finished_at: "2026-08-31T00:00:05Z",
    };
    let historyCallsFor10 = 0;
    let historyCallsFor11 = 0;

    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/schedules")) return [enabledSchedule, disabledSchedule];
      if (path.endsWith("/schedules/10/runs")) {
        historyCallsFor10 += 1;
        return [pendingRun];
      }
      if (path.endsWith("/schedules/11/runs")) {
        historyCallsFor11 += 1;
        return [terminalRun];
      }
      if (path.endsWith("/data-sources")) return [];
      if (path.endsWith("/datasets")) return [];
      if (path.endsWith("/endpoints")) return [];
      if (path.endsWith("/models")) return [];
      if (path.endsWith("/pipelines")) return [];
      return [];
    });

    renderPage();
    const historyButtons = await screen.findAllByRole("button", { name: "History" });
    fireEvent.click(historyButtons[0]);
    await screen.findByText(/Run history — weekly-pipeline/i);
    const callsBeforeSwitch = historyCallsFor10;
    fireEvent.click(historyButtons[1]);
    await screen.findByText(/Run history — paused-import/i);
    await vi.advanceTimersByTimeAsync(5200);
    expect(historyCallsFor10).toBe(callsBeforeSwitch);
    expect(historyCallsFor11).toBe(1);
  });
});
