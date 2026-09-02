import { describe, expect, it } from "vitest";
import { defaultModelNameFromJob } from "./registerModelHelpers";

describe("defaultModelNameFromJob", () => {
  it("normalizes job names into model names", () => {
    expect(defaultModelNameFromJob({ name: "Ridge Multi Output" })).toBe("ridge_multi_output");
    expect(defaultModelNameFromJob({ name: "   " })).toBe("model");
  });
});
