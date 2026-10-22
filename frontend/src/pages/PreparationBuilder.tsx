import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Link, useBeforeUnload, useParams } from "react-router-dom";
import {
  api,
  type Dataset,
  type DatasetPreparation,
  type DatasetPreparationNodeType,
  type DatasetPreparationOutputDatasetResult,
  type DatasetPreparationPreviewResult,
  type DatasetPreparationRun,
  type DatasetPreparationValidationResult,
  type DatasetPreparationVersion,
  type DatasetVersion,
} from "../api";
import { useAuth } from "../AuthContext";
import { centerFlowOnMiniMapNode, centerFlowOnMiniMapPoint } from "../flowMiniMapNav";
import {
  ErrorNotice,
  HelpTip,
  Loading,
  StatusBadge,
  SuccessNotice,
  TermLabel,
  formatDate,
} from "../components";
import {
  UI_HELP,
  castDtypeHelp,
  castDtypeLabel,
  derivedOperationLabel,
  filterCombineHint,
  filterCombineLabel,
  filterOperatorHelp,
  filterOperatorLabel,
  filterValueTypeLabel,
} from "../uiTerminology";
import {
  CAST_TYPES,
  DERIVED_OPERATIONS,
  FILTER_NULLARY_OPS,
  FILTER_OPERATORS,
  GROUP_BY_OPS,
  PREPARATION_FLOW_NODE_TYPE,
  PREPARATION_NODE_LIBRARY_GROUPS,
  ROLLING_AGGREGATIONS,
  apiGraphToFlow,
  defaultConfigForPreparation,
  flowToApiGraph,
  formatFilterValueInput,
  formatKeyList,
  formatRenameMapping,
  inferFilterValueType,
  isPreparationRunActive,
  labelForPreparationType,
  nextPreparationNodeId,
  parseCasts,
  parseDerivedOperand,
  parseFillValues,
  parseFilterConditions,
  parseGroupByAggregations,
  parseKeyList,
  parseLagDrafts,
  parseRenameMapping,
  parseRollingWindowDrafts,
  preparationConfigSummary,
  serializeCasts,
  serializeFillValues,
  serializeFilterConditions,
  serializeGroupByConfig,
  serializeLagConfig,
  serializeUnpivotConfig,
  serializePivotConfig,
  serializeRollingWindowConfig,
  coerceDerivedLiteral,
  formatDerivedLiteralInput,
  inferDerivedLiteralType,
  sourceDatasetIdsInGraph,
  staggerPreparationPosition,
  type DerivedOperand,
  type FillValueRow,
  type FilterCondition,
  type FilterValueType,
  type GroupByAggregationRow,
  type LagDraftRow,
  type PivotValueDraft,
  type PivotValueType,
  type PreparationFlowEdge,
  type PreparationFlowNode,
  type RollingWindowDraftRow,
} from "../preparationHelpers";
import {
  capturePrepGraphSnapshot,
  createEmptyPrepGraphHistory,
  isEditableKeyboardTarget,
  prepGraphSnapshotsEqual,
  pushPrepGraphHistory,
  redoPrepGraphHistory,
  undoPrepGraphHistory,
  type PrepGraphHistoryState,
  type PrepGraphSnapshot,
} from "../preparationGraphHistory";
import { userCanProject, useProject } from "../ProjectContext";

type PrepNodeData = {
  label: string;
  node_type: DatasetPreparationNodeType;
  config: Record<string, unknown>;
};

type PrepNode = Node<PrepNodeData>;

function PreparationStepNodeComponent({ data, selected }: NodeProps<PrepNode>) {
  const summary = preparationConfigSummary(data.node_type, data.config || {});
  const isJoin = data.node_type === "join";
  const isSource = data.node_type === "source";
  const isOutput = data.node_type === "output";
  return (
    <div
      className={[
        "preparation-step-node",
        selected ? "is-selected" : "",
        `type-${data.node_type}`,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="preparation-step-node"
      data-node-type={data.node_type}
    >
      {!isSource && !isJoin && <Handle type="target" position={Position.Left} />}
      {isJoin && (
        <>
          <Handle
            type="target"
            id="left"
            position={Position.Left}
            style={{ top: "30%" }}
            className="preparation-join-handle"
          />
          <span className="preparation-join-handle-label" style={{ top: "22%" }}>
            LEFT
          </span>
          <Handle
            type="target"
            id="right"
            position={Position.Left}
            style={{ top: "70%" }}
            className="preparation-join-handle"
          />
          <span className="preparation-join-handle-label" style={{ top: "62%" }}>
            RIGHT
          </span>
        </>
      )}
      <strong className="preparation-step-label">{data.label}</strong>
      <span className="preparation-step-type">{labelForPreparationType(data.node_type)}</span>
      {summary.map((line) => (
        <span key={line} className="preparation-step-summary">
          {line}
        </span>
      ))}
      {!isOutput && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = {
  [PREPARATION_FLOW_NODE_TYPE]: memo(PreparationStepNodeComponent),
};

function toPrepNodes(nodes: PreparationFlowNode[]): PrepNode[] {
  return nodes.map((node) => ({
    ...node,
    type: PREPARATION_FLOW_NODE_TYPE,
    data: {
      label: node.data.label,
      node_type: node.data.node_type,
      config: node.data.config || {},
    },
  }));
}

function toPrepEdges(edges: PreparationFlowEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle, label: edge.label } : {}),
  }));
}

function nodesFromGraphSnapshot(snapshot: PrepGraphSnapshot): PrepNode[] {
  return snapshot.nodes.map((node) => ({
    id: node.id,
    type: PREPARATION_FLOW_NODE_TYPE,
    position: { x: node.position.x, y: node.position.y },
    data: {
      label: node.data.label,
      node_type: node.data.node_type as DatasetPreparationNodeType,
      config: structuredClone(node.data.config || {}),
    },
  }));
}

function edgesFromGraphSnapshot(snapshot: PrepGraphSnapshot): Edge[] {
  return snapshot.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle, label: edge.label } : {}),
  }));
}

