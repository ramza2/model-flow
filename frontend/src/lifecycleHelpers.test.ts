import { describe, expect, it } from "vitest";
import {
  formatNamedPrediction,
  lifecycleLabel,
  lifecycleStepperStates,
  parseTargetsFromParams,
  suggestModelNameFromRun,
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
});
