import { describe, expect, it } from "vitest";
import {
  buildHomeNextActions,
  buildMonitoringAttention,
  cronPresetLabel,
  factualSignalLines,
  targetTypeLabel,
} from "./operationsHelpers";

describe("operationsHelpers", () => {
  it("builds attention-first home next actions", () => {
    const actions = buildHomeNextActions(7, {
      datasets: 2,
      jobs: 3,
      running: 1,
      failed: 2,
      endpoints: 1,
      unreadAlerts: 1,
    });
    expect(actions[0]?.id).toBe("failed-jobs");
    expect(actions[1]?.id).toBe("alerts");
    expect(actions.every((action) => action.to.startsWith("/projects/7"))).toBe(true);
  });

  it("uses factual overview signal wording", () => {
    const lines = factualSignalLines({
      datasetCount: 2,
      failedQualityChecks: 0,
      latestQualityStatus: "passed",
      jobCount: 4,
      activeJobs: 1,
      failedJobs: 0,
      modelVersionCount: 3,
      productionModels: 1,
      lifecycleCounts: { PRODUCTION: 1 },
      endpointCount: 1,
      readyEndpoints: 1,
      openAlerts: 2,
    });
    expect(lines).toContain("No failed quality checks");
    expect(lines).toContain("1 active training job");
    expect(lines).toContain("1 production model");
    expect(lines).toContain("1 / 1 deployments ready");
    expect(lines).toContain("2 open alerts");
    expect(lines.some((line) => /healthy/i.test(line))).toBe(false);
  });

  it("labels schedule frequency and target types", () => {
    expect(cronPresetLabel("0 9 * * *")).toMatch(/Daily/i);
    expect(targetTypeLabel("pipeline_run")).toBe("Pipeline run");
  });

  it("builds monitoring attention from factual metrics only", () => {
    const items = buildMonitoringAttention({
      projectId: "7",
      serviceErrors: 3,
      failedQualityChecks: 1,
      readyEndpoints: 0,
      endpointCount: 1,
      driftStatus: "failed",
    });
    expect(items.map((item) => item.id)).toEqual([
      "service-errors",
      "quality",
      "ready",
      "drift",
    ]);
    expect(items.every((item) => item.to?.startsWith("/projects/7/"))).toBe(true);
  });
});
