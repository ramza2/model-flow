import type { Job } from "./api";

export type HomeStats = {
  datasets: number;
  jobs: number;
  running: number;
  failed: number;
  endpoints: number;
  unreadAlerts: number;
};

export type NextAction = {
  id: string;
  title: string;
  description: string;
  to: string;
  attention?: boolean;
};

const ACTIVE_JOB_STATUSES = new Set(["pending", "queued", "running", "dispatched"]);

export function countActiveJobs(jobs: Job[]): number {
  return jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;
}

export function countFailedJobs(jobs: Job[]): number {
  return jobs.filter((job) => job.status === "failed").length;
}

export function cronPresetLabel(expression: string): string {
  if (expression === "0 * * * *") return "Every hour";
  if (expression === "0 9 * * *") return "Daily at 09:00";
  if (expression === "0 9 * * 1-5") return "Weekdays at 09:00";
  if (/^0 9 \* \* 1$/.test(expression)) return "Weekly (Monday 09:00)";
  return "Custom cron";
}

export function targetTypeLabel(targetType: string): string {
  if (targetType === "data_import") return "Data import";
  if (targetType === "batch_inference") return "Batch prediction";
  if (targetType === "pipeline_run") return "Pipeline run";
  return targetType.replaceAll("_", " ");
}

export function buildHomeNextActions(
  projectId: number,
  stats: HomeStats,
): NextAction[] {
  const actions: NextAction[] = [];
  if (stats.failed > 0) {
    actions.push({
      id: "failed-jobs",
      title: "Investigate failed training jobs",
      description: `${stats.failed} failed job${stats.failed === 1 ? "" : "s"} need attention.`,
      to: `/projects/${projectId}/jobs`,
      attention: true,
    });
  }
  if (stats.unreadAlerts > 0) {
    actions.push({
      id: "alerts",
      title: "Review unread alerts",
      description: `${stats.unreadAlerts} open unread alert${stats.unreadAlerts === 1 ? "" : "s"}.`,
      to: `/projects/${projectId}/alerts`,
      attention: true,
    });
  }
  if (stats.datasets === 0) {
    actions.push({
      id: "add-dataset",
      title: "Add a dataset",
      description: "Upload CSV, JSON, or Parquet to start training.",
      to: `/projects/${projectId}/datasets`,
    });
  } else if (stats.jobs === 0) {
    actions.push({
      id: "train",
      title: "Train a model",
      description: "Choose data, target, and algorithm.",
      to: `/projects/${projectId}/jobs/new`,
    });
  } else if (stats.endpoints === 0) {
    actions.push({
      id: "registry",
      title: "Register or deploy a model",
      description: "Move from experiment results to serving.",
      to: `/projects/${projectId}/registry`,
    });
  }
  if (actions.length < 3) {
    actions.push({
      id: "overview",
      title: "Open project overview",
      description: "See data, build, models, serving, and alerts together.",
      to: `/projects/${projectId}`,
    });
  }
  if (actions.length < 3) {
    actions.push({
      id: "monitoring",
      title: "Review operations",
      description: "Check service, data, and model health signals.",
      to: `/projects/${projectId}/monitoring`,
    });
  }
  return actions.slice(0, 3);
}

export type OverviewSignals = {
  datasetCount: number;
  failedQualityChecks: number;
  latestQualityStatus: string | null;
  jobCount: number;
  activeJobs: number;
  failedJobs: number;
  modelVersionCount: number;
  productionModels: number;
  lifecycleCounts: Record<string, number>;
  endpointCount: number;
  readyEndpoints: number;
  openAlerts: number;
};

export function factualSignalLines(signals: OverviewSignals): string[] {
  const lines: string[] = [];
  if (signals.failedQualityChecks > 0) {
    lines.push(`${signals.failedQualityChecks} failed quality check${signals.failedQualityChecks === 1 ? "" : "s"}`);
  } else if (signals.datasetCount > 0) {
    lines.push("No failed quality checks");
  }
  if (signals.activeJobs > 0) {
    lines.push(`${signals.activeJobs} active training job${signals.activeJobs === 1 ? "" : "s"}`);
  }
  if (signals.failedJobs > 0) {
    lines.push(`${signals.failedJobs} failed training job${signals.failedJobs === 1 ? "" : "s"}`);
  }
  lines.push(
    `${signals.productionModels} production model${signals.productionModels === 1 ? "" : "s"}`,
  );
  if (signals.endpointCount > 0) {
    lines.push(`${signals.readyEndpoints} / ${signals.endpointCount} deployments ready`);
  } else {
    lines.push("0 deployments");
  }
  lines.push(`${signals.openAlerts} open alert${signals.openAlerts === 1 ? "" : "s"}`);
  return lines;
}

export type MonitoringAttentionItem = {
  id: string;
  label: string;
  to?: string;
};

export function buildMonitoringAttention(input: {
  projectId: string;
  serviceErrors: number;
  failedQualityChecks: number;
  readyEndpoints: number;
  endpointCount: number;
  driftStatus: string | null;
  openAlertHint?: boolean;
}): MonitoringAttentionItem[] {
  const items: MonitoringAttentionItem[] = [];
  if (input.serviceErrors > 0) {
    items.push({
      id: "service-errors",
      label: `${input.serviceErrors} prediction error${input.serviceErrors === 1 ? "" : "s"} in the selected window`,
      to: `/projects/${input.projectId}/deployments`,
    });
  }
  if (input.failedQualityChecks > 0) {
    items.push({
      id: "quality",
      label: `${input.failedQualityChecks} failed quality check${input.failedQualityChecks === 1 ? "" : "s"}`,
      to: `/projects/${input.projectId}/datasets`,
    });
  }
  if (input.endpointCount > 0 && input.readyEndpoints < input.endpointCount) {
    items.push({
      id: "ready",
      label: `${input.readyEndpoints} / ${input.endpointCount} deployments ready`,
      to: `/projects/${input.projectId}/deployments`,
    });
  }
  if (input.driftStatus && /fail|alert|drift/i.test(input.driftStatus)) {
    items.push({
      id: "drift",
      label: `Latest drift status: ${input.driftStatus.replaceAll("_", " ")}`,
      to: `/projects/${input.projectId}/alerts`,
    });
  }
  return items;
}
