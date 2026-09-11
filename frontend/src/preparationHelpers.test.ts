import { describe, expect, it } from "vitest";
import type { DatasetPreparationGraph } from "./api";
import {
  apiGraphToFlow,
  defaultConfigForPreparation,
  emptyPreparationGraph,
  flowToApiGraph,
  formatKeyList,
  nextPreparationNodeId,
  parseKeyList,
  portToTargetHandle,
  preparationConfigSummary,
  PREPARATION_FLOW_NODE_TYPE,
  PREPARATION_NODE_TYPES,
  staggerPreparationPosition,
  targetHandleToPort,
} from "./preparationHelpers";

describe("preparationHelpers", () => {
  it("maps React Flow targetHandle to API target_port and back", () => {
    expect(targetHandleToPort("left")).toBe("left");
    expect(targetHandleToPort("right")).toBe("right");
    expect(targetHandleToPort("other")).toBeNull();
    expect(targetHandleToPort(null)).toBeNull();
    expect(portToTargetHandle("left")).toBe("left");
    expect(portToTargetHandle("right")).toBe("right");
    expect(portToTargetHandle(null)).toBeUndefined();
  });

  it("provides default configs per node type", () => {
    expect(defaultConfigForPreparation("source")).toEqual({
      dataset_id: null,
      version_strategy: "latest",
    });
    expect(defaultConfigForPreparation("join")).toEqual({
      how: "inner",
      left_on: [],
      right_on: [],
    });
    expect(defaultConfigForPreparation("union")).toEqual({ mode: "strict" });
    expect(defaultConfigForPreparation("output")).toEqual({});
  });

  it("allocates unique node ids", () => {
    expect(nextPreparationNodeId("source", ["source-1"])).toBe("source-2");
    expect(nextPreparationNodeId("join", ["join-9", "source-1"])).toBe("join-10");
    expect(nextPreparationNodeId("output", [])).toBe("output-1");
  });

  it("staggers default positions", () => {
    expect(staggerPreparationPosition(0)).toEqual({ x: 80, y: 80 });
    expect(staggerPreparationPosition(3)).toEqual({ x: 80, y: 240 });
  });

  it("converts API graph to flow nodes/edges using positions and target_port", () => {
    const graph: DatasetPreparationGraph = {
      schema_version: 1,
      nodes: [
        {
          id: "source-1",
          type: "source",
          config: { dataset_id: 3, version_strategy: "latest" },
          position: { x: 12, y: 34 },
        },
        {
          id: "join-1",
          type: "join",
          config: { how: "left", left_on: ["id"], right_on: ["id"] },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "source-1",
          target: "join-1",
          target_port: "left",
        },
      ],
    };
    const { nodes, edges } = apiGraphToFlow(graph);
    expect(nodes[0]).toMatchObject({
      id: "source-1",
      type: PREPARATION_FLOW_NODE_TYPE,
      position: { x: 12, y: 34 },
      data: { node_type: "source", label: "Source" },
    });
    expect(nodes[1].position).toEqual(staggerPreparationPosition(1));
    expect(edges[0]).toMatchObject({
      id: "e1",
      source: "source-1",
      target: "join-1",
      targetHandle: "left",
    });
    expect(JSON.stringify(edges[0])).not.toContain("target_port");
  });

  it("serializes flow graph to API graph with positions and without targetHandle", () => {
    const graph = flowToApiGraph(
      [
        {
          id: "source-1",
          type: PREPARATION_FLOW_NODE_TYPE,
          position: { x: 100, y: 200 },
          data: {
            label: "Source",
            node_type: "source",
            config: { dataset_id: 7, version_strategy: "fixed", dataset_version_id: 11 },
          },
        },
        {
          id: "join-1",
          type: PREPARATION_FLOW_NODE_TYPE,
          position: { x: 320, y: 200 },
          data: {
            label: "Join",
            node_type: "join",
            config: { how: "inner", left_on: ["a"], right_on: ["b"] },
          },
        },
      ],
      [
        {
          id: "e1",
          source: "source-1",
          target: "join-1",
          targetHandle: "left",
        },
      ],
    );
    expect(graph.schema_version).toBe(1);
    expect(graph.nodes[0].position).toEqual({ x: 100, y: 200 });
    expect(graph.edges[0]).toEqual({
      id: "e1",
      source: "source-1",
      target: "join-1",
      target_port: "left",
    });
    expect(JSON.stringify(graph)).not.toContain("targetHandle");
  });

  it("round-trips an empty graph", () => {
    const empty = emptyPreparationGraph();
    expect(empty).toEqual({ schema_version: 1, nodes: [], edges: [] });
    const flow = apiGraphToFlow(empty);
    expect(flowToApiGraph(flow.nodes, flow.edges)).toEqual(empty);
  });

  it("summarizes configs and parses key lists", () => {
    expect(
      preparationConfigSummary("source", { dataset_id: 2, version_strategy: "latest" }),
    ).toContain("Latest version");
    expect(
      preparationConfigSummary("join", {
        how: "full",
        left_on: ["id"],
        right_on: ["uid"],
      }),
    ).toEqual(["full", "id = uid"]);
    expect(preparationConfigSummary("union", { mode: "align_by_name" })).toContain(
      "Align by name",
    );
    expect(parseKeyList("a, b\nc")).toEqual(["a", "b", "c"]);
    expect(formatKeyList(["x", "y"])).toBe("x, y");
    expect(PREPARATION_NODE_TYPES).toEqual(["source", "join", "union", "output"]);
  });
});
