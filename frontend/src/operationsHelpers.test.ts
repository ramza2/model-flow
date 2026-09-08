import { describe, expect, it } from "vitest";
import {
  buildHomeNextActions,
  buildMonitoringAttention,
  countAttentionAlerts,
  cronPresetLabel,
  factualSignalLines,
  targetTypeLabel,
} from "./operationsHelpers";

describe("operationsHelpers", () => {
  it("builds attention-first home next actions for warning/error alerts", () => {
    const actions = buildHomeNextActions(7, {
      datasets: 2,
      jobs: 3,
      running: 1,
      failed: 2,
      endpoints: 1,
      unreadAlerts: 5,
      attentionAlerts: 1,
    });
    expect(actions[0]?.id).toBe("failed-jobs");
    expect(actions[1]?.id).toBe("alerts");
    expect(actions.every((action) => action.to.startsWith("/projects/7"))).toBe(true);
  });

  it("does not add alert attention actions for info-only unread alerts", () => {
    const actions = buildHomeNextActions(7, {
      datasets: 2,
      jobs: 3,
      running: 0,
      failed: 0,
      endpoints: 1,
      unreadAlerts: 17,
      attentionAlerts: 0,
    });
    expect(actions.some((action) => action.id === "alerts")).toBe(false);
    expect(actions[0]?.id).toBe("overview");
  });

  it("keeps failed-job attention when only info alerts are unread", () => {
    const actions = buildHomeNextActions(7, {
      datasets: 2,
      jobs: 3,
      running: 0,
      failed: 1,
      endpoints: 1,
      unreadAlerts: 17,
      attentionAlerts: 0,
    });
    expect(actions[0]?.id).toBe("failed-jobs");
    expect(actions.some((action) => action.id === "alerts")).toBe(false);
  });

  it("counts attention alerts from warning/error/critical only", () => {
    expect(
      countAttentionAlerts([
        { severity: "info" },
        { severity: "info" },
        { severity: "warning" },
        { severity: "error" },
        { severity: "critical" },
      ]),
    ).toBe(3);
    expect(countAttentionAlerts([{ severity: "info" }, { severity: "info" }])).toBe(0);
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
