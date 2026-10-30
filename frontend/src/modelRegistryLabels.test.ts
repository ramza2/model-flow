import { describe, expect, it } from "vitest";
import {
  formatModelMetricLabelKo,
  formatModelPrimaryMetricKo,
  modelMetricDisplayKo,
  modelLifecycleLabelKo,
  modelProblemTypeKo,
  parseModelForecastTargetKo,
} from "./modelRegistryLabels";

describe("Korean Model Registry display-only labels", () => {
  it("preserves raw model states while rendering all lifecycle labels", () => {
    expect(modelLifecycleLabelKo("PENDING_APPROVAL")).toBe("승인 대기");
    expect(modelLifecycleLabelKo("REJECTED")).toBe("반려됨");
    expect(modelLifecycleLabelKo("PRODUCTION")).toBe("운영 중");
    expect(modelProblemTypeKo("regression")).toBe("회귀(수치 예측)");
  });

  it("formats aggregate, per-target, and forecasting metric labels without changing keys", () => {
    expect(formatModelMetricLabelKo("val_rmse")).toBe("검증 · RMSE");
    expect(formatModelMetricLabelKo("test_target_1_mae", ["cooling_load", "power_usage"]))
      .toBe("테스트 · power_usage · MAE");
    expect(formatModelMetricLabelKo("val_HTDND_AMNT__t_plus_1_r2"))
      .toBe("검증 · HTDND_AMNT (1단계 후) · R²");
    expect(formatModelPrimaryMetricKo({ val_rmse: 22.185 }, { problemType: "regression" }))
      .toBe("검증 · RMSE: 22.185");
    expect(modelMetricDisplayKo("val_HTDND_AMNT__t_plus_1_r2")).toEqual({
      scope: "검증",
      target: "HTDND_AMNT (1단계 후)",
      metric: "R²",
      forecast: { step: 1, targetName: "HTDND_AMNT" },
    });
    expect(modelMetricDisplayKo("test_target_1_mae", ["cooling_load", "power_usage"])).toEqual({
      scope: "테스트",
      target: "power_usage",
      metric: "MAE",
    });
  });

  it("recognizes forecast horizons from real indexed target metric keys", () => {
    const targets = ["HTDND_AMNT__t_plus_1", "HTDND_AMNT__t_plus_2", "HTDND_AMNT__t_plus_3"];
    expect(modelMetricDisplayKo("val_target_0_rmse", targets)).toEqual({
      scope: "검증", target: "HTDND_AMNT (1단계 후)", metric: "RMSE",
      forecast: { step: 1, targetName: "HTDND_AMNT" },
    });
    expect(modelMetricDisplayKo("val_target_1_mae", targets).forecast)
      .toEqual({ step: 2, targetName: "HTDND_AMNT" });
    expect(formatModelMetricLabelKo("test_target_2_r2", targets))
      .toBe("테스트 · HTDND_AMNT (3단계 후) · R²");
    expect(modelMetricDisplayKo("val_target_0_rmse").forecast).toBeUndefined();
  });

  it("preserves non-forecasting multi-output target names", () => {
    expect(parseModelForecastTargetKo("power_usage")).toBeUndefined();
    expect(parseModelForecastTargetKo("HTDND_AMNT__t_plus_0")).toBeUndefined();
    expect(parseModelForecastTargetKo("HTDND_AMNT__t_plus_1"))
      .toEqual({ step: 1, targetName: "HTDND_AMNT" });
    expect(modelMetricDisplayKo("val_target_0_rmse", ["power_usage"]))
      .toEqual({ scope: "검증", target: "power_usage", metric: "RMSE" });
  });
});
