import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RunDetail from "./RunDetail";

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
    <MemoryRouter initialEntries={["/projects/7/experiments/runs/run-abc"]}>
      <Routes>
        <Route path="/projects/:projectId/experiments/runs/:runId" element={<RunDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("loads and displays run metrics and parameters", async () => {
    apiMock.mockResolvedValue({
      run_id: "run-abc",
      experiment_id: "1",
      status: "FINISHED",
      start_time: Date.parse("2026-01-01T00:00:00Z"),
      end_time: Date.parse("2026-01-01T00:00:05Z"),
      params: { algorithm: "ridge", target_columns: '["power_usage","cooling_load"]' },
      metrics: { val_rmse: 1.23, val_target_0_rmse: 1.1 },
      artifact_uri: "s3://bucket/artifacts/run-abc",
      tags: { "mlflow.runName": "multi-output-ridge" },
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "multi-output-ridge" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to experiments/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /compare this run/i })).not.toBeInTheDocument();
    expect(screen.getByText("Logged metrics")).toBeInTheDocument();
    expect(screen.getByText("val_rmse")).toBeInTheDocument();
    expect(screen.getByText("s3://bucket/artifacts/run-abc")).toBeInTheDocument();
    expect(screen.getByText(/"algorithm": "ridge"/)).toBeInTheDocument();
  });
});
