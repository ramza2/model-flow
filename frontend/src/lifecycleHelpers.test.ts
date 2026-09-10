import { describe, expect, it } from "vitest";
import {
  formatNamedPrediction,
  formatOutputTargetsLabel,
  formatPredictionSummary,
  isScalarPrediction,
  lifecycleLabel,
  lifecycleStepperStates,
  parseTargetsFromParams,
  resolveTrainingJobIdFromRun,
  suggestModelNameFromRun,
  targetColumnsAreIdentical,
} from "./lifecycleHelpers";

describe("lifecycleHelpers", () => {
  it("labels lifecycle values for display", () => {
    expect(lifecycleLabel("PENDING_APPROVAL")).toBe("Pending Approval");
    expect(lifecycleLabel("VALIDATING")).toBe("Validating");
  });

  it("builds a rejected path that never implies production", () => {
    const steps = lifecycleStepperStates("REJECTED");
    expect(steps.map((step) => step.id)).toEqual([
      "CANDIDATE",
      "VALIDATING",
      "PENDING_APPROVAL",
      "REJECTED",
    ]);
    expect(steps[steps.length - 1]?.state).toBe("rejected");
    expect(steps.some((step) => step.id === "PRODUCTION")).toBe(false);
  });

  it("marks the current production step as current", () => {
    const steps = lifecycleStepperStates("PRODUCTION");
    expect(steps.find((step) => step.id === "PRODUCTION")?.state).toBe("current");
    expect(steps.find((step) => step.id === "CANDIDATE")?.state).toBe("complete");
  });

  it("treats archived as an inactive terminal step", () => {
    const steps = lifecycleStepperStates("ARCHIVED");
    expect(steps[steps.length - 1]).toEqual({
      id: "ARCHIVED",
      label: "Archived",
      state: "current",
    });
  });

  it("formats named multi-output predictions", () => {
    expect(
      formatNamedPrediction({ cooling_load: 8.2226, power_usage: 11.9283 }),
    ).toContain("cooling_load: 8.2226");
    expect(formatNamedPrediction({ cooling_load: 1, power_usage: 2 })).not.toMatch(/prediction\[/);
  });

  it("suggests model names from run tags", () => {
    expect(
      suggestModelNameFromRun({
        run_id: "abc",
        tags: { "mlflow.runName": "Multi Output Smoke Training" },
      }),
    ).toBe("multi_output_smoke_training");
  });

  it("parses JSON and comma-separated target params", () => {
    expect(parseTargetsFromParams({ target_columns: '["cooling_load","power_usage"]' })).toEqual([
      "cooling_load",
      "power_usage",
    ]);
    expect(parseTargetsFromParams({ target_column: "target" })).toEqual(["target"]);
  });

  it("resolves training job id from params.job_id with numeric tag fallback", () => {
    expect(
      resolveTrainingJobIdFromRun({
        params: { job_id: "99" },
        tags: { "modelflow.training_job_id": "1" },
      }),
    ).toBe("99");
    expect(
      resolveTrainingJobIdFromRun({
        params: {},
        tags: { "modelflow.training_job_id": "42" },
      }),
    ).toBe("42");
    expect(
      resolveTrainingJobIdFromRun({
        params: { job_id: "abc" },
        tags: {},
      }),
    ).toBeNull();
  });

  it("detects identical ordered target lists across runs", () => {
    expect(
      targetColumnsAreIdentical([
        ["cooling_load", "power_usage"],
        ["cooling_load", "power_usage"],
      ]),
    ).toBe(true);
    expect(
      targetColumnsAreIdentical([
        ["cooling_load", "power_usage"],
        ["temperature", "humidity"],
      ]),
    ).toBe(false);
  });

  it("labels scalar predictions with output target metadata once", () => {
    expect(isScalarPrediction(2.427515273680638)).toBe(true);
    expect(formatPredictionSummary(2.427515273680638, ["price"])).toBe("price: 2.4275");
    expect(formatPredictionSummary(2.427515273680638, [])).toBe("Prediction: 2.4275");
    expect(formatOutputTargetsLabel(["price"])).toBe("Output: price");
    expect(formatOutputTargetsLabel(["price", "quantity"])).toBe("Outputs: price, quantity");
    expect(formatOutputTargetsLabel([])).toBe("Output: Prediction");
  });

  it("keeps named multi-output prediction summaries", () => {
    expect(isScalarPrediction({ price: 1.2, quantity: 3 })).toBe(false);
    expect(formatPredictionSummary({ price: 1.25, quantity: 3 }, ["price", "quantity"])).toBe(
      "price: 1.2500\nquantity: 3.0000",
    );
    expect(formatNamedPrediction({ price: 1.25, quantity: 3 })).toContain("price:");
  });
});
