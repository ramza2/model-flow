import type { PipelineGraph, PipelineRun } from "./api";
import {
  PIPELINE_LIFECYCLE_STAGES,
  lifecycleStageForNodeType,
  type PipelineLifecycleStageId,
} from "./pipelineHelpers";

export type UnifiedRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "reused"
  | "cancelled"
  | "unknown";

export type LifecycleStageSummary = {
  id: PipelineLifecycleStageId;
  label: string;
  total: number;
  terminal: number;
  status: UnifiedRunStatus;
  counts: Record<UnifiedRunStatus, number>;
  nodeIds: string[];
};

export type PipelineRunSummary = {
  total: number;
  terminal: number;
  progressPercent: number;
  statusCounts: Record<UnifiedRunStatus, number>;
  stages: LifecycleStageSummary[];
  failedNodeIds: string[];
  runningNodeIds: string[];
};

export type PipelineLineageRef = {
  kind:
    | "dataset_version"
    | "training_job"
    | "experiment_run"
    | "model_version"
    | "deployment"
    | "batch_inference"
    | "alert";
  label: string;
  id: string;
  datasetId?: number;
  to?: string;
};

const UNIFIED_STATUSES: UnifiedRunStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "reused",
  "cancelled",
  "unknown",
];

const TERMINAL = new Set<UnifiedRunStatus>([
  "succeeded",
  "failed",
  "skipped",
  "reused",
  "cancelled",
]);

function emptyCounts(): Record<UnifiedRunStatus, number> {
  return Object.fromEntries(UNIFIED_STATUSES.map((status) => [status, 0])) as Record<
    UnifiedRunStatus,
    number
  >;
}

export function normalizePipelineRunStatus(status: string | null | undefined): UnifiedRunStatus {
  const value = String(status || "").trim().toLowerCase();
  if (["created", "queued", "pending", "not_started"].includes(value)) return "pending";
  if (["running", "in_progress"].includes(value)) return "running";
  if (["succeeded", "success", "completed", "passed"].includes(value)) return "succeeded";
  if (["failed", "error"].includes(value)) return "failed";
  if (value === "skipped") return "skipped";
  if (["reused", "cached"].includes(value)) return "reused";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  return "unknown";
}

function stageStatus(counts: Record<UnifiedRunStatus, number>, total: number): UnifiedRunStatus {
  if (total === 0) return "pending";
  if (counts.failed > 0) return "failed";
  if (counts.running > 0) return "running";
  if (counts.pending > 0 || counts.unknown > 0) return "pending";
  if (counts.cancelled > 0) return "cancelled";
  if (counts.reused === total) return "reused";
  if (counts.skipped === total) return "skipped";
  return "succeeded";
}

function graphNodeType(node: PipelineGraph["nodes"][number]): string {
  const data = node.data || {};
  return String(data.node_type || "");
}

