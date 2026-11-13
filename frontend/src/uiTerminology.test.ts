import { describe, expect, it } from "vitest";
import { algorithmDescriptionKo, algorithmLabelKo, operationalStatusLabel, projectRoleLabel, UI_HELP } from "./uiTerminology";

describe("beginner training copy", () => {
  it("provides Korean-first labels and algorithm-specific guidance without changing ids", () => {
    expect(algorithmLabelKo("random_forest", "Random forest"))
      .toBe("랜덤 포레스트 분류 (Random forest)");
    expect(algorithmLabelKo("ridge", "Ridge regression"))
      .toBe("릿지 회귀 (Ridge regression)");
    expect(algorithmDescriptionKo("random_forest")).toMatch(/결정 트리/);
    expect(algorithmDescriptionKo("ridge")).toMatch(/선형 관계/);
  });

  it("falls back to original server catalog display text for an unknown algorithm", () => {
    expect(algorithmLabelKo("future_algorithm", "Future algorithm"))
      .toBe("Future algorithm");
    expect(algorithmDescriptionKo("future_algorithm")).toBe(UI_HELP.algorithm);
  });

  it("localizes project roles and statuses without changing persisted identifiers", () => {
    expect(projectRoleLabel("PROJECT_ADMIN")).toBe("프로젝트 관리자");
    expect(projectRoleLabel("VIEWER")).toBe("조회자");
    expect(operationalStatusLabel("PRODUCTION")).toBe("운영 중");
    expect(operationalStatusLabel("succeeded")).toBe("성공");
    expect(projectRoleLabel("NEW_ROLE")).toBe("NEW ROLE");
  });

  it("explains what the seed does without claiming time-order shuffling", () => {
    expect(UI_HELP.randomSeed).toMatch(/결과를 재현/);
    expect(UI_HELP.randomSeed).toMatch(/시간 순서 분할은 데이터 순서를 섞지 않습니다/);
  });
});
