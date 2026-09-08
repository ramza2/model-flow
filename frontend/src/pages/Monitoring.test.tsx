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
    expect(screen.getByText("No prediction traffic")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("monitoring-window"), { target: { value: "168" } });
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("hours=168"));
  });
});
