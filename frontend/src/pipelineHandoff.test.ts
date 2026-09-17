import { describe, expect, it } from "vitest";
import {
  buildPipelineGraphForDatasetHandoff,
  parsePipelineCreateHandoff,
  pipelineCreateUrlForDataset,
} from "./pipelineHandoff";

describe("pipeline dataset handoff", () => {
  it("parses one exact dataset and DatasetVersion pair", () => {
    const params = new URLSearchParams(
      "datasetId=17&datasetVersionId=42&from=preparation",
    );
    expect(parsePipelineCreateHandoff(params)).toEqual({
      requested: true,
      handoff: { datasetId: 17, datasetVersionId: 42 },
      error: null,
    });
  });

  it("rejects malformed or incomplete explicit handoffs instead of falling back", () => {
    expect(
      parsePipelineCreateHandoff(
        new URLSearchParams("datasetId=17&datasetVersionId=abc&from=preparation"),
      ),
    ).toMatchObject({ requested: true, handoff: null });
    expect(
      parsePipelineCreateHandoff(new URLSearchParams("datasetId=17&from=dataset")),
    ).toMatchObject({ requested: true, handoff: null });
    expect(
      parsePipelineCreateHandoff(new URLSearchParams("datasetId=0&datasetVersionId=2")),
    ).toMatchObject({ requested: true, handoff: null });
  });

  it("builds a Pipeline graph with one exact pinned Dataset Load node", () => {
    expect(
      buildPipelineGraphForDatasetHandoff({ datasetId: 17, datasetVersionId: 42 }),
    ).toEqual({
      nodes: [
        {
          id: "dataset_load-1",
          type: "pipelineStep",
          position: { x: 80, y: 80 },
          data: {
            label: "Dataset Load",
            node_type: "dataset_load",
            config: { dataset_id: 17, dataset_version_id: 42 },
          },
        },
      ],
      edges: [],
    });
  });

  it("creates lifecycle navigation URLs without replacing the historical version", () => {
    const url = pipelineCreateUrlForDataset(7, 17, 42, "preparation");
    expect(url).toBe(
      "/projects/7/pipelines/from-dataset?datasetId=17&datasetVersionId=42&from=preparation",
    );
  });
});
