import { describe, expect, it } from "vitest";
import {
  hasActiveBatchJobs,
  isActiveBatchJobStatus,
  isTerminalBatchJobStatus,
} from "./batchInferencePolling";

describe("batchInferencePolling", () => {
  it("treats pending, queued, running, and cancel_requested as active", () => {
    expect(isActiveBatchJobStatus("pending")).toBe(true);
    expect(isActiveBatchJobStatus("queued")).toBe(true);
    expect(isActiveBatchJobStatus("running")).toBe(true);
    expect(isActiveBatchJobStatus("cancel_requested")).toBe(true);
  });

  it("treats succeeded, failed, and cancelled as terminal", () => {
    expect(isTerminalBatchJobStatus("succeeded")).toBe(true);
    expect(isTerminalBatchJobStatus("failed")).toBe(true);
    expect(isTerminalBatchJobStatus("cancelled")).toBe(true);
    expect(isActiveBatchJobStatus("succeeded")).toBe(false);
  });

  it("detects active jobs in a mixed history", () => {
    expect(
      hasActiveBatchJobs([
        { status: "succeeded" },
        { status: "running" },
      ]),
    ).toBe(true);
    expect(
      hasActiveBatchJobs([
        { status: "succeeded" },
        { status: "failed" },
      ]),
    ).toBe(false);
  });
});