export function summarizePipelineRunLifecycle(
  graph: PipelineGraph | null | undefined,
  nodeStates: PipelineRun["node_states"] | null | undefined,
): PipelineRunSummary {
  const states = nodeStates || {};
  const graphNodes = graph?.nodes || [];
  const orderedIds = graphNodes.length > 0 ? graphNodes.map((node) => node.id) : Object.keys(states);
  const typeById = new Map(
    graphNodes.map((node) => [node.id, graphNodeType(node)]),
  );
  for (const [nodeId, state] of Object.entries(states)) {
    if (!typeById.has(nodeId) && state.node_type) typeById.set(nodeId, state.node_type);
  }

  const overallCounts = emptyCounts();
  const failedNodeIds: string[] = [];
  const runningNodeIds: string[] = [];
  let terminal = 0;
  for (const nodeId of orderedIds) {
    const status = normalizePipelineRunStatus(states[nodeId]?.status);
    overallCounts[status] += 1;
    if (TERMINAL.has(status)) terminal += 1;
    if (status === "failed") failedNodeIds.push(nodeId);
    if (status === "running") runningNodeIds.push(nodeId);
  }

  const stages = PIPELINE_LIFECYCLE_STAGES.map((stage) => {
    const nodeIds = orderedIds.filter((nodeId) => lifecycleStageForNodeType(typeById.get(nodeId) || "")?.id === stage.id);
    const counts = emptyCounts();
    let stageTerminal = 0;
    for (const nodeId of nodeIds) {
      const status = normalizePipelineRunStatus(states[nodeId]?.status);
      counts[status] += 1;
      if (TERMINAL.has(status)) stageTerminal += 1;
    }
    return {
      id: stage.id,
      label: stage.label,
      total: nodeIds.length,
      terminal: stageTerminal,
      status: stageStatus(counts, nodeIds.length),
      counts,
      nodeIds,
    } satisfies LifecycleStageSummary;
  });

  const total = orderedIds.length;
  return {
    total,
    terminal,
    progressPercent: total === 0 ? 0 : Math.round((terminal / total) * 100),
    statusCounts: overallCounts,
    stages,
    failedNodeIds,
    runningNodeIds,
  };
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectObjects(value: unknown, output: Record<string, unknown>[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  output.push(record);
  Object.values(record).forEach((item) => collectObjects(item, output));
}

export function collectPipelineLineage(
  projectId: string | number,
  graph: PipelineGraph | null | undefined,
  run: Pick<PipelineRun, "node_artifacts" | "node_states"> | null | undefined,
): PipelineLineageRef[] {
  const refs: PipelineLineageRef[] = [];
  const seen = new Set<string>();
  const add = (ref: PipelineLineageRef) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const node of graph?.nodes || []) {
    const config = (node.data?.config || {}) as Record<string, unknown>;
    const datasetId = positiveInteger(config.dataset_id);
    const datasetVersionId = positiveInteger(config.dataset_version_id);
    if (datasetVersionId) {
      add({
        kind: "dataset_version",
        id: String(datasetVersionId),
        label: `DatasetVersion #${datasetVersionId}`,
        datasetId: datasetId || undefined,
        to: datasetId ? `/projects/${projectId}/datasets/${datasetId}` : undefined,
      });
    }
  }

  const objects: Record<string, unknown>[] = [];
  collectObjects(run?.node_artifacts, objects);
  for (const state of Object.values(run?.node_states || {})) collectObjects(state.output, objects);

  for (const record of objects) {
    const datasetId = positiveInteger(record.dataset_id);
    const datasetVersionId = positiveInteger(record.dataset_version_id);
    if (datasetVersionId) {
      add({
        kind: "dataset_version",
        id: String(datasetVersionId),
        label: `DatasetVersion #${datasetVersionId}`,
        datasetId: datasetId || undefined,
        to: datasetId ? `/projects/${projectId}/datasets/${datasetId}` : undefined,
      });
    }

    const trainingJobId = positiveInteger(record.training_job_id);
    if (trainingJobId) {
      add({
        kind: "training_job",
        id: String(trainingJobId),
        label: `Training Job #${trainingJobId}`,
        to: `/projects/${projectId}/jobs/${trainingJobId}`,
      });
    }

    const mlflowRunId = typeof record.mlflow_run_id === "string" ? record.mlflow_run_id : null;
    if (mlflowRunId) {
      add({
        kind: "experiment_run",
        id: mlflowRunId,
        label: `Experiment ${mlflowRunId.slice(0, 10)}${mlflowRunId.length > 10 ? "…" : ""}`,
        to: `/projects/${projectId}/experiments/runs/${mlflowRunId}`,
      });
    }

    const markerModelId =
      record.__modelflow_artifact__ === "model_version" ? positiveInteger(record.id) : null;
    const modelVersionId = markerModelId || positiveInteger(record.model_version_id);
    if (modelVersionId) {
      add({
        kind: "model_version",
        id: String(modelVersionId),
        label: `Model Version #${modelVersionId}`,
        to: `/projects/${projectId}/models/${modelVersionId}`,
      });
    }

    const endpointId = positiveInteger(record.endpoint_id);
    if (endpointId) {
      add({
        kind: "deployment",
        id: String(endpointId),
        label: `Deployment #${endpointId}`,
        to: `/projects/${projectId}/deployments/${endpointId}/predict`,
      });
    }

    const batchJobId = positiveInteger(record.batch_job_id);
    if (batchJobId) {
      add({
        kind: "batch_inference",
        id: String(batchJobId),
        label: `Batch Inference #${batchJobId}`,
        to: `/projects/${projectId}/deployments/batch`,
      });
    }

    const alertId = positiveInteger(record.alert_id);
    if (alertId) {
      add({
        kind: "alert",
        id: String(alertId),
        label: `Alert #${alertId}`,
        to: `/projects/${projectId}/alerts`,
      });
    }
  }

  return refs;
}
