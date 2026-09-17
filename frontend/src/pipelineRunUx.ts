import type { PipelineRun, PipelineVersion } from "./api";
import type { LineageItem } from "./lifecycleHelpers";
import {
  PIPELINE_LIFECYCLE_STAGES,
  lifecycleStageForNodeType,
  type PipelineLifecycleStageId,
} from "./pipelineHelpers";

export type PipelineRunDisplayStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "reused"
  | "cancelled"
  | "unknown";

export type PipelineRunNodeView = {
  id: string;
  label: string;
  nodeType: string;
  stageId: PipelineLifecycleStageId | null;
  stageLabel: string | null;
  rawStatus: string;
  status: PipelineRunDisplayStatus;
  attempt: number;
  error?: string;
  reason?: string;
};

export type PipelineRunStageSummary = {
  id: PipelineLifecycleStageId;
  label: string;
  status: PipelineRunDisplayStatus;
  total: number;
  counts: Record<PipelineRunDisplayStatus, number>;
};

export type PipelineRunProgressSummary = {
  total: number;
  terminal: number;
  percent: number;
  counts: Record<PipelineRunDisplayStatus, number>;
};

const STATUS_ORDER: PipelineRunDisplayStatus[] = [
  "failed",
  "running",
  "pending",
  "succeeded",
  "reused",
  "skipped",
  "cancelled",
  "unknown",
];

const TERMINAL_STATUSES = new Set<PipelineRunDisplayStatus>([
  "succeeded",
  "failed",
  "skipped",
  "reused",
  "cancelled",
]);

function emptyCounts(): Record<PipelineRunDisplayStatus, number> {
  return {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    reused: 0,
    cancelled: 0,
    unknown: 0,
  };
}