export default function PreparationBuilder() {
  const { projectId, preparationId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [preparation, setPreparation] = useState<DatasetPreparation | null>(null);
  const [nodes, setNodes] = useState<PrepNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [prepVersions, setPrepVersions] = useState<DatasetPreparationVersion[]>([]);
  const [runs, setRuns] = useState<DatasetPreparationRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [historyFlags, setHistoryFlags] = useState({ undo: false, redo: false });
  const [inspectorEpoch, setInspectorEpoch] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [successRun, setSuccessRun] = useState<DatasetPreparationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [newOutputName, setNewOutputName] = useState("");
  const [newOutputDescription, setNewOutputDescription] = useState("");
  const [validation, setValidation] = useState<DatasetPreparationValidationResult | null>(
    null,
  );
  const [validateRequestFailed, setValidateRequestFailed] = useState(false);
  const [preview, setPreview] = useState<DatasetPreparationPreviewResult | null>(null);
  const [inspectorErrors, setInspectorErrors] = useState<string[]>([]);
  const previewSeqRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const validateSeqRef = useRef(0);
  const pendingPreviewScrollRef = useRef(false);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);
  const validationPanelRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const historyRef = useRef<PrepGraphHistoryState>(createEmptyPrepGraphHistory());
  const savedSnapshotRef = useRef<PrepGraphSnapshot | null>(null);
  const nodesRef = useRef<PrepNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const dragBaselineRef = useRef<PrepGraphSnapshot | null>(null);
  const suppressEdgeHistoryRef = useRef(false);
  const flowInstanceRef = useRef<{
    setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
    getZoom: () => number;
  } | null>(null);
  const canWrite = userCanProject(
    user,
    selectedProject,
    "DATA_SCIENTIST",
    "ML_ENGINEER",
    "PROJECT_ADMIN",
  );

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [edges, nodes]);

  const clearPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewSeqRef.current += 1;
    pendingPreviewScrollRef.current = false;
    setPreview(null);
    // Graph edits abort in-flight preview; unlock actions even though the
    // aborted request's finally must not clear a newer preview's busy state.
    setBusy((prev) => (prev === "preview" ? "" : prev));
  }, []);

  const invalidateValidate = useCallback(() => {
    validateSeqRef.current += 1;
    setValidation(null);
    setValidateRequestFailed(false);
    // Unlock Validate busy when graph edits supersede an in-flight request;
    // the stale request's finally must not clear a newer busy state.
    setBusy((prev) => (prev === "validate" ? "" : prev));
  }, []);

  const invalidateGraphDerived = useCallback(() => {
    invalidateValidate();
    clearPreview();
  }, [clearPreview, invalidateValidate]);

  const syncDirtyFromSnapshot = useCallback((snapshot: PrepGraphSnapshot) => {
    setDirty(!prepGraphSnapshotsEqual(snapshot, savedSnapshotRef.current));
  }, []);

  const publishHistory = useCallback((next: PrepGraphHistoryState) => {
    historyRef.current = next;
    setHistoryFlags({
      undo: next.past.length > 0,
      redo: next.future.length > 0,
    });
  }, []);

  const resetGraphHistory = useCallback(() => {
    dragBaselineRef.current = null;
    publishHistory(createEmptyPrepGraphHistory());
  }, [publishHistory]);

  const commitGraphEdit = useCallback(
    (nextNodes: PrepNode[], nextEdges: Edge[], options?: { baseline?: PrepGraphSnapshot | null }) => {
      const currentSnapshot =
        options?.baseline ?? capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
      const nextSnapshot = capturePrepGraphSnapshot(nextNodes, nextEdges);
      if (prepGraphSnapshotsEqual(currentSnapshot, nextSnapshot)) {
        setNodes(nextNodes);
        setEdges(nextEdges);
        nodesRef.current = nextNodes;
        edgesRef.current = nextEdges;
        return false;
      }
      publishHistory(pushPrepGraphHistory(historyRef.current, currentSnapshot));
      setNodes(nextNodes);
      setEdges(nextEdges);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setSelectedEdgeId((edgeId) =>
        edgeId && nextEdges.some((edge) => edge.id === edgeId) ? edgeId : "",
      );
      setSelectedId((nodeId) =>
        nodeId && nextNodes.some((node) => node.id === nodeId) ? nodeId : "",
      );
      syncDirtyFromSnapshot(nextSnapshot);
      invalidateGraphDerived();
      return true;
    },
    [invalidateGraphDerived, publishHistory, syncDirtyFromSnapshot],
  );

  const applyGraphSnapshot = useCallback(
    (snapshot: PrepGraphSnapshot, options?: { bumpInspector?: boolean }) => {
      const nextNodes = nodesFromGraphSnapshot(snapshot);
      const nextEdges = edgesFromGraphSnapshot(snapshot);
      setNodes(nextNodes);
      setEdges(nextEdges);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setSelectedEdgeId((edgeId) =>
        edgeId && nextEdges.some((edge) => edge.id === edgeId) ? edgeId : "",
      );
      setSelectedId((nodeId) =>
        nodeId && nextNodes.some((node) => node.id === nodeId) ? nodeId : "",
      );
      syncDirtyFromSnapshot(snapshot);
      invalidateGraphDerived();
      if (options?.bumpInspector) {
        setInspectorEpoch((value) => value + 1);
      }
    },
    [invalidateGraphDerived, syncDirtyFromSnapshot],
  );

  const undoGraphEdit = useCallback(() => {
    if (!canWrite) return;
    const current = capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
    const result = undoPrepGraphHistory(historyRef.current, current);
    if (!result) return;
    dragBaselineRef.current = null;
    publishHistory(result.history);
    applyGraphSnapshot(result.snapshot, { bumpInspector: true });
  }, [applyGraphSnapshot, canWrite, publishHistory]);

  const redoGraphEdit = useCallback(() => {
    if (!canWrite) return;
    const current = capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
    const result = redoPrepGraphHistory(historyRef.current, current);
    if (!result) return;
    dragBaselineRef.current = null;
    publishHistory(result.history);
    applyGraphSnapshot(result.snapshot, { bumpInspector: true });
  }, [applyGraphSnapshot, canWrite, publishHistory]);

  const canUndo = canWrite && historyFlags.undo;
  const canRedo = canWrite && historyFlags.redo;

  const loadRuns = useCallback(async () => {
    if (!projectId || !preparationId) return [];
    const rows = await api<DatasetPreparationRun[]>(
      `/projects/${projectId}/dataset-preparations/${preparationId}/runs`,
    );
    setRuns(rows);
    return rows;
  }, [preparationId, projectId]);

  const load = useCallback(async () => {
    try {
      const [row, datasetRows, versionRows, runRows] = await Promise.all([
        api<DatasetPreparation>(
          `/projects/${projectId}/dataset-preparations/${preparationId}`,
        ),
        api<Dataset[]>(`/projects/${projectId}/datasets`).catch(() => [] as Dataset[]),
        api<DatasetPreparationVersion[]>(
          `/projects/${projectId}/dataset-preparations/${preparationId}/versions`,
        ).catch(() => [] as DatasetPreparationVersion[]),
        api<DatasetPreparationRun[]>(
          `/projects/${projectId}/dataset-preparations/${preparationId}/runs`,
        ).catch(() => [] as DatasetPreparationRun[]),
      ]);
      const graph = row.version?.graph || { schema_version: 1 as const, nodes: [], edges: [] };
      const flow = apiGraphToFlow(graph);
      const nextNodes = toPrepNodes(flow.nodes);
      const nextEdges = toPrepEdges(flow.edges);
      const baseline = capturePrepGraphSnapshot(nextNodes, nextEdges);
      setPreparation(row);
      setNodes(nextNodes);
      setEdges(nextEdges);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setDatasets(datasetRows);
      setPrepVersions(versionRows);
      setRuns(runRows);
      setSelectedId("");
      setSelectedEdgeId("");
      savedSnapshotRef.current = baseline;
      dragBaselineRef.current = null;
      publishHistory(createEmptyPrepGraphHistory());
      setInspectorEpoch((value) => value + 1);
      setDirty(false);
      validateSeqRef.current += 1;
      setValidation(null);
      setValidateRequestFailed(false);
      pendingPreviewScrollRef.current = false;
      setPreview(null);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "준비 작업을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [preparationId, projectId, publishHistory]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!preview || !pendingPreviewScrollRef.current) return;
    pendingPreviewScrollRef.current = false;
    const panel = previewPanelRef.current;
    if (!panel || typeof panel.scrollIntoView !== "function") return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [preview]);

  const successRunIdRef = useRef<number | null>(null);
  useEffect(() => {
    successRunIdRef.current = successRun?.id ?? null;
  }, [successRun?.id]);

  useEffect(() => {
    const hasActive = runs.some((run) => isPreparationRunActive(run.status));
    if (!hasActive) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void loadRuns().then(async (rows) => {
        const trackedId = successRunIdRef.current;
        const matched = trackedId != null ? rows.find((run) => run.id === trackedId) : undefined;
        if (matched) {
          setSuccessRun((prev) =>
            prev &&
            prev.id === matched.id &&
            prev.status === matched.status &&
            prev.output_dataset_version_id === matched.output_dataset_version_id
              ? prev
              : matched,
          );
        }
        if (matched && String(matched.status).toLowerCase() === "succeeded") {
          // A newly successful run becomes the primary result. Do not leave an
          // older failure traceback expanded above it.
          setExpandedRunId(null);
          try {
            const datasetRows = await api<Dataset[]>(`/projects/${projectId}/datasets`);
            setDatasets(datasetRows);
          } catch {
            /* ignore refresh failures during poll */
          }
        }
      });
    }, 2000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [loadRuns, projectId, runs]);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [dirty],
    ),
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) || null,
    [nodes, selectedId],
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) || null,
    [edges, selectedEdgeId],
  );
  const selectedEdgeSourceLabel = selectedEdge
    ? nodes.find((node) => node.id === selectedEdge.source)?.data.label || selectedEdge.source
    : "";
  const selectedEdgeTargetLabel = selectedEdge
    ? nodes.find((node) => node.id === selectedEdge.target)?.data.label || selectedEdge.target
    : "";

  useEffect(() => {
    setInspectorErrors([]);
  }, [selectedId]);

  const usedSourceDatasetIds = useMemo(() => sourceDatasetIdsInGraph(nodes), [nodes]);

  const versionNumberById = useMemo(() => {
    const map = new Map<number, number>();
    for (const version of prepVersions) map.set(version.id, version.version);
    if (preparation?.version) {
      map.set(preparation.version.id, preparation.version.version);
    }
    return map;
  }, [prepVersions, preparation]);

  const outputDataset = useMemo(() => {
    if (preparation?.output_dataset_id == null) return null;
    return datasets.find((dataset) => dataset.id === preparation.output_dataset_id) || null;
  }, [datasets, preparation]);

  const successOutputDataset = useMemo(() => {
    if (successRun?.output_dataset_id == null) return null;
    return datasets.find((dataset) => dataset.id === successRun.output_dataset_id) || null;
  }, [datasets, successRun]);

  const latestRunId = useMemo(
    () => runs.reduce((latest, run) => Math.max(latest, run.id), 0),
    [runs],
  );

  const sampledJoinPreviewEmpty = Boolean(
    preview?.sampled &&
      preview.row_count === 0 &&
      nodes.some((node) => node.data.node_type === "join"),
  );

  useEffect(() => {
    if (!selectedNode || selectedNode.data.node_type !== "source" || !projectId) {
      setVersions([]);
      return;
    }
    const datasetId = selectedNode.data.config.dataset_id;
    if (datasetId == null || datasetId === "") {
      setVersions([]);
      return;
    }
    let cancelled = false;
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${datasetId}/versions`)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedNode]);

  const currentGraph = useCallback(
    () =>
      flowToApiGraph(
        nodes.map((node) => ({
          id: node.id,
          type: PREPARATION_FLOW_NODE_TYPE,
          position: node.position,
          data: {
            label: node.data.label,
            node_type: node.data.node_type,
            config: node.data.config,
          },
        })),
        edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          targetHandle: edge.targetHandle,
          label: typeof edge.label === "string" ? edge.label : undefined,
        })),
      ),
    [edges, nodes],
  );

  function selectNode(node: PrepNode) {
    setSelectedId(node.id);
    setSelectedEdgeId("");
  }

  function updateSelectedConfig(next: Record<string, unknown>) {
    if (!canWrite || !selectedId) return;
    const nextNodes = nodesRef.current.map((node) =>
      node.id === selectedId ? { ...node, data: { ...node.data, config: next } } : node,
    );
    commitGraphEdit(nextNodes, edgesRef.current);
  }

  function addNodeOfType(nodeType: DatasetPreparationNodeType) {
    if (!canWrite) return;
    const currentNodes = nodesRef.current;
    const id = nextPreparationNodeId(
      nodeType,
      currentNodes.map((node) => node.id),
    );
    const node: PrepNode = {
      id,
      type: PREPARATION_FLOW_NODE_TYPE,
      position: staggerPreparationPosition(currentNodes.length),
      data: {
        label: labelForPreparationType(nodeType),
        node_type: nodeType,
        config: defaultConfigForPreparation(nodeType),
      },
    };
    commitGraphEdit([...currentNodes, node], edgesRef.current);
    setSelectedId(id);
    setSelectedEdgeId("");
  }

  function removeSelected() {
    if (!canWrite || !selectedId) return;
    const nextNodes = nodesRef.current.filter((node) => node.id !== selectedId);
    const nextEdges = edgesRef.current.filter(
      (edge) => edge.source !== selectedId && edge.target !== selectedId,
    );
    commitGraphEdit(nextNodes, nextEdges);
    setSelectedId("");
  }

  function removeSelectedEdge() {
    if (!canWrite || !selectedEdgeId) return;
    const nextEdges = edgesRef.current.filter((edge) => edge.id !== selectedEdgeId);
    commitGraphEdit(nodesRef.current, nextEdges);
    setSelectedEdgeId("");
  }

  const onNodesChange = useCallback(
    (changes: NodeChange<PrepNode>[]) => {
      if (!canWrite) {
        const safe = changes.filter(
          (change) => change.type === "select" || change.type === "dimensions",
        );
        if (safe.length) {
          const next = applyNodeChanges(safe, nodesRef.current);
          setNodes(next);
          nodesRef.current = next;
        }
        return;
      }

      for (const change of changes) {
        if (change.type === "position" && change.dragging === true && !dragBaselineRef.current) {
          dragBaselineRef.current = capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
        }
      }

      const removedIds = changes
        .filter((change) => change.type === "remove" && "id" in change && Boolean(change.id))
        .map((change) => String((change as { id: string }).id));
      const hasStructuralAdd = changes.some((change) => change.type === "add");
      const hasDragEnd = changes.some(
        (change) => change.type === "position" && change.dragging === false,
      );

      if (removedIds.length > 0 || hasStructuralAdd) {
        const baseline = capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
        const nextNodes = applyNodeChanges(changes, nodesRef.current);
        const removed = new Set(removedIds);
        const nextEdges = edgesRef.current.filter(
          (edge) => !removed.has(edge.source) && !removed.has(edge.target),
        );
        suppressEdgeHistoryRef.current = true;
        commitGraphEdit(nextNodes, nextEdges, { baseline });
        queueMicrotask(() => {
          suppressEdgeHistoryRef.current = false;
        });
        dragBaselineRef.current = null;
        return;
      }

      if (hasDragEnd) {
        const baseline = dragBaselineRef.current;
        dragBaselineRef.current = null;
        const nextNodes = applyNodeChanges(changes, nodesRef.current);
        commitGraphEdit(nextNodes, edgesRef.current, { baseline: baseline ?? undefined });
        return;
      }

      // Selection, dimensions, and in-progress drag updates stay out of history.
      const nextNodes = applyNodeChanges(changes, nodesRef.current);
      setNodes(nextNodes);
      nodesRef.current = nextNodes;
    },
    [canWrite, commitGraphEdit],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!canWrite) {
        const safe = changes.filter((change) => change.type === "select");
        if (safe.length) {
          const next = applyEdgeChanges(safe, edgesRef.current);
          setEdges(next);
          edgesRef.current = next;
        }
        return;
      }

      const structural = changes.some(
        (change) => change.type === "remove" || change.type === "add",
      );
      if (!structural || suppressEdgeHistoryRef.current) {
        const next = applyEdgeChanges(changes, edgesRef.current);
        setEdges(next);
        edgesRef.current = next;
        if (structural) {
          setSelectedEdgeId((edgeId) =>
            edgeId && next.some((edge) => edge.id === edgeId) ? edgeId : "",
          );
        }
        return;
      }

      const nextEdges = applyEdgeChanges(changes, edgesRef.current);
      commitGraphEdit(nodesRef.current, nextEdges);
    },
    [canWrite, commitGraphEdit],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!canWrite) return;
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const targetNode = currentNodes.find((node) => node.id === connection.target);
      let targetHandle = connection.targetHandle;
      if (targetNode?.data.node_type === "join") {
        if (targetHandle !== "left" && targetHandle !== "right") {
          const used = new Set(
            currentEdges
              .filter((edge) => edge.target === connection.target)
              .map((edge) => edge.targetHandle),
          );
          targetHandle = !used.has("left") ? "left" : "right";
        }
      } else {
        targetHandle = null;
      }
      const nextEdges = addEdge(
        {
          ...connection,
          targetHandle,
          ...(targetHandle
            ? { label: String(targetHandle).toUpperCase() }
            : { label: undefined }),
          id: `edge-${connection.source}-${connection.target}-${targetHandle || "in"}-${currentEdges.length + 1}`,
        },
        currentEdges,
      );
      commitGraphEdit(currentNodes, nextEdges);
    },
    [canWrite, commitGraphEdit],
  );

  useEffect(() => {
    if (!canWrite) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Match toolbar Undo/Redo: ignore shortcuts while any action is busy.
      if (busy !== "") return;
      if (isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoGraphEdit();
        return;
      }
      if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redoGraphEdit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, canWrite, redoGraphEdit, undoGraphEdit]);

  function guardInspectorErrors(): boolean {
    if (inspectorErrors.length === 0) return true;
    setError(inspectorErrors[0]);
    return false;
  }

  async function saveVersion() {
    if (!canWrite) return;
    if (!guardInspectorErrors()) return;
    setBusy("save");
    setError("");
    setSuccess("");
    // Freeze the exact graph sent to the API; later canvas edits must not rewrite it.
    const graph = currentGraph();
    const savedSnapshot = capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
    try {
      const version = await api<DatasetPreparationVersion>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/versions`,
        { method: "POST", body: JSON.stringify({ graph }) },
      );
      savedSnapshotRef.current = savedSnapshot;
      const liveSnapshot = capturePrepGraphSnapshot(nodesRef.current, edgesRef.current);
      // Allow editing during save. Only clear history when the canvas still matches
      // the saved snapshot; otherwise keep post-save-start edits undoable.
      if (prepGraphSnapshotsEqual(liveSnapshot, savedSnapshot)) {
        resetGraphHistory();
      } else {
        dragBaselineRef.current = null;
      }
      syncDirtyFromSnapshot(liveSnapshot);
      setSuccess("버전을 저장했습니다.");
      setPrepVersions((rows) => {
        const without = rows.filter((row) => row.id !== version.id);
        return [...without, version].sort((a, b) => b.version - a.version);
      });
      setPreparation((prev) =>
        prev
          ? {
              ...prev,
              latest_version: version.version ?? prev.latest_version + 1,
              version,
            }
          : prev,
      );
    } catch (reason) {
      // Keep edit history on save failure so the user can continue undoing.
      setError(reason instanceof Error ? reason.message : "버전을 저장하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function runValidate() {
    if (!guardInspectorErrors()) return;
    const seq = ++validateSeqRef.current;
    setBusy("validate");
    setError("");
    // Clear prior outcome so a previous pass is never shown as the new result.
    setValidation(null);
    setValidateRequestFailed(false);
    try {
      const result = await api<DatasetPreparationValidationResult>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/validate`,
        { method: "POST", body: JSON.stringify({ graph: currentGraph() }) },
      );
      if (seq !== validateSeqRef.current) return;
      setValidateRequestFailed(false);
      setValidation(result);
    } catch (reason) {
      if (seq !== validateSeqRef.current) return;
      setValidation(null);
      setValidateRequestFailed(true);
      setError(reason instanceof Error ? reason.message : "검증에 실패했습니다.");
    } finally {
      // Only the active validate request may clear validate busy.
      if (seq === validateSeqRef.current) {
        setBusy((prev) => (prev === "validate" ? "" : prev));
      }
    }
  }

  async function runPreview() {
    if (!guardInspectorErrors()) return;
    setBusy("preview");
    setError("");
    pendingPreviewScrollRef.current = false;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const seq = ++previewSeqRef.current;
    try {
      const result = await api<DatasetPreparationPreviewResult>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/preview`,
        {
          method: "POST",
          body: JSON.stringify({
            graph: currentGraph(),
            node_id: selectedId || null,
            limit: 20,
          }),
          signal: controller.signal,
        },
      );
      if (seq !== previewSeqRef.current || previewAbortRef.current !== controller) {
        return;
      }
      pendingPreviewScrollRef.current = true;
      setPreview(result);
    } catch (reason) {
      if (controller.signal.aborted || previewAbortRef.current !== controller) return;
      pendingPreviewScrollRef.current = false;
      setError(reason instanceof Error ? reason.message : "미리보기에 실패했습니다.");
      setPreview(null);
    } finally {
      // Only the active controller may clear preview busy — never a superseded request.
      if (previewAbortRef.current === controller) {
        previewAbortRef.current = null;
        setBusy((prev) => (prev === "preview" ? "" : prev));
      }
    }
  }

  async function selectOutputDataset(datasetId: number | null) {
    if (!canWrite || !preparation) return;
    setBusy("output");
    setError("");
    try {
      const updated = await api<DatasetPreparation>(
        `/projects/${projectId}/dataset-preparations/${preparationId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ output_dataset_id: datasetId }),
        },
      );
      setPreparation((prev) =>
        prev
          ? {
              ...prev,
              ...updated,
              version: prev.version,
            }
          : prev,
      );
      setSuccess(
        datasetId == null
          ? "결과 데이터셋 연결을 해제했습니다."
          : "결과 데이터셋을 업데이트했습니다.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "결과 데이터셋을 업데이트하지 못했습니다.",
      );
    } finally {
      setBusy("");
    }
  }

  async function createOutputDataset() {
    if (!canWrite) return;
    const name = newOutputName.trim();
    if (!name) {
      setError("데이터셋 이름이 필요합니다.");
      return;
    }
    setBusy("output-create");
    setError("");
    try {
      const result = await api<DatasetPreparationOutputDatasetResult>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/output-dataset`,
        {
          method: "POST",
          body: JSON.stringify({
            name,
            description: newOutputDescription.trim(),
          }),
        },
      );
      setPreparation((prev) =>
        prev
          ? {
              ...prev,
              ...result.preparation,
              version: prev.version,
            }
          : prev,
      );
      setDatasets((rows) => {
        const without = rows.filter((row) => row.id !== result.output_dataset.id);
        return [...without, result.output_dataset].sort((a, b) => a.name.localeCompare(b.name));
      });
      setNewOutputName("");
      setNewOutputDescription("");
      setSuccess(`결과 데이터셋 “${result.output_dataset.name}”을(를) 만들었습니다.`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "결과 데이터셋을 만들지 못했습니다.",
      );
    } finally {
      setBusy("");
    }
  }

  async function runPreparation() {
    if (!canWrite || !preparation) return;
    if (!guardInspectorErrors()) return;
    setBusy("run");
    setError("");
    setSuccess("");
    setSuccessRun(null);
    try {
      const created = await api<DatasetPreparationRun>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/runs`,
        { method: "POST", body: JSON.stringify({ version: null }) },
      );
      const queued = await api<DatasetPreparationRun>(
        `/projects/${projectId}/dataset-preparation-runs/${created.id}/execute`,
        { method: "POST" },
      );
      setSuccessRun(queued);
      setSuccess("준비 실행이 대기열에 등록되었습니다.");
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "준비 실행을 시작하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function executeExistingRun(runId: number) {
    if (!canWrite) return;
    setBusy(`execute-${runId}`);
    setError("");
    try {
      const queued = await api<DatasetPreparationRun>(
        `/projects/${projectId}/dataset-preparation-runs/${runId}/execute`,
        { method: "POST" },
      );
      setSuccessRun(queued);
      setSuccess(`실행 #${runId}이(가) 대기열에 등록되었습니다.`);
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "실행하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function expandRun(runId: number) {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(runId);
    try {
      const detail = await api<DatasetPreparationRun>(
        `/projects/${projectId}/dataset-preparation-runs/${runId}`,
      );
      setRuns((rows) => rows.map((row) => (row.id === runId ? { ...row, ...detail } : row)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "실행 상세를 불러오지 못했습니다.");
    }
  }

  function onBack(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    if (!window.confirm("저장되지 않은 변경이 있습니다. 저장하지 않고 나가시겠습니까?")) {
      event.preventDefault();
    }
  }

  const runDisabledReason = dirty
    ? "먼저 버전을 저장하세요"
    : preparation?.output_dataset_id == null
      ? "실행 전에 결과 데이터셋을 설정하세요"
      : busy
        ? "처리 중"
        : "";
  const runDisabled = Boolean(runDisabledReason) || !canWrite;

  const validating = busy === "validate";
  let validateStatusText = "";
  let validateStatusTone: "busy" | "ok" | "warn" | "error" | "failed" | "" = "";
  if (validating) {
    validateStatusText = "검증 중…";
    validateStatusTone = "busy";
  } else if (validateRequestFailed) {
    validateStatusText = "검증 요청 실패";
    validateStatusTone = "failed";
  } else if (validation) {
    if (!validation.valid) {
      validateStatusText = `문제 ${validation.errors.length}건`;
      validateStatusTone = "error";
    } else if (validation.warnings.length > 0) {
      validateStatusText = `검증 통과 · 경고 ${validation.warnings.length}건`;
      validateStatusTone = "warn";
    } else {
      validateStatusText = "검증 통과";
      validateStatusTone = "ok";
    }
  }

  if (loading) return <Loading label="준비 그래프 불러오는 중" />;
  if (!preparation) {
    return (
      <div>
        <ErrorNotice message={error || "준비 작업을 찾을 수 없습니다."} />
        <Link to={`/projects/${projectId}/preparations`}>준비 목록으로</Link>
      </div>
    );
  }

  return (
    <div className="preparation-builder" data-testid="preparation-builder">
      <header className="preparation-builder-header">
        <div className="preparation-builder-header-meta">
          <Link
            className="preparation-back-link"
            to={`/projects/${projectId}/preparations`}
            onClick={onBack}
            data-testid="preparation-back"
          >
            ← 준비 목록
          </Link>
          <div>
            <span className="eyebrow">데이터 준비 (Dataset preparation)</span>
            <h1>{preparation.name}</h1>
            <p className="muted builder-header-subcopy">
              {preparation.description || "시각적 데이터셋 준비 그래프입니다."}
              {" · "}
              <span className="version-chip">v{preparation.latest_version}</span>
            </p>
          </div>
        </div>
        <div className="preparation-builder-header-actions">
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-undo"
            disabled={!canUndo || busy !== ""}
            onClick={() => undoGraphEdit()}
            title="실행 취소 (Ctrl+Z)"
          >
            실행 취소
          </button>
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-redo"
            disabled={!canRedo || busy !== ""}
            onClick={() => redoGraphEdit()}
            title="다시 실행 (Ctrl+Y / Ctrl+Shift+Z)"
          >
            다시 실행
          </button>
          <div className="preparation-validate-cluster">
            <button
              type="button"
              className="btn secondary"
              data-testid="preparation-validate"
              disabled={busy !== ""}
              onClick={() => void runValidate()}
            >
              {busy === "validate" ? "검증 중…" : "검증 (Validate)"}
            </button>
            {validateStatusText && (
              <div
                className={`preparation-validate-status is-${validateStatusTone}`}
                data-testid="preparation-validate-status"
                role="status"
                aria-live="polite"
              >
                <span>{validateStatusText}</span>
                {validation && !validating && (
                  <button
                    type="button"
                    className="btn link preparation-validate-status-link"
                    data-testid="preparation-validate-status-link"
                    onClick={() => {
                      const reduceMotion =
                        typeof window.matchMedia === "function" &&
                        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                      validationPanelRef.current?.scrollIntoView({
                        behavior: reduceMotion ? "auto" : "smooth",
                        block: "start",
                      });
                    }}
                  >
                    결과 보기
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-preview"
            disabled={busy !== ""}
            onClick={() => void runPreview()}
          >
            {busy === "preview" ? "미리보기 중…" : "미리보기 (Preview)"}
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn secondary"
                data-testid="preparation-save-version"
                disabled={busy !== ""}
                onClick={() => void saveVersion()}
              >
                {busy === "save" ? "저장 중…" : "버전 저장"}
              </button>
              <button
                type="button"
                className="btn"
                data-testid="preparation-run"
                disabled={runDisabled || busy !== ""}
                title={runDisabledReason || undefined}
                onClick={() => void runPreparation()}
              >
                {busy === "run" ? "시작 중…" : "준비 실행"}
              </button>
            </>
          )}
        </div>
      </header>
      {error ? (
        <div data-testid="preparation-error">
          <ErrorNotice message={error} />
        </div>
      ) : null}
      <SuccessNotice message={success} />
      {dirty ? (
        <div className="builder-state-band is-dirty" data-testid="preparation-dirty-hint" role="status">
          <span className="builder-state-badge">저장되지 않은 변경</span>
          <span className="builder-state-copy">
            그래프를 유지하려면 버전을 저장하세요. 자동 저장되지 않습니다.
          </span>
        </div>
      ) : null}
      {successRun && String(successRun.status).toLowerCase() === "succeeded" && (
        <div
          className="preparation-success-cta panel"
          data-testid="preparation-success-cta"
          role="status"
        >
          <div className="preparation-success-main">
            <span className="eyebrow">준비 실행 성공</span>
            <h2>
              결과 데이터셋
              {successOutputDataset
                ? ` · ${successOutputDataset.name}${successOutputDataset.latest_version > 0 ? ` · v${successOutputDataset.latest_version}` : ""}`
                : successRun.output_dataset_id != null
                  ? ` · #${successRun.output_dataset_id}`
                  : ""}
            </h2>
            <div
              className="preparation-success-summary"
              data-testid="preparation-success-summary"
            >
              <span>
                <small>실행</small>
                <strong>#{successRun.id}</strong>
              </span>
              <span>
                <small>행</small>
                <strong data-testid="preparation-success-rows">
                  {successOutputDataset ? successOutputDataset.row_count.toLocaleString() : "—"}
                </strong>
              </span>
              <span>
                <small>컬럼</small>
                <strong data-testid="preparation-success-columns">
                  {successOutputDataset ? successOutputDataset.column_count.toLocaleString() : "—"}
                </strong>
              </span>
              <span>
                <small>소요 시간</small>
                <strong data-testid="preparation-success-duration">
                  {formatRunDuration(successRun)}
                </strong>
              </span>
            </div>
          </div>
          <div className="row-actions" data-testid="preparation-success-actions">
            {successRun.output_dataset_id != null && (
              <Link
                className="btn"
                to={`/projects/${projectId}/datasets/${successRun.output_dataset_id}`}
                data-testid="preparation-open-output-dataset"
              >
                데이터셋 열기
              </Link>
            )}
            {canWrite &&
              successRun.output_dataset_id != null &&
              successRun.output_dataset_version_id != null && (
                <Link
                  className="btn secondary"
                  to={`/projects/${projectId}/jobs/new?datasetId=${successRun.output_dataset_id}&datasetVersionId=${successRun.output_dataset_version_id}`}
                  data-testid="preparation-train-this-result"
                >
                  이 결과로 학습
                </Link>
              )}
          </div>
        </div>
      )}

      <div
        className={`builder-layout-3zone${!canWrite ? " is-readonly" : ""}`}
        data-testid="preparation-builder-layout"
        data-readonly={canWrite ? "false" : "true"}
      >
        {canWrite && (
          <aside className="preparation-node-library panel">
            <span className="eyebrow">노드 라이브러리</span>
            <p className="form-hint">노드 유형을 클릭하면 캔버스에 추가됩니다.</p>
            {PREPARATION_NODE_LIBRARY_GROUPS.map((group) => (
              <div
                key={group.id}
                className="preparation-library-group"
                data-testid={`preparation-library-group-${group.id}`}
              >
                <span className="preparation-library-group-label">{group.label}</span>
                <ul className="preparation-library-list">
                  {group.items.map((item) => (
                    <li key={item.type}>
                      <button
                        type="button"
                        className="preparation-library-item"
                        data-testid={`preparation-library-${item.type}`}
                        title={item.description}
                        onClick={() => addNodeOfType(item.type)}
                      >
                        <span aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </aside>
        )}

        <div
          className="preparation-canvas"
          aria-label="데이터 준비 그래프"
          data-testid="preparation-canvas"
        >
          {nodes.length === 0 ? (
            <div className="preparation-empty-canvas">
              {canWrite ? (
                <>
                  <h2>데이터 소스부터 시작하세요</h2>
                  <p className="muted">
                    데이터 소스를 추가한 뒤 변환·연결(Join)·행 합치기(Union)로 하나의 결과
                    데이터를 만듭니다.
                  </p>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => addNodeOfType("source")}
                    data-testid="preparation-add-source-empty"
                  >
                    데이터 소스 추가
                  </button>
                </>
              ) : (
                <>
                  <h2>이 준비 버전에는 노드가 없습니다.</h2>
                  <p className="muted">빈 그래프에서 확인할 설정이 없습니다.</p>
                </>
              )}
            </div>
          ) : (
            <ReactFlow
              nodes={nodes.map((node) => ({
                ...node,
                selected: node.id === selectedId,
              }))}
              edges={edges.map((edge) => ({
                ...edge,
                selected: edge.id === selectedEdgeId,
              }))}
              nodeTypes={nodeTypes}
              nodesDraggable={canWrite}
              nodesConnectable={canWrite}
              edgesReconnectable={canWrite}
              elementsSelectable
              deleteKeyCode={canWrite ? ["Backspace", "Delete"] : null}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => selectNode(node as PrepNode)}
              onEdgeClick={(_, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedId("");
              }}
              onPaneClick={() => setSelectedEdgeId("")}
              onInit={(instance) => {
                flowInstanceRef.current = instance;
              }}
              fitView
            >
              <Background />
              <MiniMap
                pannable
                ariaLabel="데이터 준비 미니맵 — 클릭하거나 드래그하여 이동"
                onClick={(_event, position) => {
                  centerFlowOnMiniMapPoint(flowInstanceRef.current, position);
                }}
                onNodeClick={(_event, node) => {
                  centerFlowOnMiniMapNode(flowInstanceRef.current, node);
                }}
              />
              <Controls />
            </ReactFlow>
          )}
        </div>

        <aside className="preparation-inspector panel" data-testid="preparation-inspector">
          {selectedEdge ? (
            <>
              <span className="eyebrow">선택한 연결</span>
              <h2 data-testid="preparation-selected-edge-title">연결선</h2>
              <p className="form-hint" data-testid="preparation-selected-edge-path">
                {selectedEdgeSourceLabel} → {selectedEdgeTargetLabel}
              </p>
              <small className="muted" data-testid="preparation-selected-edge-id">
                연결 ID: {selectedEdge.id}
                {selectedEdge.targetHandle
                  ? ` · ${String(selectedEdge.targetHandle).toUpperCase()}`
                  : ""}
              </small>
              <p className="form-hint" data-testid="preparation-edge-help">
                연결선을 클릭한 뒤 Delete 키 또는 연결 해제 버튼으로 삭제할 수 있습니다.
              </p>
              {canWrite && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn secondary"
                    data-testid="preparation-remove-edge"
                    onClick={removeSelectedEdge}
                  >
                    연결 해제
                  </button>
                </div>
              )}
            </>
          ) : !selectedNode ? (
            <>
              <span className="eyebrow">데이터 준비</span>
              <h2>{preparation.name}</h2>
              <p className="muted">{preparation.description || "설명이 없습니다."}</p>
              <dl className="preparation-inspector-meta">
                <div>
                  <dt>버전</dt>
                  <dd>v{preparation.latest_version}</dd>
                </div>
                <div>
                  <dt>노드</dt>
                  <dd>{nodes.length}</dd>
                </div>
              </dl>
              <OutputDatasetPanel
                preparation={preparation}
                datasets={datasets}
                usedSourceDatasetIds={usedSourceDatasetIds}
                canWrite={canWrite}
                busy={busy}
                newOutputName={newOutputName}
                newOutputDescription={newOutputDescription}
                onNewOutputName={setNewOutputName}
                onNewOutputDescription={setNewOutputDescription}
                onSelect={(datasetId) => void selectOutputDataset(datasetId)}
                onCreate={() => void createOutputDataset()}
              />
              <p className="form-hint">
                {canWrite
                  ? "캔버스에서 노드를 선택해 설정하거나, 노드 라이브러리에서 추가하세요. 연결선을 클릭한 뒤 Delete 키 또는 연결 해제 버튼으로 삭제할 수 있습니다."
                  : "캔버스에서 노드를 선택하면 설정을 확인할 수 있습니다."}
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">노드</span>
              <h2>{selectedNode.data.label}</h2>
              <p className="form-hint" data-testid="preparation-node-type">
                유형: {labelForPreparationType(selectedNode.data.node_type)}
              </p>
              <small className="muted" data-testid="preparation-node-id">
                노드 ID: {selectedNode.id}
              </small>
              <hr />
              <span className="eyebrow">노드 설정</span>
              {selectedNode.data.node_type === "source" && (
                <SourceInspector
                  config={selectedNode.data.config}
                  datasets={datasets}
                  versions={versions}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "join" && (
                <JoinInspector
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "union" && (
                <UnionInspector
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "select" && (
                <ColumnsInspector
                  testId="preparation-select-inspector"
                  label="남길 컬럼"
                  columns={selectedNode.data.config.columns}
                  canWrite={canWrite}
                  onChange={(columns) =>
                    updateSelectedConfig({ ...selectedNode.data.config, columns })
                  }
                />
              )}
              {selectedNode.data.node_type === "drop" && (
                <ColumnsInspector
                  testId="preparation-drop-inspector"
                  label="삭제할 컬럼"
                  columns={selectedNode.data.config.columns}
                  canWrite={canWrite}
                  onChange={(columns) =>
                    updateSelectedConfig({ ...selectedNode.data.config, columns })
                  }
                />
              )}
              {selectedNode.data.node_type === "rename" && (
                <RenameInspector
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "filter" && (
                <FilterInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "cast" && (
                <CastInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "deduplicate" && (
                <DeduplicateInspector
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "fill_constant" && (
                <FillInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "derived_column" && (
                <DerivedInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "group_by" && (
                <GroupByInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "unpivot" && (
                <UnpivotInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "pivot" && (
                <PivotInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "lag" && (
                <LagInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "rolling_window" && (
                <RollingWindowInspector
                  key={`${selectedNode.id}-${inspectorEpoch}`}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                  onValidationChange={setInspectorErrors}
                />
              )}
              {selectedNode.data.node_type === "output" && (
                <p className="muted" data-testid="preparation-output-readonly">
                  이 노드는 데이터 가공의 최종 결과를 나타냅니다. 바로 앞 단계의 노드 하나를 연결하면 되며 추가 설정은 필요하지 않습니다.
                </p>
              )}
              {canWrite && (
                <>
                  <hr />
                  <span className="eyebrow">노드 관리</span>
                  <button
                    className="btn link danger-text"
                    type="button"
                    data-testid="preparation-remove-node"
                    onClick={removeSelected}
                  >
                    노드 제거
                  </button>
                </>
              )}
              <hr />
              <OutputDatasetPanel
                preparation={preparation}
                datasets={datasets}
                usedSourceDatasetIds={usedSourceDatasetIds}
                canWrite={canWrite}
                busy={busy}
                newOutputName={newOutputName}
                newOutputDescription={newOutputDescription}
                onNewOutputName={setNewOutputName}
                onNewOutputDescription={setNewOutputDescription}
                onSelect={(datasetId) => void selectOutputDataset(datasetId)}
                onCreate={() => void createOutputDataset()}
                compact
              />
            </>
          )}
        </aside>
      </div>

      <section
        className="preparation-run-history panel"
        data-testid="preparation-run-history"
      >
        <div className="panel-title">
          <div>
            <span className="eyebrow">실행</span>
            <h2>실행 기록</h2>
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="muted" data-testid="preparation-run-history-empty">
            아직 준비 실행 기록이 없습니다.
          </p>
        ) : (
          <div className="preparation-run-table-wrap">
            <table data-testid="preparation-run-table">
              <thead>
                <tr>
                  <th>실행</th>
                  <th>레시피 버전</th>
                  <th>상태</th>
                  <th>시작</th>
                  <th>종료</th>
                  <th>결과</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const status = String(run.status).toLowerCase();
                  const recipeVersion = versionNumberById.get(run.preparation_version_id);
                  const outputName =
                    run.output_dataset_id == null
                      ? "—"
                      : datasets.find((dataset) => dataset.id === run.output_dataset_id)
                          ?.name || `#${run.output_dataset_id}`;
                  return (
                    <Fragment key={run.id}>
                      <tr data-testid={`preparation-run-row-${run.id}`}>
                        <td>
                          <div className="preparation-run-id">
                            <button
                              type="button"
                              className="btn link"
                              data-testid={`preparation-run-expand-${run.id}`}
                              aria-expanded={expandedRunId === run.id}
                              onClick={() => void expandRun(run.id)}
                            >
                              #{run.id}
                            </button>
                            {run.id === latestRunId && (
                              <span
                                className="preparation-latest-run-badge"
                                data-testid={`preparation-run-latest-${run.id}`}
                              >
                                최신
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {recipeVersion != null
                            ? `v${recipeVersion}`
                            : `id ${run.preparation_version_id}`}
                        </td>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td>{formatDate(run.started_at || run.created_at)}</td>
                        <td>{formatDate(run.finished_at)}</td>
                        <td>{outputName}</td>
                        <td>
                          {status === "created" && canWrite && (
                            <button
                              type="button"
                              className="btn secondary"
                              data-testid={`preparation-run-execute-${run.id}`}
                              disabled={busy !== ""}
                              onClick={() => void executeExistingRun(run.id)}
                            >
                              실행
                            </button>
                          )}
                          {status === "succeeded" && run.output_dataset_id != null && (
                            <Link
                              className="btn link"
                              to={`/projects/${projectId}/datasets/${run.output_dataset_id}`}
                              data-testid={`preparation-run-open-${run.id}`}
                            >
                              데이터셋 열기
                            </Link>
                          )}
                          {canWrite &&
                            status === "succeeded" &&
                            run.output_dataset_id != null &&
                            run.output_dataset_version_id != null && (
                              <Link
                                className="btn link"
                                to={`/projects/${projectId}/jobs/new?datasetId=${run.output_dataset_id}&datasetVersionId=${run.output_dataset_version_id}`}
                                data-testid={`preparation-train-result-${run.id}`}
                              >
                                이 결과로 학습
                              </Link>
                            )}
                          {status === "failed" && (
                            <button
                              type="button"
                              className="btn link"
                              data-testid={`preparation-run-show-error-${run.id}`}
                              aria-expanded={expandedRunId === run.id}
                              onClick={() => void expandRun(run.id)}
                            >
                              {expandedRunId === run.id ? "오류 숨기기" : "오류 보기"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expandedRunId === run.id && (
                        <tr data-testid={`preparation-run-detail-${run.id}`}>
                          <td colSpan={7}>
                            <RunDetailPanel run={run} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {outputDataset && (
          <p className="form-hint" data-testid="preparation-output-dataset-hint">
            현재 결과 데이터셋: {outputDataset.name} (#{outputDataset.id})
          </p>
        )}
      </section>

      {(validation || preview) && (
        <section className="preparation-results panel" data-testid="preparation-results">
          {validation && (
            <div
              className="preparation-validation"
              data-testid="preparation-validation"
              ref={validationPanelRef}
            >
              <div className="panel-title">
                <div>
                  <span className="eyebrow">검증 (Validation)</span>
                  <h2>
                    {validation.valid
                      ? "그래프가 유효합니다"
                      : `문제 ${validation.errors.length}건`}
                  </h2>
                </div>
              </div>
              {validation.valid ? (
                <p className="muted">검증을 통과했습니다.</p>
              ) : (
                <ul className="preparation-validation-list">
                  {validation.errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
              {validation.warnings.length > 0 && (
                <ul className="preparation-warning-list" data-testid="preparation-validation-warnings">
                  {validation.warnings.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {preview && (
            <div
              className="preparation-preview"
              data-testid="preparation-preview-panel"
              ref={previewPanelRef}
            >
              <div className="panel-title">
                <div>
                  <span className="eyebrow">미리보기 (Preview)</span>
                  <h2>
                    {preview.node_id ? `노드 ${preview.node_id}` : "미리보기"} ·{" "}
                    {preview.row_count}행
                  </h2>
                </div>
              </div>
              {(preview.sampled || (preview.warnings?.length ?? 0) > 0) && (
                <div
                  className="preparation-preview-warning"
                  role="status"
                  data-testid="preparation-preview-warning"
                >
                  {(preview.warnings && preview.warnings.length > 0
                    ? preview.warnings
                    : [
                        "미리보기는 저장된 DatasetVersion 샘플 행을 사용하므로 전체 데이터를 대표하지 않을 수 있습니다.",
                      ]
                  ).map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                </div>
              )}
              {sampledJoinPreviewEmpty && (
                <div
                  className="preparation-preview-empty-note"
                  role="status"
                  data-testid="preparation-preview-empty-join"
                >
                  샘플 미리보기에서 일치하는 연결(Join) 행을 찾지 못했습니다. 미리보기는 각
                  소스를 독립적으로 샘플링하므로, 전체 준비 실행은 성공할 때도 조인 키가
                  샘플에 없을 수 있습니다. 전체 데이터셋으로 확인하려면 준비 실행을 사용하세요.
                </div>
              )}
              <div className="preparation-preview-table-wrap">
                {preview.columns.length === 0 ? (
                  <p className="muted">미리보기 결과에 컬럼이 없습니다.</p>
                ) : (
                  <table data-testid="preparation-preview-table">
                    <thead>
                      <tr>
                        {preview.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, index) => (
                        <tr key={index}>
                          {preview.columns.map((column) => (
                            <td key={column}>{formatPreviewCell(row[column])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function formatRunDuration(run: DatasetPreparationRun): string {
  if (!run.started_at || !run.finished_at) return "—";
  const started = Date.parse(run.started_at);
  const finished = Date.parse(run.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return "—";
  const seconds = Math.max(0, Math.round((finished - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatPreviewCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function OutputDatasetPanel({
  preparation,
  datasets,
  usedSourceDatasetIds,
  canWrite,
  busy,
  newOutputName,
  newOutputDescription,
  onNewOutputName,
  onNewOutputDescription,
  onSelect,
  onCreate,
  compact = false,
}: {
  preparation: DatasetPreparation;
  datasets: Dataset[];
  usedSourceDatasetIds: Set<number>;
  canWrite: boolean;
  busy: string;
  newOutputName: string;
  newOutputDescription: string;
  onNewOutputName: (value: string) => void;
  onNewOutputDescription: (value: string) => void;
  onSelect: (datasetId: number | null) => void;
  onCreate: () => void;
  compact?: boolean;
}) {
  const configured = preparation.output_dataset_id != null;
  return (
    <div
      className={`preparation-output-dataset${compact ? " is-compact" : ""}`}
      data-testid="preparation-output-dataset"
    >
      <span className="eyebrow">결과 데이터셋 (Output)</span>
      {!configured && (
        <p className="muted" data-testid="preparation-output-empty">
          결과 데이터셋이 아직 설정되지 않았습니다.
        </p>
      )}
      {!configured && (
        <p className="form-hint">
          실행 전에 기존 데이터셋을 선택하거나 새로 만드세요.
        </p>
      )}
      <label>
        기존 데이터셋
        <select
          data-testid="preparation-output-select"
          disabled={!canWrite || busy.startsWith("output")}
          value={
            preparation.output_dataset_id == null
              ? ""
              : String(preparation.output_dataset_id)
          }
          onChange={(event) => {
            const value = event.target.value;
            onSelect(value ? Number(value) : null);
          }}
        >
          <option value="">데이터셋 선택…</option>
          {datasets.map((dataset) => {
            const usedAsSource = usedSourceDatasetIds.has(dataset.id);
            return (
              <option
                key={dataset.id}
                value={dataset.id}
                disabled={usedAsSource}
              >
                {dataset.name}
                {usedAsSource ? " (소스로 사용 중)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {canWrite && usedSourceDatasetIds.size > 0 && (
        <p className="form-hint" data-testid="preparation-output-source-warn">
          그래프 소스로 쓰인 데이터셋은 입력을 덮어쓰지 않도록 선택할 수 없습니다.
        </p>
      )}
      {canWrite && (
        <div className="preparation-output-create" data-testid="preparation-output-create">
          <span className="eyebrow">새로 만들기</span>
          <label>
            이름
            <input
              data-testid="preparation-output-name"
              value={newOutputName}
              disabled={busy.startsWith("output")}
              onChange={(event) => onNewOutputName(event.target.value)}
              placeholder="prepared-iris"
            />
          </label>
          <label>
            설명
            <input
              data-testid="preparation-output-description"
              value={newOutputDescription}
              disabled={busy.startsWith("output")}
              onChange={(event) => onNewOutputDescription(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-output-create-submit"
            disabled={busy !== "" || !newOutputName.trim()}
            onClick={onCreate}
          >
            {busy === "output-create" ? "만드는 중…" : "결과 데이터셋 만들기"}
          </button>
        </div>
      )}
    </div>
  );
}

function RunDetailPanel({ run }: { run: DatasetPreparationRun }) {
  return (
    <div className="preparation-run-detail">
      {run.error_message && (
        <p className="error" data-testid={`preparation-run-error-${run.id}`}>
          {run.error_message}
        </p>
      )}
      {run.inputs && run.inputs.length > 0 && (
        <div data-testid={`preparation-run-inputs-${run.id}`}>
          <strong>입력</strong>
          <ul>
            {run.inputs.map((input) => (
              <li key={input.id}>
                {input.node_id}: dataset #{input.dataset_id} · version #
                {input.dataset_version_id} ({input.version_strategy})
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.logs ? (
        <pre
          className="preparation-run-logs"
          data-testid={`preparation-run-logs-${run.id}`}
        >
          {run.logs}
        </pre>
      ) : (
        <p className="muted">아직 로그가 없습니다.</p>
      )}
    </div>
  );
}

function SourceInspector({
  config,
  datasets,
  versions,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  datasets: Dataset[];
  versions: DatasetVersion[];
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const strategy = config.version_strategy === "fixed" ? "fixed" : "latest";
  const datasetId =
    typeof config.dataset_id === "number"
      ? config.dataset_id
      : config.dataset_id == null || config.dataset_id === ""
        ? null
        : Number(config.dataset_id);
  const selectedDataset =
    datasetId == null ? undefined : datasets.find((dataset) => dataset.id === datasetId);
  const selectedVersion =
    strategy === "fixed" && config.dataset_version_id != null
      ? versions.find((version) => version.id === Number(config.dataset_version_id))
      : undefined;
  const knownColumns =
    strategy === "fixed"
      ? selectedVersion?.columns
      : selectedDataset?.columns;
  const knownColumnsReady =
    strategy === "fixed"
      ? Boolean(selectedDataset && selectedVersion)
      : Boolean(selectedDataset);

  return (
    <div className="preparation-inspector-form" data-testid="preparation-source-inspector">
      <label>
        <TermLabel ko="데이터셋" en="Dataset" />
        <select
          data-testid="preparation-source-dataset"
          disabled={!canWrite}
          value={config.dataset_id == null ? "" : String(config.dataset_id)}
          onChange={(event) => {
            const value = event.target.value;
            const next: Record<string, unknown> = {
              ...config,
              dataset_id: value ? Number(value) : null,
            };
            if (strategy === "fixed") {
              // Never keep a version id that belonged to the previous dataset.
              next.dataset_version_id = null;
            } else {
              delete next.dataset_version_id;
            }
            onChange(next);
          }}
        >
          <option value="">데이터셋 선택…</option>
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <TermLabel ko="버전 전략" en="Version strategy" />
        <select
          data-testid="preparation-source-strategy"
          disabled={!canWrite}
          value={strategy}
          onChange={(event) => {
            const nextStrategy = event.target.value === "fixed" ? "fixed" : "latest";
            const next: Record<string, unknown> = {
              ...config,
              version_strategy: nextStrategy,
            };
            if (nextStrategy === "latest") {
              delete next.dataset_version_id;
            } else if (next.dataset_version_id == null) {
              next.dataset_version_id = null;
            }
            onChange(next);
          }}
        >
          <option value="latest">최신 (Latest)</option>
          <option value="fixed">고정 (Fixed)</option>
        </select>
      </label>
      {strategy === "fixed" && (
        <label>
          <TermLabel ko="데이터셋 버전" en="Dataset version" />
          <select
            data-testid="preparation-source-version"
            disabled={!canWrite}
            value={
              config.dataset_version_id == null ? "" : String(config.dataset_version_id)
            }
            onChange={(event) => {
              const value = event.target.value;
              onChange({
                ...config,
                version_strategy: "fixed",
                dataset_version_id: value ? Number(value) : null,
              });
            }}
          >
            <option value="">버전 선택…</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version} · {version.original_filename}
              </option>
            ))}
          </select>
        </label>
      )}
      <div
        className="preparation-known-columns"
        data-testid="preparation-source-known-columns"
      >
        <span className="preparation-known-columns-label">알려진 컬럼</span>
        {!knownColumnsReady ? (
          <p className="muted preparation-known-columns-empty">
            컬럼을 보려면 데이터셋/버전을 선택하세요.
          </p>
        ) : !knownColumns || knownColumns.length === 0 ? (
          <p className="muted preparation-known-columns-empty">사용 가능한 컬럼이 없습니다.</p>
        ) : (
          <ul className="preparation-known-columns-list">
            {knownColumns.map((column) => (
              <li key={column}>{column}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function joinHowHint(how: string): string {
  switch (how) {
    case "left":
      return "왼쪽 데이터의 모든 행을 유지하고, 오른쪽에서 일치하는 데이터를 연결합니다.";
    case "right":
      return "오른쪽 데이터의 모든 행을 유지하고, 왼쪽에서 일치하는 데이터를 연결합니다.";
    case "full":
      return "양쪽 데이터의 모든 행을 유지하고, 연결되지 않는 부분은 빈 값으로 채웁니다.";
    case "inner":
    default:
      return "양쪽 데이터에서 연결 키 값이 일치하는 행만 남깁니다.";
  }
}

function JoinInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const how = String(config.how || "inner");
  return (
    <div className="preparation-inspector-form" data-testid="preparation-join-inspector">
      <p className="muted preparation-inspector-hint" data-testid="preparation-join-hint">
        왼쪽(LEFT)과 오른쪽(RIGHT) 연결 지점에 각각 데이터를 연결하세요. 두 데이터에서 같은 값을 가진 컬럼을 연결 키로 지정합니다.
        <HelpTip text={UI_HELP.preparationJoin} />
      </p>
      <label>
        <TermLabel ko="연결 방식" en="How" help={UI_HELP.preparationJoin} />
        <select
          data-testid="preparation-join-how"
          disabled={!canWrite}
          value={how}
          onChange={(event) => onChange({ ...config, how: event.target.value })}
        >
          <option value="inner">일치하는 행만 연결 (INNER)</option>
          <option value="left">왼쪽 모든 행 유지 (LEFT)</option>
          <option value="right">오른쪽 모든 행 유지 (RIGHT)</option>
          <option value="full">양쪽 모든 행 유지 (FULL)</option>
        </select>
      </label>
      <p className="form-hint" data-testid="preparation-join-mode-hint">
        {joinHowHint(how)}
      </p>
      <label>
        <TermLabel ko="왼쪽 키" en="Left keys" />
        <input
          data-testid="preparation-join-left-on"
          disabled={!canWrite}
          value={formatKeyList(config.left_on)}
          placeholder="id, customer_id"
          onChange={(event) =>
            onChange({ ...config, left_on: parseKeyList(event.target.value) })
          }
        />
        <small>왼쪽 데이터에서 비교할 컬럼 이름을 입력하세요. 여러 개라면 쉼표로 구분합니다.</small>
      </label>
      <label>
        <TermLabel ko="오른쪽 키" en="Right keys" />
        <input
          data-testid="preparation-join-right-on"
          disabled={!canWrite}
          value={formatKeyList(config.right_on)}
          placeholder="id, customer_id"
          onChange={(event) =>
            onChange({ ...config, right_on: parseKeyList(event.target.value) })
          }
        />
        <small>오른쪽 데이터에서 비교할 컬럼 이름을 입력하세요. 왼쪽 키와 순서대로 대응합니다.</small>
      </label>
    </div>
  );
}

function UnionInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const mode = String(config.mode || "strict");
  return (
    <div className="preparation-inspector-form" data-testid="preparation-union-inspector">
      <label>
        <TermLabel ko="모드" en="Mode" help={UI_HELP.preparationUnion} />
        <select
          data-testid="preparation-union-mode"
          disabled={!canWrite}
          value={mode}
          onChange={(event) => onChange({ ...config, mode: event.target.value })}
        >
          <option value="strict">동일한 컬럼 구성만 합치기 (strict)</option>
          <option value="align_by_name">컬럼 이름으로 맞추기 (align_by_name)</option>
        </select>
      </label>
      <p className="muted preparation-inspector-hint" data-testid="preparation-union-hint">
        {mode === "align_by_name"
          ? "컬럼 이름을 기준으로 데이터를 맞춰 합칩니다. 없는 컬럼의 값은 null(빈 값)로 채웁니다."
          : "입력 데이터들의 컬럼 이름과 순서가 같아야 합칠 수 있습니다."}
      </p>
    </div>
  );
}

function ColumnsInspector({
  testId,
  label,
  columns,
  canWrite,
  onChange,
}: {
  testId: string;
  label: string;
  columns: unknown;
  canWrite: boolean;
  onChange: (columns: string[]) => void;
}) {
  return (
    <div className="preparation-inspector-form" data-testid={testId}>
      <label>
        {label}
        <input
          data-testid={`${testId}-columns`}
          disabled={!canWrite}
          value={formatKeyList(columns)}
          placeholder="col_a, col_b"
          onChange={(event) => onChange(parseKeyList(event.target.value))}
        />
        <small>컬럼명을 쉼표로 구분하세요.</small>
      </label>
    </div>
  );
}

function RenameInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="preparation-inspector-form" data-testid="preparation-rename-inspector">
      <label>
        <TermLabel ko="이름 매핑" en="Renames" />
        <textarea
          data-testid="preparation-rename-mapping"
          disabled={!canWrite}
          rows={5}
          value={formatRenameMapping(config.mapping)}
          placeholder={"old_name = new_name"}
          onChange={(event) =>
            onChange({ ...config, mapping: parseRenameMapping(event.target.value) })
          }
        />
        <small>한 줄에 하나씩: old = new</small>
      </label>
    </div>
  );
}

function FilterInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const combine = config.combine === "or" ? "or" : "and";
  const [drafts, setDrafts] = useState<FilterCondition[]>(() =>
    parseFilterConditions(config.conditions).map((condition) => ({
      ...condition,
      value_type: condition.value_type ?? inferFilterValueType(condition.value),
    })),
  );
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function publish(nextDrafts: FilterCondition[], nextCombine: "and" | "or" = combine) {
    setDrafts(nextDrafts);
    const serialized = serializeFilterConditions(nextDrafts, nextCombine);
    setErrors(serialized.errors);
    onValidationChange?.(serialized.errors);
    if (serialized.errors.length > 0) {
      // Keep last good graph config; do not write invalid typed values.
      return;
    }
    onChange({
      ...config,
      combine: serialized.combine,
      conditions: serialized.conditions,
    });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-filter-inspector">
      <p className="muted preparation-inspector-hint" data-testid="preparation-filter-hint">
        조건에 맞는 행만 남깁니다. 컬럼명은 데이터에 있는 이름을 그대로 입력하세요.
        <HelpTip text={UI_HELP.preparationFilter} />
      </p>
      <label>
        <TermLabel ko="조건 결합" en="Combine" help={UI_HELP.preparationFilter} />
        <select
          data-testid="preparation-filter-combine"
          disabled={!canWrite}
          value={combine}
          onChange={(event) =>
            publish(drafts, event.target.value === "or" ? "or" : "and")
          }
        >
          <option value="and">{filterCombineLabel("and")}</option>
          <option value="or">{filterCombineLabel("or")}</option>
        </select>
      </label>
      <p className="form-hint" data-testid="preparation-filter-combine-hint">
        {filterCombineHint(combine)}
      </p>
      <div className="preparation-filter-rows">
        {drafts.map((condition, index) => {
          const nullary = FILTER_NULLARY_OPS.has(condition.operator);
          const valueType: FilterValueType =
            condition.value_type ?? inferFilterValueType(condition.value);
          const operatorHelp = filterOperatorHelp(condition.operator);
          return (
            <div
              key={index}
              className="preparation-filter-row"
              data-testid={`preparation-filter-row-${index}`}
            >
              <input
                data-testid={`preparation-filter-column-${index}`}
                disabled={!canWrite}
                placeholder="컬럼명 (예: age)"
                value={condition.column}
                onChange={(event) => {
                  const next = [...drafts];
                  next[index] = { ...condition, column: event.target.value };
                  publish(next);
                }}
              />
              <div className="preparation-filter-operator-field">
                <select
                  data-testid={`preparation-filter-operator-${index}`}
                  disabled={!canWrite}
                  value={condition.operator}
                  onChange={(event) => {
                    const operator = event.target.value;
                    const next = [...drafts];
                    next[index] = FILTER_NULLARY_OPS.has(operator)
                      ? { column: condition.column, operator }
                      : {
                          column: condition.column,
                          operator,
                          value_type: condition.value_type ?? "string",
                          value: formatFilterValueInput(condition),
                        };
                    publish(next);
                  }}
                >
                  {FILTER_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {filterOperatorLabel(operator)}
                    </option>
                  ))}
                </select>
                <span data-testid={`preparation-filter-operator-help-${index}`}>
                  <HelpTip text={operatorHelp} />
                </span>
              </div>
              {!nullary && (
                <>
                  <select
                    data-testid={`preparation-filter-value-type-${index}`}
                    disabled={!canWrite}
                    value={valueType}
                    onChange={(event) => {
                      const nextType = event.target.value as FilterValueType;
                      const next = [...drafts];
                      next[index] = {
                        ...condition,
                        value_type: nextType,
                        value:
                          nextType === "boolean"
                            ? "false"
                            : formatFilterValueInput(condition),
                      };
                      publish(next);
                    }}
                  >
                    <option value="string">{filterValueTypeLabel("string")}</option>
                    <option value="number">{filterValueTypeLabel("number")}</option>
                    <option value="boolean">{filterValueTypeLabel("boolean")}</option>
                  </select>
                  {valueType === "boolean" && condition.operator !== "in" ? (
                    <select
                      data-testid={`preparation-filter-value-${index}`}
                      disabled={!canWrite}
                      value={
                        condition.value === true || condition.value === "true"
                          ? "true"
                          : "false"
                      }
                      onChange={(event) => {
                        const next = [...drafts];
                        next[index] = {
                          ...condition,
                          value_type: "boolean",
                          value: event.target.value,
                        };
                        publish(next);
                      }}
                    >
                      <option value="true">참 (True)</option>
                      <option value="false">거짓 (False)</option>
                    </select>
                  ) : (
                    <input
                      data-testid={`preparation-filter-value-${index}`}
                      disabled={!canWrite}
                      type={valueType === "number" && condition.operator !== "in" ? "number" : "text"}
                      placeholder={
                        condition.operator === "in"
                          ? valueType === "number"
                            ? "예: 1, 2, 3"
                            : "예: a, b, c"
                          : "비교값"
                      }
                      value={formatFilterValueInput(condition)}
                      onChange={(event) => {
                        const next = [...drafts];
                        next[index] = {
                          ...condition,
                          value_type: valueType,
                          value: event.target.value,
                        };
                        publish(next);
                      }}
                    />
                  )}
                </>
              )}
              {canWrite && (
                <button
                  type="button"
                  className="btn link danger-text"
                  data-testid={`preparation-filter-remove-${index}`}
                  onClick={() => publish(drafts.filter((_, i) => i !== index))}
                >
                  제거
                </button>
              )}
            </div>
          );
        })}
      </div>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-filter-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-filter-add"
          onClick={() =>
            publish([
              ...drafts,
              { column: "", operator: "eq", value_type: "string", value: "" },
            ])
          }
        >
          조건 추가
        </button>
      )}
    </div>
  );
}

function CastInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [rows, setRows] = useState(() => {
    const parsed = parseCasts(config.casts);
    return parsed.length ? parsed : [];
  });

  function commit(nextRows: Array<{ column: string; dtype: string }>) {
    setRows(nextRows);
    onChange({ ...config, casts: serializeCasts(nextRows) });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-cast-inspector">
      <p className="muted preparation-inspector-hint" data-testid="preparation-cast-help">
        <TermLabel ko="자료형 변환" en="Cast" help={UI_HELP.preparationCast} />
        {" "}
        컬럼명은 데이터에 있는 이름을 그대로 입력하세요.
      </p>
      <div className="preparation-cast-rows">
        {rows.map((row, index) => (
          <div
            key={index}
            className="preparation-cast-row"
            data-testid={`preparation-cast-row-${index}`}
          >
            <input
              data-testid={`preparation-cast-column-${index}`}
              disabled={!canWrite}
              placeholder="컬럼명 (예: amount)"
              value={row.column}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, column: event.target.value };
                commit(next);
              }}
            />
            <div className="preparation-cast-dtype-field">
              <select
                data-testid={`preparation-cast-dtype-${index}`}
                disabled={!canWrite}
                value={row.dtype}
                onChange={(event) => {
                  const next = [...rows];
                  next[index] = { ...row, dtype: event.target.value };
                  commit(next);
                }}
              >
                {CAST_TYPES.map((dtype) => (
                  <option key={dtype} value={dtype}>
                    {castDtypeLabel(dtype)}
                  </option>
                ))}
              </select>
              <span data-testid={`preparation-cast-dtype-help-${index}`}>
                <HelpTip text={castDtypeHelp(row.dtype)} />
              </span>
            </div>
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-cast-remove-${index}`}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                제거
              </button>
            )}
          </div>
        ))}
      </div>
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-cast-add"
          onClick={() => commit([...rows, { column: "", dtype: "string" }])}
        >
          변환 추가
        </button>
      )}
    </div>
  );
}

function DeduplicateInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="preparation-inspector-form" data-testid="preparation-deduplicate-inspector">
      <label>
        <TermLabel ko="키 컬럼" en="Key columns" />
        <input
          data-testid="preparation-deduplicate-columns"
          disabled={!canWrite}
          value={formatKeyList(config.columns)}
          placeholder="비우면 모든 컬럼 사용"
          onChange={(event) =>
            onChange({ ...config, columns: parseKeyList(event.target.value) })
          }
        />
        <small>쉼표로 구분. 비우면 모든 컬럼입니다.</small>
      </label>
      <label>
        <TermLabel ko="유지" en="Keep" />
        <select
          data-testid="preparation-deduplicate-keep"
          disabled={!canWrite}
          value={config.keep === "last" ? "last" : "first"}
          onChange={(event) => onChange({ ...config, keep: event.target.value })}
        >
          <option value="first">first</option>
          <option value="last">last</option>
        </select>
      </label>
    </div>
  );
}

function FillInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const [rows, setRows] = useState(() => parseFillValues(config.values));
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function commit(nextRows: FillValueRow[]) {
    setRows(nextRows);
    const serialized = serializeFillValues(nextRows);
    setErrors(serialized.errors);
    onValidationChange?.(serialized.errors);
    if (serialized.errors.length > 0) {
      // Do not overwrite graph config with silent zeros / invalid values.
      return;
    }
    onChange({ ...config, values: serialized.values });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-fill-inspector">
      <p className="muted preparation-inspector-hint" data-testid="preparation-fill-hint">
        선택한 컬럼에서 값이 비어 있는 부분(결측값)만 지정한 값으로 채웁니다. 이미 값이 있는 행은
        변경하지 않습니다.
        <HelpTip text={UI_HELP.preparationFill} />
      </p>
      <div className="preparation-fill-rows">
        {rows.map((row, index) => (
          <div
            key={index}
            className="preparation-fill-row"
            data-testid={`preparation-fill-row-${index}`}
          >
            <label>
              <TermLabel ko="채울 컬럼" en="Column" help={UI_HELP.preparationFill} />
              <input
                data-testid={`preparation-fill-column-${index}`}
                disabled={!canWrite}
                placeholder="컬럼명 (예: rn)"
                value={row.column}
                onChange={(event) => {
                  const next = [...rows];
                  next[index] = { ...row, column: event.target.value };
                  commit(next);
                }}
              />
              <small>결측값을 대체할 원본 컬럼입니다. 입력 데이터에 있는 이름을 정확히 적으세요.</small>
            </label>
            <label>
              <TermLabel ko="채울 값 자료형" en="Value type" />
              <select
                data-testid={`preparation-fill-kind-${index}`}
                disabled={!canWrite}
                value={row.kind}
                onChange={(event) => {
                  const next = [...rows];
                  next[index] = {
                    ...row,
                    kind: event.target.value as FillValueRow["kind"],
                    value:
                      event.target.value === "boolean"
                        ? row.value === "true"
                          ? "true"
                          : "false"
                        : row.value,
                  };
                  commit(next);
                }}
              >
                <option value="string">{filterValueTypeLabel("string")}</option>
                <option value="number">{filterValueTypeLabel("number")}</option>
                <option value="boolean">{filterValueTypeLabel("boolean")}</option>
              </select>
            </label>
            <label>
              <TermLabel ko="채울 값" en="Fill value" />
              {row.kind === "boolean" ? (
                <select
                  data-testid={`preparation-fill-value-${index}`}
                  disabled={!canWrite}
                  value={row.value === "true" ? "true" : "false"}
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, value: event.target.value };
                    commit(next);
                  }}
                >
                  <option value="true">참 (True)</option>
                  <option value="false">거짓 (False)</option>
                </select>
              ) : (
                <input
                  data-testid={`preparation-fill-value-${index}`}
                  disabled={!canWrite}
                  type={row.kind === "number" ? "number" : "text"}
                  placeholder={
                    row.kind === "number" ? "채울 값 (예: 0)" : "채울 값 (예: UNKNOWN)"
                  }
                  value={row.value}
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, value: event.target.value };
                    commit(next);
                  }}
                />
              )}
              <small>결측값 대신 넣을 고정값입니다. 이미 값이 있는 행은 바꾸지 않습니다.</small>
            </label>
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-fill-remove-${index}`}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                제거
              </button>
            )}
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-fill-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-fill-add"
          onClick={() =>
            commit([...rows, { column: "", kind: "string", value: "" }])
          }
        >
          채우기 추가
        </button>
      )}
    </div>
  );
}

function DerivedInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const left = parseDerivedOperand(config.left, { kind: "column", value: "" });
  const right = parseDerivedOperand(config.right, {
    kind: "literal",
    value_type: "number",
    value: 0,
  });
  const [leftError, setLeftError] = useState<string | null>(null);
  const [rightError, setRightError] = useState<string | null>(null);
  const operation = String(config.operation || "add");

  useEffect(() => {
    const errors = [leftError, rightError].filter(
      (error): error is string => Boolean(error),
    );
    onValidationChange?.(errors);
  }, [leftError, rightError, onValidationChange]);

  function updateOperand(side: "left" | "right", next: DerivedOperand) {
    onChange({ ...config, [side]: next });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-derived-inspector">
      <p className="form-hint" data-testid="preparation-derived-help">
        <TermLabel ko="파생 컬럼" en="Derived column" help={UI_HELP.preparationDerived} />
      </p>
      <label>
        <TermLabel ko="새 컬럼 이름" en="Column name" help={UI_HELP.preparationDerived} />
        <input
          data-testid="preparation-derived-name"
          disabled={!canWrite}
          value={String(config.name ?? "")}
          onChange={(event) => onChange({ ...config, name: event.target.value })}
        />
      </label>
      <label>
        <TermLabel ko="연산" en="Operation" />
        <select
          data-testid="preparation-derived-operation"
          disabled={!canWrite}
          value={operation}
          onChange={(event) => {
            const nextOperation = event.target.value;
            if (
              ["regex_extract", "datetime_parse", "datetime_format"].includes(nextOperation)
            ) {
              onChange({
                ...config,
                operation: nextOperation,
                right: { kind: "literal", value_type: "string", value: "" },
              });
              return;
            }
            onChange({ ...config, operation: nextOperation });
          }}
        >
          {DERIVED_OPERATIONS.map((operation) => (
            <option key={operation} value={operation}>
              {derivedOperationLabel(operation)}
            </option>
          ))}
        </select>
      </label>
      {operation === "regex_extract" && (
        <small className="muted">
          Left: 소스 컬럼. Right: 캡처 그룹이 정확히 하나인 정규식 문자열(예: _(\d+)HR$).
        </small>
      )}
      {operation === "datetime_parse" && (
        <small className="muted">
          Left: 소스 컬럼. Right: 날짜시간 형식(예: %Y%m%d).
        </small>
      )}
      {operation === "datetime_add_hours" && (
        <small className="muted">
          Left: 날짜시간 컬럼. Right: 시간(숫자) 컬럼 또는 Literal.
        </small>
      )}
      {operation === "datetime_format" && (
        <small className="muted">
          Left: 날짜시간 컬럼. Right: 출력 형식(예: %Y-%m-%d %H:%M).
        </small>
      )}
      <OperandFields
        label="왼쪽 (Left)"
        testIdPrefix="preparation-derived-left"
        operand={left}
        canWrite={canWrite}
        onChange={(next) => updateOperand("left", next)}
        onValidationChange={setLeftError}
      />
      <OperandFields
        label="오른쪽 (Right)"
        testIdPrefix="preparation-derived-right"
        operand={right}
        canWrite={canWrite}
        onChange={(next) => updateOperand("right", next)}
        onValidationChange={setRightError}
      />
      {(leftError || rightError) && (
        <ul className="preparation-inspector-errors" data-testid="preparation-derived-errors">
          {[leftError, rightError]
            .filter((error): error is string => Boolean(error))
            .map((error) => (
              <li key={error}>{error}</li>
            ))}
        </ul>
      )}
    </div>
  );
}

function OperandFields({
  label,
  testIdPrefix,
  operand,
  canWrite,
  onChange,
  onValidationChange,
}: {
  label: string;
  testIdPrefix: string;
  operand: DerivedOperand;
  canWrite: boolean;
  onChange: (next: DerivedOperand) => void;
  onValidationChange?: (error: string | null) => void;
}) {
  const literalType: FilterValueType =
    operand.kind === "literal"
      ? (operand.value_type ?? inferDerivedLiteralType(operand.value))
      : "string";
  const [literalDraft, setLiteralDraft] = useState(() =>
    operand.kind === "literal" ? formatDerivedLiteralInput(operand.value) : "",
  );
  const [literalError, setLiteralError] = useState<string | null>(null);

  useEffect(() => {
    if (operand.kind !== "literal") {
      setLiteralDraft("");
      setLiteralError(null);
      onValidationChange?.(null);
      return;
    }
    setLiteralDraft(formatDerivedLiteralInput(operand.value));
    setLiteralError(null);
    onValidationChange?.(null);
  }, [operand.kind, operand.value, operand.value_type, onValidationChange]);

  function commitLiteral(nextType: FilterValueType, raw: string) {
    setLiteralDraft(raw);
    const coerced = coerceDerivedLiteral(raw, nextType);
    if (!coerced.ok) {
      setLiteralError(coerced.error);
      onValidationChange?.(coerced.error);
      return;
    }
    setLiteralError(null);
    onValidationChange?.(null);
    onChange({
      kind: "literal",
      value_type: nextType,
      value: coerced.value as string | number | boolean,
    });
  }

  return (
    <fieldset className="preparation-operand-fields">
      <legend>{label}</legend>
      <label>
        <TermLabel ko="종류" en="Kind" />
        <select
          data-testid={`${testIdPrefix}-kind`}
          disabled={!canWrite}
          value={operand.kind}
          onChange={(event) => {
            if (event.target.value === "literal") {
              setLiteralDraft("0");
              setLiteralError(null);
              onValidationChange?.(null);
              onChange({ kind: "literal", value_type: "number", value: 0 });
              return;
            }
            setLiteralDraft("");
            setLiteralError(null);
            onValidationChange?.(null);
            onChange({ kind: "column", value: "" });
          }}
        >
          <option value="column">컬럼 (Column)</option>
          <option value="literal">고정값 (Literal)</option>
        </select>
      </label>
      {operand.kind === "literal" ? (
        <>
          <label>
            <TermLabel ko="값 유형" en="Value type" />
            <select
              data-testid={`${testIdPrefix}-value-type`}
              disabled={!canWrite}
              value={literalType}
              onChange={(event) => {
                const nextType = event.target.value as FilterValueType;
                const nextDraft =
                  nextType === "boolean"
                    ? literalDraft === "true" || literalDraft === "false"
                      ? literalDraft
                      : "false"
                    : literalDraft;
                commitLiteral(nextType, nextDraft);
              }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
          </label>
          <label>
            <TermLabel ko="값" en="Value" />
            {literalType === "boolean" ? (
              <select
                data-testid={`${testIdPrefix}-value`}
                disabled={!canWrite}
                value={literalDraft === "true" ? "true" : "false"}
                onChange={(event) => commitLiteral("boolean", event.target.value)}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                data-testid={`${testIdPrefix}-value`}
                disabled={!canWrite}
                type={literalType === "number" ? "number" : "text"}
                value={literalDraft}
                onChange={(event) => commitLiteral(literalType, event.target.value)}
              />
            )}
          </label>
          {literalError ? (
            <p className="error" data-testid={`${testIdPrefix}-error`}>
              {literalError}
            </p>
          ) : null}
        </>
      ) : (
        <label>
          <TermLabel ko="값" en="Value" />
          <input
            data-testid={`${testIdPrefix}-value`}
            disabled={!canWrite}
            value={String(operand.value ?? "")}
            onChange={(event) => onChange({ kind: "column", value: event.target.value })}
          />
        </label>
      )}
    </fieldset>
  );
}

function GroupByInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const [groupKeysText, setGroupKeysText] = useState(() => formatKeyList(config.group_by));
  const [rows, setRows] = useState<GroupByAggregationRow[]>(() =>
    parseGroupByAggregations(config.aggregations),
  );
  const [errors, setErrors] = useState<string[]>([]);

  function evaluateDraft(nextKeysText: string, nextRows: GroupByAggregationRow[]) {
    return serializeGroupByConfig({
      groupKeys: parseKeyList(nextKeysText),
      aggregations: nextRows,
    });
  }

  // Validate on mount so empty defaults gate Save/Validate/Preview/Run.
  // Start from [] and setErrors here so the publish effect runs after the
  // parent selectedId clear in the same selection turn.
  useEffect(() => {
    const serialized = evaluateDraft(groupKeysText, rows);
    setErrors(serialized.errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; commit() owns later updates
  }, []);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function commit(nextKeysText: string, nextRows: GroupByAggregationRow[]) {
    setGroupKeysText(nextKeysText);
    setRows(nextRows);
    const serialized = evaluateDraft(nextKeysText, nextRows);
    setErrors(serialized.errors);
    if (serialized.errors.length > 0) {
      // Keep last-good graph config; do not write invalid drafts.
      return;
    }
    onChange({
      ...config,
      group_by: serialized.group_by,
      aggregations: serialized.aggregations,
    });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-groupby-inspector">
      <p className="form-hint" data-testid="preparation-groupby-help">
        <TermLabel ko="그룹 집계" en="Group By" help={UI_HELP.preparationGroupBy} />
      </p>
      <label>
        <TermLabel ko="그룹 키" en="Group keys" help={UI_HELP.preparationGroupBy} />
        <textarea
          data-testid="preparation-groupby-keys"
          disabled={!canWrite}
          rows={2}
          placeholder="region, category"
          value={groupKeysText}
          onChange={(event) => commit(event.target.value, rows)}
        />
      </label>
      <div className="preparation-groupby-rows">
        {rows.map((row, index) => (
          <div
            key={index}
            className="preparation-groupby-row"
            data-testid={`preparation-groupby-row-${index}`}
          >
            <input
              data-testid={`preparation-groupby-column-${index}`}
              disabled={!canWrite}
              placeholder="source column"
              value={row.column}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, column: event.target.value };
                commit(groupKeysText, next);
              }}
            />
            <select
              data-testid={`preparation-groupby-op-${index}`}
              disabled={!canWrite}
              value={row.op}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, op: event.target.value };
                commit(groupKeysText, next);
              }}
            >
              {GROUP_BY_OPS.map((op) => (
                <option key={op} value={op}>
                  {op.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              data-testid={`preparation-groupby-output-${index}`}
              disabled={!canWrite}
              placeholder="output column"
              value={row.output}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, output: event.target.value };
                commit(groupKeysText, next);
              }}
            />
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-groupby-remove-${index}`}
                onClick={() => commit(groupKeysText, rows.filter((_, i) => i !== index))}
              >
                제거
              </button>
            )}
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-groupby-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-groupby-add"
          onClick={() =>
            commit(groupKeysText, [...rows, { column: "", op: "sum", output: "" }])
          }
        >
          집계 추가
        </button>
      )}
    </div>
  );
}

function UnpivotInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const [idColumnsText, setIdColumnsText] = useState(() => formatKeyList(config.id_columns));
  const [valueColumnsText, setValueColumnsText] = useState(() =>
    formatKeyList(config.value_columns),
  );
  const [variableColumn, setVariableColumn] = useState(() =>
    String(config.variable_column ?? "variable"),
  );
  const [valueColumn, setValueColumn] = useState(() => String(config.value_column ?? "value"));
  const [errors, setErrors] = useState<string[]>([]);

  function evaluateDraft(
    nextIdsText: string,
    nextValuesText: string,
    nextVariable: string,
    nextValue: string,
  ) {
    return serializeUnpivotConfig({
      idColumns: parseKeyList(nextIdsText),
      valueColumns: parseKeyList(nextValuesText),
      variableColumn: nextVariable,
      valueColumn: nextValue,
    });
  }

  // Validate on mount so empty defaults gate Save/Validate/Preview/Run.
  useEffect(() => {
    const serialized = evaluateDraft(
      idColumnsText,
      valueColumnsText,
      variableColumn,
      valueColumn,
    );
    setErrors(serialized.errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; commit() owns later updates
  }, []);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function commit(
    nextIdsText: string,
    nextValuesText: string,
    nextVariable: string,
    nextValue: string,
  ) {
    setIdColumnsText(nextIdsText);
    setValueColumnsText(nextValuesText);
    setVariableColumn(nextVariable);
    setValueColumn(nextValue);
    const serialized = evaluateDraft(nextIdsText, nextValuesText, nextVariable, nextValue);
    setErrors(serialized.errors);
    if (serialized.errors.length > 0) {
      return;
    }
    onChange({
      ...config,
      id_columns: serialized.id_columns,
      value_columns: serialized.value_columns,
      variable_column: serialized.variable_column,
      value_column: serialized.value_column,
    });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-unpivot-inspector">
      <label>
        <TermLabel ko="식별자 컬럼" en="Identifier columns" help={UI_HELP.preparationUnpivot} />
        <textarea
          data-testid="preparation-unpivot-ids"
          disabled={!canWrite}
          rows={2}
          placeholder="customer_id, region"
          value={idColumnsText}
          onChange={(event) =>
            commit(event.target.value, valueColumnsText, variableColumn, valueColumn)
          }
        />
      </label>
      <label>
        <TermLabel ko="언피벗할 컬럼" en="Columns to unpivot" />
        <textarea
          data-testid="preparation-unpivot-values"
          disabled={!canWrite}
          rows={2}
          placeholder="sales_2024, sales_2025"
          value={valueColumnsText}
          onChange={(event) =>
            commit(idColumnsText, event.target.value, variableColumn, valueColumn)
          }
        />
      </label>
      <p className="muted" data-testid="preparation-unpivot-help">
        식별자나 언피벗 대상으로 지정하지 않은 컬럼은 결과에서 제외됩니다.
      </p>
      <label>
        <TermLabel ko="변수 컬럼" en="Variable column" />
        <input
          data-testid="preparation-unpivot-variable"
          disabled={!canWrite}
          value={variableColumn}
          onChange={(event) =>
            commit(idColumnsText, valueColumnsText, event.target.value, valueColumn)
          }
        />
      </label>
      <label>
        <TermLabel ko="값 컬럼" en="Value column" />
        <input
          data-testid="preparation-unpivot-value"
          disabled={!canWrite}
          value={valueColumn}
          onChange={(event) =>
            commit(idColumnsText, valueColumnsText, variableColumn, event.target.value)
          }
        />
      </label>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-unpivot-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function parsePivotValueDrafts(raw: unknown): PivotValueDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    if (!row || typeof row !== "object") {
      return { value: "", value_type: "string" as PivotValueType, output: "" };
    }
    const record = row as Record<string, unknown>;
    const rawValue = record.value;
    let valueType: PivotValueType = "string";
    if (record.value_type === "number" || record.value_type === "string") {
      valueType = record.value_type;
    } else if (typeof rawValue === "number") {
      valueType = "number";
    }
    return {
      value: rawValue == null ? "" : String(rawValue),
      value_type: valueType,
      output: String(record.output ?? ""),
    };
  });
}

function PivotInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const [indexColumnsText, setIndexColumnsText] = useState(() =>
    formatKeyList(config.index_columns),
  );
  const [columnsColumn, setColumnsColumn] = useState(() =>
    String(config.columns_column ?? ""),
  );
  const [valueColumn, setValueColumn] = useState(() => String(config.value_column ?? ""));
  const [aggregation, setAggregation] = useState(() =>
    String(config.aggregation ?? "sum").toLowerCase() || "sum",
  );
  const [pivotValues, setPivotValues] = useState<PivotValueDraft[]>(() =>
    parsePivotValueDrafts(config.pivot_values),
  );
  const [errors, setErrors] = useState<string[]>([]);

  function evaluateDraft(
    nextIndexText: string,
    nextColumnsColumn: string,
    nextValueColumn: string,
    nextAggregation: string,
    nextPivotValues: PivotValueDraft[],
  ) {
    return serializePivotConfig({
      indexColumns: parseKeyList(nextIndexText),
      columnsColumn: nextColumnsColumn,
      valueColumn: nextValueColumn,
      aggregation: nextAggregation,
      pivotValues: nextPivotValues,
    });
  }

  // Validate on mount so empty defaults gate Save/Validate/Preview/Run.
  useEffect(() => {
    const serialized = evaluateDraft(
      indexColumnsText,
      columnsColumn,
      valueColumn,
      aggregation,
      pivotValues,
    );
    setErrors(serialized.errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; commit() owns later updates
  }, []);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function commit(
    nextIndexText: string,
    nextColumnsColumn: string,
    nextValueColumn: string,
    nextAggregation: string,
    nextPivotValues: PivotValueDraft[],
  ) {
    setIndexColumnsText(nextIndexText);
    setColumnsColumn(nextColumnsColumn);
    setValueColumn(nextValueColumn);
    setAggregation(nextAggregation);
    setPivotValues(nextPivotValues);
    const serialized = evaluateDraft(
      nextIndexText,
      nextColumnsColumn,
      nextValueColumn,
      nextAggregation,
      nextPivotValues,
    );
    setErrors(serialized.errors);
    if (serialized.errors.length > 0) {
      return;
    }
    onChange({
      ...config,
      index_columns: serialized.index_columns,
      columns_column: serialized.columns_column,
      value_column: serialized.value_column,
      aggregation: serialized.aggregation,
      pivot_values: serialized.pivot_values,
    });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-pivot-inspector">
      <label>
        <TermLabel ko="인덱스 컬럼" en="Index columns" help={UI_HELP.preparationPivot} />
        <textarea
          data-testid="preparation-pivot-index"
          disabled={!canWrite}
          rows={2}
          placeholder="customer_id, region"
          value={indexColumnsText}
          onChange={(event) =>
            commit(
              event.target.value,
              columnsColumn,
              valueColumn,
              aggregation,
              pivotValues,
            )
          }
        />
      </label>
      <label>
        <TermLabel ko="피벗 컬럼" en="Pivot column" />
        <input
          data-testid="preparation-pivot-columns-column"
          disabled={!canWrite}
          placeholder="month"
          value={columnsColumn}
          onChange={(event) =>
            commit(
              indexColumnsText,
              event.target.value,
              valueColumn,
              aggregation,
              pivotValues,
            )
          }
        />
      </label>
      <label>
        <TermLabel ko="값 컬럼" en="Value column" />
        <input
          data-testid="preparation-pivot-value-column"
          disabled={!canWrite}
          placeholder="sales"
          value={valueColumn}
          onChange={(event) =>
            commit(
              indexColumnsText,
              columnsColumn,
              event.target.value,
              aggregation,
              pivotValues,
            )
          }
        />
      </label>
      <label>
        <TermLabel ko="집계" en="Aggregation" />
        <select
          data-testid="preparation-pivot-aggregation"
          disabled={!canWrite}
          value={aggregation}
          onChange={(event) =>
            commit(
              indexColumnsText,
              columnsColumn,
              valueColumn,
              event.target.value,
              pivotValues,
            )
          }
        >
          <option value="sum">SUM</option>
          <option value="avg">AVG</option>
          <option value="min">MIN</option>
          <option value="max">MAX</option>
          <option value="count">COUNT</option>
        </select>
      </label>
      <div className="preparation-inspector-list" data-testid="preparation-pivot-values">
        <span className="eyebrow">피벗 값</span>
        {pivotValues.map((row, index) => (
          <div
            key={`pivot-value-${index}`}
            className="preparation-inspector-row"
            data-testid={`preparation-pivot-value-row-${index}`}
          >
            <select
              data-testid={`preparation-pivot-value-type-${index}`}
              disabled={!canWrite}
              value={row.value_type}
              onChange={(event) => {
                const next = [...pivotValues];
                next[index] = {
                  ...row,
                  value_type: event.target.value === "number" ? "number" : "string",
                };
                commit(indexColumnsText, columnsColumn, valueColumn, aggregation, next);
              }}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
            </select>
            <input
              data-testid={`preparation-pivot-value-input-${index}`}
              disabled={!canWrite}
              placeholder="jan"
              value={row.value}
              onChange={(event) => {
                const next = [...pivotValues];
                next[index] = { ...row, value: event.target.value };
                commit(indexColumnsText, columnsColumn, valueColumn, aggregation, next);
              }}
            />
            <input
              data-testid={`preparation-pivot-value-output-${index}`}
              disabled={!canWrite}
              placeholder="sales_jan"
              value={row.output}
              onChange={(event) => {
                const next = [...pivotValues];
                next[index] = { ...row, output: event.target.value };
                commit(indexColumnsText, columnsColumn, valueColumn, aggregation, next);
              }}
            />
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-pivot-value-remove-${index}`}
                onClick={() => {
                  const next = pivotValues.filter((_, rowIndex) => rowIndex !== index);
                  commit(indexColumnsText, columnsColumn, valueColumn, aggregation, next);
                }}
              >
                제거
              </button>
            )}
          </div>
        ))}
        {canWrite && (
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-pivot-value-add"
            onClick={() =>
              commit(indexColumnsText, columnsColumn, valueColumn, aggregation, [
                ...pivotValues,
                { value: "", value_type: "string", output: "" },
              ])
            }
          >
            피벗 값 추가
          </button>
        )}
      </div>
      <p className="muted" data-testid="preparation-pivot-help">
        설정한 피벗 값만 출력 컬럼이 되고, 그 외 값이나 null은 무시됩니다.
      </p>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-pivot-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LagInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const [timeColumn, setTimeColumn] = useState(() => String(config.time_column ?? ""));
  const [sourceColumn, setSourceColumn] = useState(() => String(config.source_column ?? ""));
  const [lags, setLags] = useState<LagDraftRow[]>(() => parseLagDrafts(config.lags));
  const [errors, setErrors] = useState<string[]>([]);

  function evaluateDraft(
    nextTimeColumn: string,
    nextSourceColumn: string,
    nextLags: LagDraftRow[],
  ) {
    return serializeLagConfig({
      timeColumn: nextTimeColumn,
      sourceColumn: nextSourceColumn,
      lags: nextLags,
    });
  }

  useEffect(() => {
    const serialized = evaluateDraft(timeColumn, sourceColumn, lags);
    setErrors(serialized.errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; commit() owns later updates
  }, []);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function commit(
    nextTimeColumn: string,
    nextSourceColumn: string,
    nextLags: LagDraftRow[],
  ) {
    setTimeColumn(nextTimeColumn);
    setSourceColumn(nextSourceColumn);
    setLags(nextLags);
    const serialized = evaluateDraft(nextTimeColumn, nextSourceColumn, nextLags);
    setErrors(serialized.errors);
    if (serialized.errors.length > 0) {
      return;
    }
    onChange({
      ...config,
      time_column: serialized.time_column,
      source_column: serialized.source_column,
      lags: serialized.lags,
    });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-lag-inspector">
      <p className="muted preparation-inspector-hint" data-testid="preparation-lag-hint">
        시간 순으로 정렬한 뒤, 이전 행의 값을 새 컬럼으로 만듭니다. 이전 행 수는 시간 단위가
        아닙니다.
        <HelpTip text={UI_HELP.preparationLag} />
      </p>
      <label>
        <TermLabel
          ko="정렬 기준 시간 컬럼"
          en="Time column"
          help={UI_HELP.preparationLag}
        />
        <input
          data-testid="preparation-lag-time-column"
          disabled={!canWrite}
          placeholder="예: JOIN_TIME"
          value={timeColumn}
          onChange={(event) => commit(event.target.value, sourceColumn, lags)}
        />
        <small>데이터를 정렬할 시간 컬럼입니다. 입력 데이터에 있는 이름을 정확히 적으세요.</small>
      </label>
      <label>
        <TermLabel ko="이전 값을 가져올 컬럼" en="Source column" help={UI_HELP.preparationLag} />
        <input
          data-testid="preparation-lag-source-column"
          disabled={!canWrite}
          placeholder="예: HTDND_AMNT"
          value={sourceColumn}
          onChange={(event) => commit(timeColumn, event.target.value, lags)}
        />
        <small>이전 행에서 값을 가져올 원본 컬럼입니다. 시간 컬럼과 달라야 합니다.</small>
      </label>
      <div className="preparation-inspector-list" data-testid="preparation-lag-rows">
        <span className="eyebrow">이전값 생성 목록</span>
        {lags.map((row, index) => (
          <div
            key={`lag-row-${index}`}
            className="preparation-inspector-row preparation-lag-row"
            data-testid={`preparation-lag-row-${index}`}
          >
            <label>
              <TermLabel ko="이전 행 수" en="Periods" />
              <input
                data-testid={`preparation-lag-periods-${index}`}
                disabled={!canWrite}
                placeholder="예: 24"
                value={row.periods}
                onChange={(event) => {
                  const next = [...lags];
                  next[index] = { ...row, periods: event.target.value };
                  commit(timeColumn, sourceColumn, next);
                }}
              />
              <small>정렬된 데이터의 몇 행 이전 값을 가져올지 지정합니다. 시간(시·분)이 아닙니다.</small>
            </label>
            <label>
              <TermLabel ko="새 컬럼 이름" en="Output column" />
              <input
                data-testid={`preparation-lag-output-${index}`}
                disabled={!canWrite}
                placeholder="예: HTDND_LAG_24"
                value={row.output}
                onChange={(event) => {
                  const next = [...lags];
                  next[index] = { ...row, output: event.target.value };
                  commit(timeColumn, sourceColumn, next);
                }}
              />
              <small>결과를 저장할 새 컬럼 이름입니다.</small>
            </label>
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-lag-remove-${index}`}
                onClick={() =>
                  commit(
                    timeColumn,
                    sourceColumn,
                    lags.filter((_, i) => i !== index),
                  )
                }
              >
                제거
              </button>
            )}
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-lag-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-lag-add"
          onClick={() =>
            commit(timeColumn, sourceColumn, [...lags, { periods: "", output: "" }])
          }
        >
          이전값 추가
        </button>
      )}
      <p className="muted" data-testid="preparation-lag-help">
        HTDND_LAG_24는 시간순으로 정렬했을 때 24행 앞에 있던 HTDND_AMNT 값을 저장하는 새
        컬럼입니다. 24를 입력해도 24시간 전이 항상 보장되지는 않으며, 이전 행이 부족한 앞쪽 행은
        결측값으로 남습니다.
      </p>
    </div>
  );
}

function RollingWindowInspector({
  config,
  canWrite,
  onChange,
  onValidationChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
  onValidationChange?: (errors: string[]) => void;
}) {
  const [timeColumn, setTimeColumn] = useState(() => String(config.time_column ?? ""));
  const [sourceColumn, setSourceColumn] = useState(() => String(config.source_column ?? ""));
  const [windows, setWindows] = useState<RollingWindowDraftRow[]>(() =>
    parseRollingWindowDrafts(config.windows),
  );
  const [errors, setErrors] = useState<string[]>([]);

  function evaluateDraft(
    nextTimeColumn: string,
    nextSourceColumn: string,
    nextWindows: RollingWindowDraftRow[],
  ) {
    return serializeRollingWindowConfig({
      timeColumn: nextTimeColumn,
      sourceColumn: nextSourceColumn,
      windows: nextWindows,
    });
  }

  useEffect(() => {
    const serialized = evaluateDraft(timeColumn, sourceColumn, windows);
    setErrors(serialized.errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; commit() owns later updates
  }, []);

  useEffect(() => {
    onValidationChange?.(errors);
  }, [errors, onValidationChange]);

  function commit(
    nextTimeColumn: string,
    nextSourceColumn: string,
    nextWindows: RollingWindowDraftRow[],
  ) {
    setTimeColumn(nextTimeColumn);
    setSourceColumn(nextSourceColumn);
    setWindows(nextWindows);
    const serialized = evaluateDraft(nextTimeColumn, nextSourceColumn, nextWindows);
    setErrors(serialized.errors);
    if (serialized.errors.length > 0) {
      return;
    }
    onChange({
      ...config,
      time_column: serialized.time_column,
      source_column: serialized.source_column,
      windows: serialized.windows,
    });
  }

  return (
    <div
      className="preparation-inspector-form"
      data-testid="preparation-rolling-inspector"
    >
      <label>
        <TermLabel ko="시간 컬럼" en="Time column" help={UI_HELP.preparationRollingWindow} />
        <input
          data-testid="preparation-rolling-time-column"
          disabled={!canWrite}
          placeholder="event_time"
          value={timeColumn}
          onChange={(event) => commit(event.target.value, sourceColumn, windows)}
        />
      </label>
      <label>
        <TermLabel ko="소스 컬럼" en="Source column" />
        <input
          data-testid="preparation-rolling-source-column"
          disabled={!canWrite}
          placeholder="sales"
          value={sourceColumn}
          onChange={(event) => commit(timeColumn, event.target.value, windows)}
        />
      </label>
      <div className="preparation-inspector-list" data-testid="preparation-rolling-rows">
        <span className="eyebrow">윈도우 행</span>
        {windows.map((row, index) => (
          <div
            key={`rolling-row-${index}`}
            className="preparation-inspector-row"
            data-testid={`preparation-rolling-row-${index}`}
          >
            <input
              data-testid={`preparation-rolling-window-${index}`}
              disabled={!canWrite}
              placeholder="window size"
              value={row.window}
              onChange={(event) => {
                const next = [...windows];
                next[index] = { ...row, window: event.target.value };
                commit(timeColumn, sourceColumn, next);
              }}
            />
            <select
              data-testid={`preparation-rolling-aggregation-${index}`}
              disabled={!canWrite}
              value={row.aggregation}
              onChange={(event) => {
                const next = [...windows];
                next[index] = { ...row, aggregation: event.target.value };
                commit(timeColumn, sourceColumn, next);
              }}
            >
              {ROLLING_AGGREGATIONS.map((op) => (
                <option key={op} value={op}>
                  {op.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              data-testid={`preparation-rolling-output-${index}`}
              disabled={!canWrite}
              placeholder="output column"
              value={row.output}
              onChange={(event) => {
                const next = [...windows];
                next[index] = { ...row, output: event.target.value };
                commit(timeColumn, sourceColumn, next);
              }}
            />
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-rolling-remove-${index}`}
                onClick={() =>
                  commit(
                    timeColumn,
                    sourceColumn,
                    windows.filter((_, i) => i !== index),
                  )
                }
              >
                제거
              </button>
            )}
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <ul className="preparation-inspector-errors" data-testid="preparation-rolling-errors">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-rolling-add"
          onClick={() =>
            commit(timeColumn, sourceColumn, [
              ...windows,
              { window: "", aggregation: "avg", output: "" },
            ])
          }
        >
          윈도우 추가
        </button>
      )}
      <p className="muted" data-testid="preparation-rolling-help">
        이동 집계는 과거 행만 사용하며 현재 행은 포함하지 않습니다. 창이 부족한 행은 null로
        남습니다.
      </p>
    </div>
  );
}
