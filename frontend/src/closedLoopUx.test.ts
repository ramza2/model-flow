import { describe, expect, it } from "vitest";
import {
  closedLoopNextActionDisplayLabel,
  closedLoopReasonDisplayLabel,
  closedLoopStateDisplayLabel,
  triggerDecisionLabel,
} from "./closedLoopUx";

describe("closed-loop Korean display copy", () => {
  it("renders the production healthy explanation in Korean", () => {
    expect(closedLoopStateDisplayLabel("Healthy")).toBe("정상");
    expect(closedLoopNextActionDisplayLabel("No closed-loop action required.")).toBe(
      "현재 추가 조치가 필요하지 않습니다.",
    );
    expect(triggerDecisionLabel("quality_status_ok")).toBe("품질이 정상 범위이므로 재학습 불필요");
  });

  it("translates known reasons while keeping unknown backend diagnostic copy intact", () => {
    expect(closedLoopReasonDisplayLabel("critical_degradation", "Critical quality degradation triggered retraining"))
      .toBe("심각한 품질 저하로 재학습이 시작되었습니다");
    expect(closedLoopReasonDisplayLabel("custom_validation_error", "Backend diagnostic: invalid column"))
      .toBe("Backend diagnostic: invalid column");
  });

  it("preserves unknown state and next-action messages", () => {
    expect(closedLoopStateDisplayLabel("Future state")).toBe("Future state");
    expect(closedLoopNextActionDisplayLabel("Contact the administrator: error #7"))
      .toBe("Contact the administrator: error #7");
  });
});
