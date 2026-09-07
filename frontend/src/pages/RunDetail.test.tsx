import { render, screen } from "@testing-library/react";
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
        <Route path="/projects/:projectId/jobs/:jobId" element={<div>Job</div>} />
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
    expect(screen.getAllByText("s3://bucket/artifacts/run-abc").length).toBeGreaterThan(0);
    expect(screen.getByTestId("run-params-json")).toHaveTextContent('"algorithm": "ridge"');
    expect(screen.getByTestId("run-targets")).toHaveTextContent("power_usage");
    expect(screen.getByTestId("run-targets")).toHaveTextContent("cooling_load");
  });

  it("links to training job from params.job_id (production shape)", async () => {
    apiMock.mockResolvedValue({
      run_id: "run-abc",
      experiment_id: "1",
      status: "FINISHED",
      start_time: null,
      end_time: null,
      params: { job_id: "99", algorithm: "ridge" },
      metrics: {},
      artifact_uri: null,
      tags: {
        "mlflow.runName": "linked-run",
      },
    });
    renderPage();
    expect(await screen.findByTestId("open-training-job")).toHaveAttribute("href", "/projects/7/jobs/99");
  });

  it("falls back to numeric training_job_id tag when params.job_id is absent", async () => {
    apiMock.mockResolvedValue({
      run_id: "run-abc",
      experiment_id: "1",
      status: "FINISHED",
      start_time: null,
      end_time: null,
      params: {},
      metrics: {},
      artifact_uri: null,
      tags: {
        "mlflow.runName": "legacy-tag-run",
        "modelflow.training_job_id": "77",
      },
    });
    renderPage();
    expect(await screen.findByTestId("open-training-job")).toHaveAttribute("href", "/projects/7/jobs/77");
  });

  it("does not invent a training job link from non-numeric values", async () => {
    apiMock.mockResolvedValue({
      run_id: "run-abc",
      experiment_id: "1",
      status: "FINISHED",
      start_time: null,
      end_time: null,
      params: { job_id: "run-abc" },
      metrics: {},
      artifact_uri: null,
      tags: { "mlflow.runName": "no-link" },
    });
    renderPage();
    await screen.findByRole("heading", { name: "no-link" });
    expect(screen.queryByTestId("open-training-job")).not.toBeInTheDocument();
  });

  it("humanizes per-target metric labels with actual target names", async () => {
    apiMock.mockResolvedValue({
      run_id: "run-abc",
      experiment_id: "1",
      status: "FINISHED",
      start_time: null,
      end_time: null,
      params: { target_columns: '["cooling_load","power_usage"]' },
      metrics: { val_target_0_rmse: 1.1 },
      artifact_uri: null,
      tags: { "mlflow.runName": "metric-labels" },
    });
    renderPage();
    await screen.findByText("val_target_0_rmse");
    const labels = screen.getAllByText(/val cooling load rmse/i);
    expect(labels.length).toBeGreaterThan(0);
    for (const node of labels) {
      expect(node.textContent || "").not.toMatch(/target 0/i);
    }
  });
});
