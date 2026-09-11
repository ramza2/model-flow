import { describe, expect, it } from "vitest";
import type { DatasetPreparationGraph } from "./api";
import {
  apiGraphToFlow,
  defaultConfigForPreparation,
  emptyPreparationGraph,
  flowToApiGraph,
  formatKeyList,
  formatRenameMapping,
  isPreparationRunActive,
  isPreparationTransformType,
  nextPreparationNodeId,
  parseCasts,
  parseFillValues,
  parseFilterConditions,
  parseKeyList,
  parseRenameMapping,
  portToTargetHandle,
  preparationConfigSummary,
  PREPARATION_FLOW_NODE_TYPE,
  PREPARATION_NODE_LIBRARY,
  PREPARATION_NODE_LIBRARY_GROUPS,
  PREPARATION_NODE_TYPES,
  serializeCasts,
  serializeFillValues,
  serializeFilterConditions,
  sourceDatasetIdsInGraph,
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

  it("provides default configs per node type including transforms", () => {
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
    expect(defaultConfigForPreparation("select")).toEqual({ columns: [] });
    expect(defaultConfigForPreparation("drop")).toEqual({ columns: [] });
    expect(defaultConfigForPreparation("rename")).toEqual({ mapping: {} });
    expect(defaultConfigForPreparation("filter")).toEqual({
      combine: "and",
      conditions: [],
    });
    expect(defaultConfigForPreparation("cast")).toEqual({ casts: {} });
    expect(defaultConfigForPreparation("deduplicate")).toEqual({
      columns: [],
      keep: "first",
    });
    expect(defaultConfigForPreparation("fill_constant")).toEqual({ values: {} });
    expect(defaultConfigForPreparation("derived_column")).toEqual({
      name: "",
      operation: "add",
      left: { kind: "column", value: "" },
      right: { kind: "literal", value: 0 },
    });
  });

  it("exposes transform types in library groups and flat list", () => {
    expect(PREPARATION_NODE_TYPES).toContain("select");
    expect(PREPARATION_NODE_TYPES).toContain("derived_column");
    expect(PREPARATION_NODE_LIBRARY.map((item) => item.type)).toContain("filter");
    const transformGroup = PREPARATION_NODE_LIBRARY_GROUPS.find(
      (group) => group.id === "transform",
    );
    expect(transformGroup?.items.map((item) => item.type)).toEqual([
      "select",
      "drop",
      "rename",
      "filter",
      "cast",
      "deduplicate",
      "fill_constant",
      "derived_column",
    ]);
    expect(isPreparationTransformType("select")).toBe(true);
    expect(isPreparationTransformType("join")).toBe(false);
  });

  it("parses and formats rename mappings", () => {
    expect(parseRenameMapping("a = b\nold: new\n\nbad")).toEqual({
      a: "b",
      old: "new",
    });
    expect(formatRenameMapping({ a: "b", c: "d" })).toBe("a = b\nc = d");
  });

  it("serializes filter conditions including in and nullary ops", () => {
    expect(parseFilterConditions([{ column: "x", operator: "eq", value: 1 }])).toEqual([
      { column: "x", operator: "eq", value: 1 },
    ]);
    expect(
      serializeFilterConditions(
        [
          { column: "a", operator: "is_null" },
          { column: "b", operator: "in", value: "x, y" },
          { column: "c", operator: "eq", value: "z" },
        ],
        "or",
      ),
    ).toEqual({
      combine: "or",
      conditions: [
        { column: "a", operator: "is_null" },
        { column: "b", operator: "in", value: ["x", "y"] },
        { column: "c", operator: "eq", value: "z" },
      ],
    });
  });

  it("serializes cast and fill helpers", () => {
    expect(parseCasts({ age: "integer", name: "string" })).toEqual([
      { column: "age", dtype: "integer" },
      { column: "name", dtype: "string" },
    ]);
    expect(serializeCasts([{ column: "age", dtype: "float" }])).toEqual({ age: "float" });
    expect(parseFillValues({ a: 1, b: true, c: "x" })).toEqual([
      { column: "a", kind: "number", value: "1" },
      { column: "b", kind: "boolean", value: "true" },
      { column: "c", kind: "string", value: "x" },
    ]);
    expect(
      serializeFillValues([
        { column: "a", kind: "number", value: "2.5" },
        { column: "b", kind: "boolean", value: "true" },
        { column: "c", kind: "string", value: "hi" },
      ]),
    ).toEqual({ a: 2.5, b: true, c: "hi" });
  });

  it("detects active preparation run statuses", () => {
    expect(isPreparationRunActive("queued")).toBe(true);
    expect(isPreparationRunActive("running")).toBe(true);
    expect(isPreparationRunActive("created")).toBe(false);
    expect(isPreparationRunActive("succeeded")).toBe(false);
  });

  it("allocates unique node ids", () => {
    expect(nextPreparationNodeId("source", ["source-1"])).toBe("source-2");
    expect(nextPreparationNodeId("join", ["join-9", "source-1"])).toBe("join-10");
    expect(nextPreparationNodeId("output", [])).toBe("output-1");
    expect(nextPreparationNodeId("select", ["select-1"])).toBe("select-2");
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
        {
          id: "select-1",
          type: "select",
          config: { columns: ["id"] },
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
    expect(nodes[2].data.node_type).toBe("select");
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

  it("round-trips an empty graph and keeps old 4-node compatibility", () => {
    const empty = emptyPreparationGraph();
    expect(empty).toEqual({ schema_version: 1, nodes: [], edges: [] });
    const flow = apiGraphToFlow(empty);
    expect(flowToApiGraph(flow.nodes, flow.edges)).toEqual(empty);

    const legacy: DatasetPreparationGraph = {
      schema_version: 1,
      nodes: [
        { id: "source-1", type: "source", config: { dataset_id: 1, version_strategy: "latest" } },
        { id: "join-1", type: "join", config: { how: "inner", left_on: ["id"], right_on: ["id"] } },
        { id: "union-1", type: "union", config: { mode: "strict" } },
        { id: "output-1", type: "output", config: {} },
      ],
      edges: [],
    };
    const roundTrip = flowToApiGraph(
      apiGraphToFlow(legacy).nodes,
      apiGraphToFlow(legacy).edges,
    );
    expect(roundTrip.nodes.map((node) => node.type)).toEqual([
      "source",
      "join",
      "union",
      "output",
    ]);
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
    expect(preparationConfigSummary("select", { columns: ["a", "b"] })).toContain("a, b");
    expect(preparationConfigSummary("filter", { combine: "and", conditions: [{}] })).toEqual([
      "AND",
      "1 condition",
    ]);
    expect(parseKeyList("a, b\nc")).toEqual(["a", "b", "c"]);
    expect(formatKeyList(["x", "y"])).toBe("x, y");
    expect(PREPARATION_NODE_TYPES).toEqual([
      "source",
      "join",
      "union",
      "select",
      "drop",
      "rename",
      "filter",
      "cast",
      "deduplicate",
      "fill_constant",
      "derived_column",
      "output",
    ]);
    expect(
      sourceDatasetIdsInGraph([
        { data: { node_type: "source", config: { dataset_id: 2 } } },
        { data: { node_type: "source", config: { dataset_id: 3 } } },
        { data: { node_type: "select", config: { columns: [] } } },
      ]),
    ).toEqual(new Set([2, 3]));
  });
});
