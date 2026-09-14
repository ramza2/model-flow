import { describe, expect, it } from "vitest";
import type { DatasetPreparationGraph } from "./api";
import {
  apiGraphToFlow,
  coerceDerivedLiteral,
  coerceFilterValue,
  defaultConfigForPreparation,
  emptyPreparationGraph,
  flowToApiGraph,
  formatDerivedLiteralInput,
  formatFilterValueInput,
  formatKeyList,
  formatRenameMapping,
  inferDerivedLiteralType,
  inferFilterValueType,
  isPreparationRunActive,
  isPreparationTransformType,
  nextPreparationNodeId,
  parseCasts,
  parseDerivedOperand,
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
  serializeGroupByConfig,
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
      right: { kind: "literal", value_type: "number", value: 0 },
    });
    expect(defaultConfigForPreparation("group_by")).toEqual({
      group_by: [],
      aggregations: [],
    });
  });

  it("exposes transform types in library groups and flat list", () => {
    expect(PREPARATION_NODE_TYPES).toContain("select");
    expect(PREPARATION_NODE_TYPES).toContain("derived_column");
    expect(PREPARATION_NODE_TYPES).toContain("group_by");
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
      "group_by",
    ]);
    expect(isPreparationTransformType("select")).toBe(true);
    expect(isPreparationTransformType("group_by")).toBe(true);
    expect(isPreparationTransformType("join")).toBe(false);
  });

  it("parses and formats rename mappings", () => {
    expect(parseRenameMapping("a = b\nold: new\n\nbad")).toEqual({
      a: "b",
      old: "new",
    });
    expect(formatRenameMapping({ a: "b", c: "d" })).toBe("a = b\nc = d");
  });

  it("serializes typed filter values for number, string, boolean, and in", () => {
    expect(
      serializeFilterConditions(
        [
          { column: "age", operator: "gte", value_type: "number", value: "18" },
          { column: "id", operator: "in", value_type: "number", value: "1, 2" },
          { column: "code", operator: "eq", value_type: "string", value: "001" },
          { column: "active", operator: "eq", value_type: "boolean", value: "true" },
        ],
        "and",
      ),
    ).toEqual({
      combine: "and",
      conditions: [
        { column: "age", operator: "gte", value_type: "number", value: 18 },
        { column: "id", operator: "in", value_type: "number", value: [1, 2] },
        { column: "code", operator: "eq", value_type: "string", value: "001" },
        { column: "active", operator: "eq", value_type: "boolean", value: true },
      ],
      errors: [],
    });
  });

  it("rejects invalid filter numbers without coercing to 0", () => {
    const result = serializeFilterConditions(
      [{ column: "age", operator: "gte", value_type: "number", value: "abc" }],
      "and",
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.conditions[0].value).toBe("abc");
    expect(result.conditions[0].value).not.toBe(0);
  });

  it("infers value_type from existing graphs without metadata", () => {
    expect(inferFilterValueType(18)).toBe("number");
    expect(inferFilterValueType(true)).toBe("boolean");
    expect(inferFilterValueType("001")).toBe("string");
    expect(inferFilterValueType([1, 2])).toBe("number");
    expect(
      parseFilterConditions([{ column: "age", operator: "gte", value: 18 }])[0]
        .value_type,
    ).toBe("number");
  });

  it("serializes cast and fill helpers without silent zero", () => {
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
        { column: "c", kind: "string", value: "001" },
        { column: "d", kind: "number", value: "-3" },
      ]),
    ).toEqual({
      values: { a: 2.5, b: true, c: "001", d: -3 },
      errors: [],
    });
    const invalid = serializeFillValues([
      { column: "amount", kind: "number", value: "abc" },
    ]);
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(invalid.values).toEqual({});
    expect(Object.values(invalid.values)).not.toContain(0);
  });

  it("coerces derived literals without collapsing numeric-looking strings", () => {
    expect(inferDerivedLiteralType("001")).toBe("string");
    expect(inferDerivedLiteralType(5)).toBe("number");
    expect(inferDerivedLiteralType(true)).toBe("boolean");
    expect(formatDerivedLiteralInput("001")).toBe("001");
    expect(coerceDerivedLiteral("001", "string")).toEqual({ ok: true, value: "001" });
    expect(coerceDerivedLiteral("5", "number")).toEqual({ ok: true, value: 5 });
    expect(coerceDerivedLiteral("true", "boolean")).toEqual({ ok: true, value: true });
    expect(coerceDerivedLiteral("abc", "number").ok).toBe(false);
    expect(
      parseDerivedOperand(
        { kind: "literal", value: "001" },
        { kind: "literal", value: 0 },
      ),
    ).toEqual({ kind: "literal", value: "001", value_type: "string" });
    expect(
      parseDerivedOperand(
        { kind: "literal", value: 5 },
        { kind: "literal", value: 0 },
      ),
    ).toEqual({ kind: "literal", value: 5, value_type: "number" });
  });

  it("serializes filter conditions including in and nullary ops", () => {
    expect(parseFilterConditions([{ column: "x", operator: "eq", value: 1 }])).toEqual([
      { column: "x", operator: "eq", value: 1, value_type: "number" },
    ]);
    expect(
      serializeFilterConditions(
        [
          { column: "a", operator: "is_null" },
          { column: "b", operator: "in", value_type: "string", value: "x, y" },
          { column: "c", operator: "eq", value_type: "string", value: "z" },
        ],
        "or",
      ),
    ).toEqual({
      combine: "or",
      conditions: [
        { column: "a", operator: "is_null" },
        { column: "b", operator: "in", value_type: "string", value: ["x", "y"] },
        { column: "c", operator: "eq", value_type: "string", value: "z" },
      ],
      errors: [],
    });
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
      "group_by",
      "output",
    ]);
    expect(
      preparationConfigSummary("group_by", {
        group_by: ["region", "category"],
        aggregations: [{}, {}, {}],
      }),
    ).toEqual(["By region, category", "3 aggregations"]);
    expect(preparationConfigSummary("group_by", { group_by: [], aggregations: [] })).toEqual([
      "No group keys",
      "No aggregations",
    ]);
    expect(
      serializeGroupByConfig({
        groupKeys: ["region", "region"],
        aggregations: [{ column: "sales", op: "SUM", output: "sales_sum" }],
      }).errors,
    ).toContain("Group keys must be unique.");
    expect(
      serializeGroupByConfig({
        groupKeys: ["region"],
        aggregations: [
          { column: "sales", op: "sum", output: "x" },
          { column: "sales", op: "avg", output: "x" },
        ],
      }).errors,
    ).toContain("Aggregation outputs must be unique.");
    expect(
      serializeGroupByConfig({
        groupKeys: ["region"],
        aggregations: [{ column: "sales", op: "sum", output: "region" }],
      }).errors,
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("collides with a group key")]),
    );
    expect(
      serializeGroupByConfig({
        groupKeys: ["region"],
        aggregations: [{ column: "sales", op: "AVG", output: "sales_avg" }],
      }),
    ).toEqual({
      group_by: ["region"],
      aggregations: [{ column: "sales", op: "avg", output: "sales_avg" }],
      errors: [],
    });
    expect(
      sourceDatasetIdsInGraph([
        { data: { node_type: "source", config: { dataset_id: 2 } } },
        { data: { node_type: "source", config: { dataset_id: 3 } } },
        { data: { node_type: "select", config: { columns: [] } } },
      ]),
    ).toEqual(new Set([2, 3]));
  });
});
