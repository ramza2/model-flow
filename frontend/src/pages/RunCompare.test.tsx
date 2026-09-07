import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RunCompare from "./RunCompare";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/experiments/compare?run_ids=run-a,run-b"]}>
      <Routes>
        <Route path="/projects/:projectId/experiments/compare" element={<RunCompare />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunCompare", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("does not map target_0 to the first run target when compared runs disagree", async () => {
    apiMock.mockResolvedValue({
      runs: [
        {
          run_id: "run-a",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["cooling_load","power_usage"]', algorithm: "ridge" },
          metrics: { val_target_0_rmse: 1.1 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-a" },
        },
        {
          run_id: "run-b",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["temperature","humidity"]', algorithm: "ridge" },
          metrics: { val_target_0_rmse: 2.2 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-b" },
        },
      ],
      metric_keys: ["val_target_0_rmse"],
      param_keys: ["target_columns", "algorithm"],
    });
    renderPage();
    await screen.findByText("val_target_0_rmse");
    expect(screen.queryByText(/cooling load/i)).not.toBeInTheDocument();
    expect(screen.getByText(/val target 0 rmse/i)).toBeInTheDocument();
  });

  it("humanizes per-target metrics when all compared runs share targets", async () => {
    apiMock.mockResolvedValue({
      runs: [
        {
          run_id: "run-a",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["cooling_load","power_usage"]', algorithm: "ridge" },
          metrics: { val_target_0_rmse: 1.1 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-a" },
        },
        {
          run_id: "run-b",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["cooling_load","power_usage"]', algorithm: "lasso" },
          metrics: { val_target_0_rmse: 2.2 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-b" },
        },
      ],
      metric_keys: ["val_target_0_rmse"],
      param_keys: ["target_columns", "algorithm"],
    });
    renderPage();
    await screen.findByText("val_target_0_rmse");
    expect(screen.getByText(/val cooling load rmse/i)).toBeInTheDocument();
  });
});
