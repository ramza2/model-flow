import { describe, expect, it } from "vitest";
import {
  formatModelMetricLabelKo,
  formatModelPrimaryMetricKo,
  modelMetricDisplayKo,
  modelLifecycleLabelKo,
  modelProblemTypeKo,
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
});
