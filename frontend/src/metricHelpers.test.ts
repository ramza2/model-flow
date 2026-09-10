import { describe, expect, it } from "vitest";
import {
  formatMetricLabel,
  formatPrimaryMetric,
  resolveDisplayProblemType,
  selectPrimaryMetric,
} from "./metricHelpers";

describe("metricHelpers", () => {
  it("maps per-target metric keys to target names", () => {
    expect(formatMetricLabel("val_target_0_rmse", ["cooling_load", "power_usage"])).toBe(
      "val cooling load rmse",
    );
    expect(formatMetricLabel("val_target_1_mae", ["cooling_load", "power_usage"])).toBe(
      "val power usage mae",
    );
  });

  it("keeps single-output metric labels unchanged", () => {
    expect(formatMetricLabel("val_rmse", ["price"])).toBe("val rmse");
    expect(formatMetricLabel("accuracy", [])).toBe("accuracy");
  });

  it("prefers aggregate regression metrics for multi-output models", () => {
    const metrics = {
      val_target_0_rmse: 1.1,
      val_target_1_rmse: 1.2,
      val_rmse: 1.15,
      rmse: 1.05,
    };
    expect(selectPrimaryMetric(metrics, { preferAggregate: true })).toEqual({
      key: "val_rmse",
      value: 1.15,
    });
    expect(formatPrimaryMetric(metrics, { problemType: "regression" })).toBe("val rmse: 1.150");
  });

  it("keeps classification primary metric behavior", () => {
    const metrics = { val_accuracy: 0.91, accuracy: 0.9 };
    expect(selectPrimaryMetric(metrics, { problemType: "classification" })).toEqual({
      key: "val_accuracy",
      value: 0.91,
    });
  });

  it("resolves explicit problem types without inspecting metrics", () => {
    expect(resolveDisplayProblemType("regression", {})).toBe("regression");
    expect(resolveDisplayProblemType("classification", { val_rmse: 1 })).toBe("classification");
  });

  it("resolves auto from regression metrics", () => {
    expect(resolveDisplayProblemType("auto", { val_rmse: 0.42, rmse: 0.5 })).toBe("regression");
  });

  it("resolves auto from classification metrics", () => {
    expect(resolveDisplayProblemType("auto", { val_accuracy: 0.91, accuracy: 0.9 })).toBe(
      "classification",
    );
  });

  it("keeps auto when metrics are empty or unrecognized", () => {
    expect(resolveDisplayProblemType("auto", {})).toBe("auto");
    expect(resolveDisplayProblemType("auto", { loss: 0.1 })).toBe("auto");
    expect(resolveDisplayProblemType("auto", null)).toBe("auto");
  });
});