function positiveAttempt(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function normalizePipelineRunStatus(value: unknown): PipelineRunDisplayStatus {
  const raw = String(value || "unknown").trim().toLowerCase();
  if (["created", "queued", "waiting", "pending"].includes(raw)) return "pending";
  if (["running", "in_progress"].includes(raw)) return "running";
  if (["success", "succeeded", "completed", "complete"].includes(raw)) return "succeeded";
  if (["failure", "failed", "error"].includes(raw)) return "failed";
  if (["skip", "skipped"].includes(raw)) return "skipped";
  if (raw === "reused") return "reused";
  if (["cancelled", "canceled"].includes(raw)) return "cancelled";
  return "unknown";
}

function graphNodeType(node: PipelineVersion["graph"]["nodes"][number] | undefined): string {
  const data = (node?.data || {}) as Record<string, unknown>;
  return String(data.node_type || data.nodeType || data.type || node?.type || "unknown");
}

function graphNodeLabel(node: PipelineVersion["graph"]["nodes"][number] | undefined): string {
  const data = (node?.data || {}) as Record<string, unknown>;
  return String(data.label || node?.id || "Step");
}

export function pipelineRunNodeViews(
  run: PipelineRun,
  version?: PipelineVersion | null,
): PipelineRunNodeView[] {
  const graphNodes = version?.graph?.nodes || [];
  const graphById = new Map(graphNodes.map((node) => [node.id, node]));
  const graphIds = graphNodes.map((node) => node.id);
  const stateIds = Object.keys(run.node_states || {});
  const ids = [...graphIds, ...stateIds.filter((id) => !graphById.has(id))];
  const maxAttempt = Math.max(
    1,
    ...Object.values(run.node_states || {}).map((state) => positiveAttempt(state.attempt)),
  );

  return ids.map((id) => {
    const state = run.node_states?.[id];
    const graphNode = graphById.get(id);
    const nodeType = state?.node_type || graphNodeType(graphNode);
    const stage = lifecycleStageForNodeType(nodeType);
    const rawStatus = String(state?.status || "pending");
    const normalized = normalizePipelineRunStatus(rawStatus);
    const attempt = positiveAttempt(state?.attempt);
    const status =
      normalized === "succeeded" && maxAttempt > attempt ? "reused" : normalized;
    return {
      id,
      label: state?.label || graphNodeLabel(graphNode),
      nodeType,
      stageId: stage?.id || null,
      stageLabel: stage?.label || null,
      rawStatus,
      status,
      attempt,
      error: state?.error,
      reason: state?.reason,
    };
  });
}

function aggregateStatus(nodes: PipelineRunNodeView[]): PipelineRunDisplayStatus {
  if (nodes.length === 0) return "unknown";
  const present = new Set(nodes.map((node) => node.status));
  if (present.has("failed")) return "failed";
  if (present.has("running")) return "running";
  if (present.has("pending")) return "pending";
  if (nodes.every((node) => node.status === "reused")) return "reused";
  if (nodes.every((node) => node.status === "skipped")) return "skipped";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  if (present.has("succeeded") || present.has("reused")) return "succeeded";
  if (present.has("skipped")) return "skipped";
  if (present.has("cancelled")) return "cancelled";
  return STATUS_ORDER.find((status) => present.has(status)) || "unknown";
}

export function summarizePipelineRunStages(
  run: PipelineRun,
  version?: PipelineVersion | null,
): PipelineRunStageSummary[] {
  const nodes = pipelineRunNodeViews(run, version);
  return PIPELINE_LIFECYCLE_STAGES.map((stage) => {
    const stageNodes = nodes.filter((node) => node.stageId === stage.id);
    const counts = emptyCounts();
    for (const node of stageNodes) counts[node.status] += 1;
    return {
      id: stage.id,
      label: stage.label,
      status: aggregateStatus(stageNodes),
      total: stageNodes.length,
      counts,
    };
  }).filter((stage) => stage.total > 0);
}

export function summarizePipelineRunProgress(
  run: PipelineRun,
  version?: PipelineVersion | null,
): PipelineRunProgressSummary {
  const nodes = pipelineRunNodeViews(run, version);
  const counts = emptyCounts();
  for (const node of nodes) counts[node.status] += 1;
  const terminal = nodes.filter((node) => TERMINAL_STATUSES.has(node.status)).length;
  return {
    total: nodes.length,
    terminal,
    percent: nodes.length === 0 ? 0 : Math.round((terminal / nodes.length) * 100),
    counts,
  };
}

export function firstFailedPipelineNode(
  run: PipelineRun,
  version?: PipelineVersion | null,
): PipelineRunNodeView | null {
  return pipelineRunNodeViews(run, version).find((node) => node.status === "failed") || null;
}

function deepFind(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined && record[key] !== null) return record[key];
  for (const nested of Object.values(record)) {
    const found = deepFind(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function pipelineRunLineageItems(
  run: PipelineRun,
  version: PipelineVersion | null | undefined,
  projectId: string | number,
): LineageItem[] {
  const outputBag = [
    ...Object.values(run.node_states || {}).map((state) => state.output),
    ...Object.values(run.node_artifacts || {}),
  ];
  const datasetNode = version?.graph?.nodes.find((node) => graphNodeType(node) === "dataset_load");
  const datasetConfig = ((datasetNode?.data || {}) as Record<string, unknown>).config;
  const config = datasetConfig && typeof datasetConfig === "object"
    ? (datasetConfig as Record<string, unknown>)
    : {};

  const datasetId =
    positiveId(config.dataset_id) || positiveId(deepFind(outputBag, "dataset_id"));
  const datasetVersionId =
    positiveId(config.dataset_version_id) || positiveId(deepFind(outputBag, "dataset_version_id"));
  const trainingJobId = positiveId(deepFind(outputBag, "training_job_id"));
  const mlflowRunId = stringValue(deepFind(outputBag, "mlflow_run_id"));
  const modelVersionId = positiveId(deepFind(outputBag, "model_version_id"));
  const endpointId = positiveId(deepFind(outputBag, "endpoint_id"));
  const batchJobId = positiveId(deepFind(outputBag, "batch_job_id"));
  const alertId = positiveId(deepFind(outputBag, "alert_id"));

  const items: LineageItem[] = [
    {
      label: "Pipeline",
      value: `Pipeline #${run.pipeline_id}`,
      to: `/projects/${projectId}/pipelines/${run.pipeline_id}`,
    },
  ];
  if (datasetId) {
    items.push({
      label: "Dataset version",
      value: datasetVersionId
        ? `Dataset #${datasetId} · Version #${datasetVersionId}`
        : `Dataset #${datasetId}`,
      to: `/projects/${projectId}/datasets/${datasetId}`,
    });
  }
  if (trainingJobId) {
    items.push({
      label: "Training job",
      value: `Job #${trainingJobId}`,
      to: `/projects/${projectId}/jobs/${trainingJobId}`,
    });
  }
  if (mlflowRunId) {
    items.push({
      label: "Experiment run",
      value: mlflowRunId,
      to: `/projects/${projectId}/experiments/runs/${mlflowRunId}`,
      mono: true,
    });
  }
  if (modelVersionId) {
    items.push({
      label: "Model version",
      value: `Model version #${modelVersionId}`,
      to: `/projects/${projectId}/models/${modelVersionId}`,
    });
  }
  if (endpointId) {
    items.push({
      label: "Deployment",
      value: `Endpoint #${endpointId}`,
      to: `/projects/${projectId}/deployments`,
    });
  }
  if (batchJobId) {
    items.push({
      label: "Batch inference",
      value: `Job #${batchJobId}`,
      to: `/projects/${projectId}/deployments/batch`,
    });
  }
  if (alertId) {
    items.push({
      label: "Alert",
      value: `Alert #${alertId}`,
      to: `/projects/${projectId}/alerts`,
    });
  }
  return items;
}
