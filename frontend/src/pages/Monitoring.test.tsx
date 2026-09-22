import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Monitoring from "./Monitoring";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

describe("Monitoring", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/monitoring/service")) {
        return {
          request_count: 12,
          success_count: 10,
          error_count: 2,
          success_rate: 10 / 12,
          average_latency_ms: 18.2,
          p95_latency_ms: 25.1,
          series: [],
        };
      }
      if (path.endsWith("/monitoring/data")) {
        return {
          dataset_count: 2,
          dataset_version_count: 4,
          quality_check_count: 3,
          failed_quality_check_count: 1,
          latest_quality_status: "failed",
        };
      }
      if (path.endsWith("/monitoring/models")) {
        return {
          model_version_count: 5,
          lifecycle_counts: { PRODUCTION: 1, CANDIDATE: 4 },
          endpoint_count: 2,
          ready_endpoint_count: 1,
          total_requests: 100,
          total_errors: 4,
          latest_drift_status: null,
        };
      }
      if (path.endsWith("/model-quality/summary")) {
        return {
          items: [
            {
              policy_id: 1,
              policy_name: "Endpoint quality",
              endpoint_id: 9,
              endpoint_name: "prod-iris",
              current_model_version_id: 3,
              current_model_name: "iris",
              current_model_version: "1",
              latest_quality_status: "critical",
              primary_metric: "f1_macro",
              primary_metric_value: 0.4,
              matched_ground_truth_count: 25,
              prediction_count: 30,
              match_rate: 25 / 30,
              window_start: null,
              window_end: null,
              last_evaluated_at: "2026-01-01T00:00:00Z",
              closed_loop_state: "Candidate ready",
              latest_run_id: 11,
            },
          ],
        };
      }
      if (path.includes("/model-quality/runs")) {
        return [
          {
            id: 11,
            quality_status: "critical",
            status: "succeeded",
            matched_ground_truth_count: 25,
            finished_at: "2026-01-01T00:00:00Z",
          },
        ];
      }
      throw new Error(`unexpected ${path}`);
    });
  });

  it("renders Service/Data/Model sections with factual attention", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/monitoring"]}>
        <Routes>
          <Route path="/projects/:projectId/monitoring" element={<Monitoring />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("monitoring-attention")).toHaveTextContent("2 prediction errors");
    expect(screen.getByTestId("monitoring-attention")).toHaveTextContent("1 failed quality check");
    expect(screen.getByTestId("monitoring-attention")).toHaveTextContent("1 / 2 deployments ready");
    expect(screen.getByTestId("monitoring-service")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-data")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-models")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-production-quality")).toBeInTheDocument();
    expect(screen.getByTestId("matched-gt-1")).toHaveTextContent("25");
    expect(screen.getByTestId("closed-loop-state-9")).toHaveTextContent("Candidate ready");
    expect(screen.getByText("No prediction traffic")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("monitoring-window"), { target: { value: "168" } });
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("hours=168"));
  });
});
