import { describe, expect, it } from "vitest";
import {
  formatMetricLabel,
  formatPrimaryMetric,
  metricHelpText,
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

  it("explains regression metrics with split prefixes", () => {
    expect(metricHelpText("val_rmse")).toMatch(/검증 데이터/);
    expect(metricHelpText("val_rmse")).toMatch(/낮을수록/);
    expect(metricHelpText("test_mae")).toMatch(/테스트 데이터/);
    expect(metricHelpText("test_mae")).toMatch(/절댓값/);
    expect(metricHelpText("r2")).toMatch(/1에 가까울수록/);
    expect(metricHelpText("r2")).not.toMatch(/검증 데이터|테스트 데이터/);
    expect(metricHelpText("val_HTDND_AMNT__t_plus_1_rmse")).toMatch(/검증 데이터.*낮을수록/);
    expect(metricHelpText("val_HTDND_AMNT__t_plus_1_r2")).toMatch(/검증 데이터.*0보다 작을 수도/);
  });

  it("explains classification metrics and weighted variants", () => {
    expect(metricHelpText("accuracy")).toMatch(/정답인 비율/);
    expect(metricHelpText("accuracy")).toMatch(/높을수록/);
    expect(metricHelpText("precision")).toMatch(/양성이라고 예측/);
    expect(metricHelpText("recall")).toMatch(/실제 양성/);
    expect(metricHelpText("f1")).toMatch(/조화평균/);
    const weighted = metricHelpText("val_f1_weighted");
    expect(weighted).toMatch(/검증 데이터/);
    expect(weighted).toMatch(/조화평균/);
    expect(weighted).toMatch(/가중 평균/);
  });

  it("handles per-target metric keys without inventing unknown guidance", () => {
    const perTarget = metricHelpText("val_target_0_rmse");
    expect(perTarget).toMatch(/검증 데이터/);
    expect(perTarget).toMatch(/제곱 오차/);
    expect(metricHelpText("custom_mystery_score")).toMatch(/기록된 평가 지표/);
    expect(metricHelpText("custom_mystery_score")).not.toMatch(/높을수록|낮을수록/);
    expect(metricHelpText("")).toMatch(/기록된 평가 지표/);
  });
});
