import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPredictionSamplePayload, sampleValueForDtype } from "../trainingConfig";
import Predict from "./Predict";

const apiMock = vi.fn();

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
  useProject: () => ({ selectedProject: { id: 7, role: "PROJECT_ADMIN" } }),
  userCanProject: () => true,
}));

const baseEndpoint = {
  id: 9,
  project_id: 7,
  name: "demand-ep",
  model_name: "demand-model",
  model_version: "1",
  model_version_id: 3,
  model_uri: "models:/demand-model/1",
  status: "ready",
  request_count: 0,
  success_count: 0,
  error_count: 0,
  success_rate: null,
  average_latency_ms: null,
  latency_p95_ms: 0,
  recent_errors: [],
  created_at: "2026-07-01T00:00:00Z",
};

function renderPredict() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/deployments/9/predict"]}>
      <Routes>
        <Route path="/projects/:projectId/deployments/:endpointId/predict" element={<Predict />} />
      </Routes>
    </MemoryRouter>,
  );
}

function payloadValue(): string {
  return (screen.getByTestId("predict-payload") as HTMLTextAreaElement).value;
}

describe("buildPredictionSamplePayload regression", () => {
  it("uses preview values for string feature schemas instead of all zeros", () => {
    const sample = buildPredictionSamplePayload(
      ["site_id", "measured_at", "supply_temp"],
      {
        site_id: "SITE_A",
        measured_at: "2026-07-01T09:00:00",
        supply_temp: 72.4,
        demand_level: "HIGH",
      },
    );
    expect(sample[0]).toEqual({
      site_id: "SITE_A",
      measured_at: "2026-07-01T09:00:00",
      supply_temp: 72.4,
    });
    expect(sample[0]).not.toEqual({
      site_id: 0,
      measured_at: 0,
      supply_temp: 0,
    });
  });

  it("does not treat bare string schema as float when preview is missing", () => {
    const sample = buildPredictionSamplePayload(["site_id", "supply_temp"]);
    expect(sample[0]).toEqual({ site_id: "sample", supply_temp: "sample" });
    expect(sampleValueForDtype("object")).toBe("sample");
  });
});

describe("Predict prediction sample payload", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("seeds textarea from endpoint.prediction_sample", async () => {
    apiMock.mockResolvedValue({
      ...baseEndpoint,
      feature_schema: ["site_id", "measured_at", "supply_temp"],
      prediction_sample: {
        site_id: "SITE_A",
        measured_at: "2026-07-01T09:00:00",
        supply_temp: 72.4,
      },
    });
    renderPredict();
    await screen.findByTestId("predict-payload");
    await waitFor(() => {
      expect(payloadValue()).toContain("SITE_A");
      expect(payloadValue()).toContain("2026-07-01T09:00:00");
      expect(payloadValue()).toContain("72.4");
    });
    expect(payloadValue()).not.toMatch(/"site_id":\s*0/);
    expect(JSON.parse(payloadValue())).toEqual([
      {
        site_id: "SITE_A",
        measured_at: "2026-07-01T09:00:00",
        supply_temp: 72.4,
      },
    ]);
  });

  it("falls back when prediction_sample is missing", async () => {
    apiMock.mockResolvedValue({
      ...baseEndpoint,
      feature_schema: [
        { name: "site_id", dtype: "object" },
        { name: "hour", dtype: "int64" },
      ],
      prediction_sample: null,
    });
    renderPredict();
    await screen.findByTestId("predict-payload");
    await waitFor(() => {
      expect(payloadValue()).toContain('"site_id": "sample"');
      expect(payloadValue()).toContain('"hour": 0');
    });
  });

  it("keeps user edits after initial sample load", async () => {
    apiMock.mockResolvedValue({
      ...baseEndpoint,
      feature_schema: ["site_id"],
      prediction_sample: { site_id: "SITE_A" },
    });
    renderPredict();
    await screen.findByTestId("predict-payload");
    await waitFor(() => expect(payloadValue()).toContain("SITE_A"));
    const edited = JSON.stringify([{ site_id: "SITE_B" }], null, 2);
    fireEvent.change(screen.getByTestId("predict-payload"), { target: { value: edited } });
    expect(payloadValue()).toBe(edited);
  });

  it("shows stopped endpoint start UX", async () => {
    apiMock.mockResolvedValue({
      ...baseEndpoint,
      status: "stopped",
      feature_schema: [
        { name: "site_id", dtype: "object" },
        { name: "hour", dtype: "int64" },
      ],
      prediction_sample: { site_id: "SITE_A", hour: 9 },
    });
    renderPredict();
    expect(await screen.findByTestId("endpoint-stopped-notice")).toHaveTextContent(
      "This endpoint is stopped",
    );
    expect(screen.getByTestId("start-endpoint")).toBeInTheDocument();
    expect(screen.getByTestId("predict-submit")).toBeDisabled();
    expect(payloadValue()).toContain("SITE_A");
  });

  it("renders multi-output prediction previews as JSON objects", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/predict") && init?.method === "POST") {
        return {
          predictions: [
            { demand_kw: 12.5, supply_temp: 68.2 },
            { demand_kw: 10.1, supply_temp: 66.0 },
          ],
          model_uri: "models:/demand-model/1",
        };
      }
      return {
        ...baseEndpoint,
        feature_schema: ["site_id", "hour"],
        prediction_sample: { site_id: "SITE_A", hour: 9 },
      };
    });
    renderPredict();
    await screen.findByTestId("predict-payload");
    fireEvent.click(screen.getByTestId("predict-submit"));
    const preview = await screen.findByTestId("predict-preview");
    expect(preview).toHaveTextContent('"demand_kw": 12.5');
    expect(preview).toHaveTextContent('"supply_temp": 68.2');
    expect(preview.textContent).toContain("\n");
    expect(screen.getByTestId("predict-result")).toHaveTextContent("demand_kw");
  });
});
