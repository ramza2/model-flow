import { describe, expect, it } from "vitest";
import {
  hasActiveScheduleRuns,
  isActiveScheduleRunStatus,
  isTerminalScheduleRunStatus,
} from "./scheduleHistoryPolling";

describe("scheduleHistoryPolling", () => {
  it("detects active and terminal schedule run statuses", () => {
    expect(isActiveScheduleRunStatus("pending")).toBe(true);
    expect(isActiveScheduleRunStatus("dispatched")).toBe(true);
    expect(isActiveScheduleRunStatus("running")).toBe(true);
    expect(isTerminalScheduleRunStatus("succeeded")).toBe(true);
    expect(isTerminalScheduleRunStatus("failed")).toBe(true);
    expect(isTerminalScheduleRunStatus("skipped")).toBe(true);
    expect(isTerminalScheduleRunStatus("cancelled")).toBe(true);
  });

  it("reports active runs in a mixed history list", () => {
    expect(
      hasActiveScheduleRuns([
        { status: "succeeded" },
        { status: "pending" },
      ]),
    ).toBe(true);
    expect(
      hasActiveScheduleRuns([
        { status: "succeeded" },
        { status: "failed" },
      ]),
    ).toBe(false);
  });
});
