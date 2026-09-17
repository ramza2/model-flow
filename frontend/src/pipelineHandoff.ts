import type { PipelineGraph } from "./api";

export type PipelineDatasetHandoff = {
  datasetId: number;
  datasetVersionId: number;
};

export type PipelineCreateHandoffState = {
  requested: boolean;
  handoff: PipelineDatasetHandoff | null;
  error: string | null;
};

function parsePositiveInteger(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePipelineCreateHandoff(
  searchParams: Pick<URLSearchParams, "has" | "get">,
): PipelineCreateHandoffState {
  const requested =
    searchParams.has("datasetId") ||
    searchParams.has("datasetVersionId") ||
    searchParams.get("from") === "preparation";

  if (!requested) return { requested: false, handoff: null, error: null };

  const datasetId = parsePositiveInteger(searchParams.get("datasetId"));
  const datasetVersionId = parsePositiveInteger(searchParams.get("datasetVersionId"));
  if (datasetId == null || datasetVersionId == null) {
    return {
      requested: true,
      handoff: null,
      error:
        "Dataset handoff is invalid. Reopen the exact materialized result from Dataset Preparation or Dataset Detail.",
    };
  }

  return {
    requested: true,
    handoff: { datasetId, datasetVersionId },
    error: null,
  };
}

export function buildPipelineGraphForDatasetHandoff(
  handoff: PipelineDatasetHandoff,
): PipelineGraph {
  return {
    nodes: [
      {
        id: "dataset_load-1",
        type: "pipelineStep",
        position: { x: 80, y: 80 },
        data: {
          label: "Dataset Load",
          node_type: "dataset_load",
          config: {
            dataset_id: handoff.datasetId,
            dataset_version_id: handoff.datasetVersionId,
          },
        },
      },
    ],
    edges: [],
  };
}

export function pipelineCreateUrlForDataset(
  projectId: string | number | undefined,
  datasetId: number,
  datasetVersionId: number,
  source: "preparation" | "dataset" = "preparation",
): string {
  const query = new URLSearchParams({
    create: "1",
    datasetId: String(datasetId),
    datasetVersionId: String(datasetVersionId),
    from: source,
  });
  return `/projects/${projectId}/pipelines?${query.toString()}`;
}
