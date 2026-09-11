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
import { ErrorNotice, Loading, StatusBadge, SuccessNotice, formatDate } from "../components";
import {
  CAST_TYPES,
  DERIVED_OPERATIONS,
  FILTER_NULLARY_OPS,
  FILTER_OPERATORS,
  PREPARATION_FLOW_NODE_TYPE,
  PREPARATION_NODE_LIBRARY_GROUPS,
  apiGraphToFlow,
  defaultConfigForPreparation,
  flowToApiGraph,
  formatKeyList,
  formatRenameMapping,
  isPreparationRunActive,
  labelForPreparationType,
  nextPreparationNodeId,
  parseCasts,
  parseDerivedOperand,
  parseFillValues,
  parseFilterConditions,
  parseKeyList,
  parseRenameMapping,
  preparationConfigSummary,
  serializeCasts,
  serializeFillValues,
  serializeFilterConditions,
  sourceDatasetIdsInGraph,
  staggerPreparationPosition,
  type DerivedOperand,
  type FillValueRow,
  type FilterCondition,
  type PreparationFlowEdge,
  type PreparationFlowNode,
} from "../preparationHelpers";
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
  const [dirty, setDirty] = useState(false);
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
  const [preview, setPreview] = useState<DatasetPreparationPreviewResult | null>(null);
  const previewSeqRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canWrite = userCanProject(
    user,
    selectedProject,
    "DATA_SCIENTIST",
    "ML_ENGINEER",
    "PROJECT_ADMIN",
  );

  const clearPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewSeqRef.current += 1;
    setPreview(null);
    // Graph edits abort in-flight preview; unlock actions even though the
    // aborted request's finally must not clear a newer preview's busy state.
    setBusy((prev) => (prev === "preview" ? "" : prev));
  }, []);

  const markGraphEdited = useCallback(() => {
    setDirty(true);
    setValidation(null);
    clearPreview();
  }, [clearPreview]);

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
      setPreparation(row);
      setNodes(toPrepNodes(flow.nodes));
      setEdges(toPrepEdges(flow.edges));
      setDatasets(datasetRows);
      setPrepVersions(versionRows);
      setRuns(runRows);
      setDirty(false);
      setValidation(null);
      setPreview(null);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preparation could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [preparationId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

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
  }

  function updateSelectedConfig(next: Record<string, unknown>) {
    if (!canWrite || !selectedId) return;
    markGraphEdited();
    setNodes((rows) =>
      rows.map((node) =>
        node.id === selectedId ? { ...node, data: { ...node.data, config: next } } : node,
      ),
    );
  }

  function addNodeOfType(nodeType: DatasetPreparationNodeType) {
    if (!canWrite) return;
    const id = nextPreparationNodeId(
      nodeType,
      nodes.map((node) => node.id),
    );
    const node: PrepNode = {
      id,
      type: PREPARATION_FLOW_NODE_TYPE,
      position: staggerPreparationPosition(nodes.length),
      data: {
        label: labelForPreparationType(nodeType),
        node_type: nodeType,
        config: defaultConfigForPreparation(nodeType),
      },
    };
    setNodes((rows) => [...rows, node]);
    setSelectedId(id);
    markGraphEdited();
  }

  function removeSelected() {
    if (!canWrite || !selectedId) return;
    setNodes((rows) => rows.filter((node) => node.id !== selectedId));
    setEdges((rows) =>
      rows.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
    );
    setSelectedId("");
    markGraphEdited();
  }

  const onNodesChange = useCallback(
    (changes: NodeChange<PrepNode>[]) => {
      if (!canWrite) {
        const safe = changes.filter(
          (change) => change.type === "select" || change.type === "dimensions",
        );
        if (safe.length) setNodes((rows) => applyNodeChanges(safe, rows));
        return;
      }
      const marksDirty = changes.some(
        (change) =>
          change.type === "remove" ||
          change.type === "add" ||
          (change.type === "position" && change.dragging === false),
      );
      if (marksDirty) markGraphEdited();
      setNodes((rows) => applyNodeChanges(changes, rows));
    },
    [canWrite, markGraphEdited],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!canWrite) {
        const safe = changes.filter((change) => change.type === "select");
        if (safe.length) setEdges((rows) => applyEdgeChanges(safe, rows));
        return;
      }
      if (changes.some((change) => change.type === "remove" || change.type === "add")) {
        markGraphEdited();
      }
      setEdges((rows) => applyEdgeChanges(changes, rows));
    },
    [canWrite, markGraphEdited],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!canWrite) return;
      const targetNode = nodes.find((node) => node.id === connection.target);
      let targetHandle = connection.targetHandle;
      if (targetNode?.data.node_type === "join") {
        if (targetHandle !== "left" && targetHandle !== "right") {
          const used = new Set(
            edges
              .filter((edge) => edge.target === connection.target)
              .map((edge) => edge.targetHandle),
          );
          targetHandle = !used.has("left") ? "left" : "right";
        }
      } else {
        targetHandle = null;
      }
      markGraphEdited();
      setEdges((rows) =>
        addEdge(
          {
            ...connection,
            targetHandle,
            ...(targetHandle
              ? { label: String(targetHandle).toUpperCase() }
              : { label: undefined }),
            id: `edge-${connection.source}-${connection.target}-${targetHandle || "in"}-${rows.length + 1}`,
          },
          rows,
        ),
      );
    },
    [canWrite, edges, markGraphEdited, nodes],
  );

  async function saveVersion() {
    if (!canWrite) return;
    setBusy("save");
    setError("");
    setSuccess("");
    try {
      const graph = currentGraph();
      const version = await api<DatasetPreparationVersion>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/versions`,
        { method: "POST", body: JSON.stringify({ graph }) },
      );
      setDirty(false);
      setSuccess("Version saved.");
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
      setError(reason instanceof Error ? reason.message : "Version could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function runValidate() {
    setBusy("validate");
    setError("");
    try {
      const result = await api<DatasetPreparationValidationResult>(
        `/projects/${projectId}/dataset-preparations/${preparationId}/validate`,
        { method: "POST", body: JSON.stringify({ graph: currentGraph() }) },
      );
      setValidation(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Validation failed.");
    } finally {
      setBusy("");
    }
  }

  async function runPreview() {
    setBusy("preview");
    setError("");
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
      setPreview(result);
    } catch (reason) {
      if (controller.signal.aborted || previewAbortRef.current !== controller) return;
      setError(reason instanceof Error ? reason.message : "Preview failed.");
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
          ? "Output dataset cleared."
          : "Output dataset updated.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Output dataset could not be updated.",
      );
    } finally {
      setBusy("");
    }
  }

  async function createOutputDataset() {
    if (!canWrite) return;
    const name = newOutputName.trim();
    if (!name) {
      setError("Dataset name is required.");
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
      setSuccess(`Output dataset “${result.output_dataset.name}” created.`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Output dataset could not be created.",
      );
    } finally {
      setBusy("");
    }
  }

  async function runPreparation() {
    if (!canWrite || !preparation) return;
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
      setSuccess("Preparation run queued.");
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preparation run failed to start.");
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
      setSuccess(`Run #${runId} queued.`);
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Run could not be executed.");
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
      setError(reason instanceof Error ? reason.message : "Run details could not be loaded.");
    }
  }

  function onBack(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    if (!window.confirm("You have unsaved changes. Leave without saving?")) {
      event.preventDefault();
    }
  }

  const runDisabledReason = dirty
    ? "Save first"
    : preparation?.output_dataset_id == null
      ? "Configure an output dataset before running"
      : busy
        ? "Busy"
        : "";
  const runDisabled = Boolean(runDisabledReason) || !canWrite;

  if (loading) return <Loading label="Loading preparation" />;
  if (!preparation) {
    return (
      <div>
        <ErrorNotice message={error || "Preparation not found."} />
        <Link to={`/projects/${projectId}/preparations`}>Back to preparations</Link>
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
            ← Preparations
          </Link>
          <div>
            <span className="eyebrow">Dataset preparation</span>
            <h1>{preparation.name}</h1>
            <p className="muted">
              {preparation.description || "Visual dataset preparation graph."} · v
              {preparation.latest_version}
              {dirty ? " · Unsaved changes" : ""}
            </p>
          </div>
        </div>
        <div className="preparation-builder-header-actions">
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-validate"
            disabled={busy !== ""}
            onClick={() => void runValidate()}
          >
            {busy === "validate" ? "Validating…" : "Validate"}
          </button>
          <button
            type="button"
            className="btn secondary"
            data-testid="preparation-preview"
            disabled={busy !== ""}
            onClick={() => void runPreview()}
          >
            {busy === "preview" ? "Previewing…" : "Preview"}
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn"
                data-testid="preparation-save-version"
                disabled={busy !== ""}
                onClick={() => void saveVersion()}
              >
                {busy === "save" ? "Saving…" : "Save version"}
              </button>
              <button
                type="button"
                className="btn"
                data-testid="preparation-run"
                disabled={runDisabled || busy !== ""}
                title={runDisabledReason || undefined}
                onClick={() => void runPreparation()}
              >
                {busy === "run" ? "Starting…" : "Run preparation"}
              </button>
            </>
          )}
        </div>
      </header>
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {dirty && (
        <p className="form-hint" data-testid="preparation-dirty-hint">
          Save a version to keep your graph. Changes are not auto-saved.
        </p>
      )}
      {successRun && String(successRun.status).toLowerCase() === "succeeded" && (
        <div
          className="preparation-success-cta panel"
          data-testid="preparation-success-cta"
          role="status"
        >
          <div>
            <span className="eyebrow">Preparation succeeded</span>
            <h2>
              Output Dataset
              {(() => {
                const dataset =
                  successRun.output_dataset_id == null
                    ? null
                    : datasets.find((row) => row.id === successRun.output_dataset_id);
                if (!dataset) {
                  return successRun.output_dataset_id != null
                    ? ` · #${successRun.output_dataset_id}`
                    : "";
                }
                const versionLabel =
                  dataset.latest_version > 0 ? ` · v${dataset.latest_version}` : "";
                return ` · ${dataset.name}${versionLabel}`;
              })()}
            </h2>
          </div>
          {successRun.output_dataset_id != null && (
            <Link
              className="btn"
              to={`/projects/${projectId}/datasets/${successRun.output_dataset_id}`}
              data-testid="preparation-open-output-dataset"
            >
              Open dataset
            </Link>
          )}
        </div>
      )}

      <div
        className={`builder-layout-3zone${!canWrite ? " is-readonly" : ""}`}
        data-testid="preparation-builder-layout"
        data-readonly={canWrite ? "false" : "true"}
      >
        {canWrite && (
          <aside className="preparation-node-library panel">
            <span className="eyebrow">Node library</span>
            <p className="form-hint">Click a node type to add it to the canvas.</p>
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
          aria-label="Preparation graph"
          data-testid="preparation-canvas"
        >
          {nodes.length === 0 ? (
            <div className="preparation-empty-canvas">
              {canWrite ? (
                <>
                  <h2>Start with a source</h2>
                  <p className="muted">
                    Add dataset sources, then transform, join, or union them into a single
                    output.
                  </p>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => addNodeOfType("source")}
                    data-testid="preparation-add-source-empty"
                  >
                    Add Source
                  </button>
                </>
              ) : (
                <>
                  <h2>This preparation version contains no nodes.</h2>
                  <p className="muted">There is nothing to inspect on this empty graph.</p>
                </>
              )}
            </div>
          ) : (
            <ReactFlow
              nodes={nodes.map((node) => ({
                ...node,
                selected: node.id === selectedId,
              }))}
              edges={edges}
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
              fitView
            >
              <Background />
              <MiniMap />
              <Controls />
            </ReactFlow>
          )}
        </div>

        <aside className="preparation-inspector panel" data-testid="preparation-inspector">
          {!selectedNode ? (
            <>
              <span className="eyebrow">Preparation</span>
              <h2>{preparation.name}</h2>
              <p className="muted">{preparation.description || "No description yet."}</p>
              <dl className="preparation-inspector-meta">
                <div>
                  <dt>Version</dt>
                  <dd>v{preparation.latest_version}</dd>
                </div>
                <div>
                  <dt>Nodes</dt>
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
                  ? "Select a node on the canvas to configure it, or add one from the node library."
                  : "Select a node on the canvas to inspect its configuration."}
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">Node</span>
              <h2>{selectedNode.data.label}</h2>
              <p className="form-hint" data-testid="preparation-node-type">
                Type: {labelForPreparationType(selectedNode.data.node_type)}
              </p>
              <small className="muted" data-testid="preparation-node-id">
                Node id: {selectedNode.id}
              </small>
              <hr />
              <span className="eyebrow">Configuration</span>
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
                  label="Columns to keep"
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
                  label="Columns to drop"
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
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "cast" && (
                <CastInspector
                  key={selectedNode.id}
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
                  key={selectedNode.id}
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "derived_column" && (
                <DerivedInspector
                  config={selectedNode.data.config}
                  canWrite={canWrite}
                  onChange={updateSelectedConfig}
                />
              )}
              {selectedNode.data.node_type === "output" && (
                <p className="muted" data-testid="preparation-output-readonly">
                  Output marks the prepared result. Connect exactly one upstream node. No
                  additional configuration is required.
                </p>
              )}
              {canWrite && (
                <>
                  <hr />
                  <span className="eyebrow">Danger</span>
                  <button
                    className="btn link danger-text"
                    type="button"
                    data-testid="preparation-remove-node"
                    onClick={removeSelected}
                  >
                    Remove node
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
            <span className="eyebrow">Runs</span>
            <h2>Run history</h2>
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="muted" data-testid="preparation-run-history-empty">
            No preparation runs yet.
          </p>
        ) : (
          <div className="preparation-run-table-wrap">
            <table data-testid="preparation-run-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Recipe version</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Output</th>
                  <th>Actions</th>
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
                          <button
                            type="button"
                            className="btn link"
                            data-testid={`preparation-run-expand-${run.id}`}
                            onClick={() => void expandRun(run.id)}
                          >
                            #{run.id}
                          </button>
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
                              Execute
                            </button>
                          )}
                          {status === "succeeded" && run.output_dataset_id != null && (
                            <Link
                              className="btn link"
                              to={`/projects/${projectId}/datasets/${run.output_dataset_id}`}
                              data-testid={`preparation-run-open-${run.id}`}
                            >
                              Open dataset
                            </Link>
                          )}
                          {status === "failed" && (
                            <button
                              type="button"
                              className="btn link"
                              data-testid={`preparation-run-show-error-${run.id}`}
                              onClick={() => void expandRun(run.id)}
                            >
                              Show error
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
            Current output dataset: {outputDataset.name} (#{outputDataset.id})
          </p>
        )}
      </section>

      {(validation || preview) && (
        <section className="preparation-results panel" data-testid="preparation-results">
          {validation && (
            <div className="preparation-validation" data-testid="preparation-validation">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Validation</span>
                  <h2>
                    {validation.valid
                      ? "Graph is valid"
                      : `${validation.errors.length} issue${validation.errors.length === 1 ? "" : "s"}`}
                  </h2>
                </div>
              </div>
              {validation.valid ? (
                <p className="muted">Validation passed.</p>
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
            <div className="preparation-preview" data-testid="preparation-preview-panel">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Preview</span>
                  <h2>
                    {preview.node_id ? `Node ${preview.node_id}` : "Preview"} ·{" "}
                    {preview.row_count} row{preview.row_count === 1 ? "" : "s"}
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
                        "Preview uses stored DatasetVersion sample rows and may not represent the full dataset.",
                      ]
                  ).map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                </div>
              )}
              <div className="preparation-preview-table-wrap">
                {preview.columns.length === 0 ? (
                  <p className="muted">No columns in preview result.</p>
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
      <span className="eyebrow">Output dataset</span>
      {!configured && (
        <p className="muted" data-testid="preparation-output-empty">
          No output dataset configured.
        </p>
      )}
      {!configured && (
        <p className="form-hint">
          Choose an existing dataset or create a new one before running.
        </p>
      )}
      <label>
        Existing dataset
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
          <option value="">Select dataset…</option>
          {datasets.map((dataset) => {
            const usedAsSource = usedSourceDatasetIds.has(dataset.id);
            return (
              <option
                key={dataset.id}
                value={dataset.id}
                disabled={usedAsSource}
              >
                {dataset.name}
                {usedAsSource ? " (used as source)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {canWrite && usedSourceDatasetIds.size > 0 && (
        <p className="form-hint" data-testid="preparation-output-source-warn">
          Datasets used as graph sources are disabled to avoid writing over inputs.
        </p>
      )}
      {canWrite && (
        <div className="preparation-output-create" data-testid="preparation-output-create">
          <span className="eyebrow">Create new</span>
          <label>
            Name
            <input
              data-testid="preparation-output-name"
              value={newOutputName}
              disabled={busy.startsWith("output")}
              onChange={(event) => onNewOutputName(event.target.value)}
              placeholder="prepared-iris"
            />
          </label>
          <label>
            Description
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
            {busy === "output-create" ? "Creating…" : "Create output dataset"}
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
          <strong>Inputs</strong>
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
        <p className="muted">No logs yet.</p>
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
        Dataset
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
          <option value="">Select dataset…</option>
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Version strategy
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
          <option value="latest">Latest</option>
          <option value="fixed">Fixed</option>
        </select>
      </label>
      {strategy === "fixed" && (
        <label>
          Dataset version
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
            <option value="">Select version…</option>
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
        <span className="preparation-known-columns-label">Known columns</span>
        {!knownColumnsReady ? (
          <p className="muted preparation-known-columns-empty">
            Select a dataset/version to inspect columns.
          </p>
        ) : !knownColumns || knownColumns.length === 0 ? (
          <p className="muted preparation-known-columns-empty">No columns available.</p>
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

function JoinInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="preparation-inspector-form" data-testid="preparation-join-inspector">
      <p className="muted preparation-inspector-hint" data-testid="preparation-join-hint">
        Connect one edge to LEFT and one edge to RIGHT.
      </p>
      <label>
        How
        <select
          data-testid="preparation-join-how"
          disabled={!canWrite}
          value={String(config.how || "inner")}
          onChange={(event) => onChange({ ...config, how: event.target.value })}
        >
          <option value="inner">inner</option>
          <option value="left">left</option>
          <option value="right">right</option>
          <option value="full">full</option>
        </select>
      </label>
      <label>
        Left keys
        <input
          data-testid="preparation-join-left-on"
          disabled={!canWrite}
          value={formatKeyList(config.left_on)}
          placeholder="id, customer_id"
          onChange={(event) =>
            onChange({ ...config, left_on: parseKeyList(event.target.value) })
          }
        />
        <small>Comma-separated column names from the left input.</small>
      </label>
      <label>
        Right keys
        <input
          data-testid="preparation-join-right-on"
          disabled={!canWrite}
          value={formatKeyList(config.right_on)}
          placeholder="id, customer_id"
          onChange={(event) =>
            onChange({ ...config, right_on: parseKeyList(event.target.value) })
          }
        />
        <small>Comma-separated column names from the right input.</small>
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
        Mode
        <select
          data-testid="preparation-union-mode"
          disabled={!canWrite}
          value={mode}
          onChange={(event) => onChange({ ...config, mode: event.target.value })}
        >
          <option value="strict">strict</option>
          <option value="align_by_name">align_by_name</option>
        </select>
      </label>
      <p className="muted preparation-inspector-hint" data-testid="preparation-union-hint">
        {mode === "align_by_name"
          ? "Matches columns by name and fills missing values with null."
          : "Requires identical column names and order."}
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
        <small>Comma-separated column names.</small>
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
        Renames
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
        <small>One mapping per line: old = new</small>
      </label>
    </div>
  );
}

function FilterInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const combine = config.combine === "or" ? "or" : "and";
  const conditions = parseFilterConditions(config.conditions);

  function commit(nextConditions: FilterCondition[], nextCombine = combine) {
    onChange({
      ...config,
      ...serializeFilterConditions(nextConditions, nextCombine),
    });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-filter-inspector">
      <label>
        Combine
        <select
          data-testid="preparation-filter-combine"
          disabled={!canWrite}
          value={combine}
          onChange={(event) =>
            commit(conditions, event.target.value === "or" ? "or" : "and")
          }
        >
          <option value="and">and</option>
          <option value="or">or</option>
        </select>
      </label>
      <div className="preparation-filter-rows">
        {conditions.map((condition, index) => {
          const nullary = FILTER_NULLARY_OPS.has(condition.operator);
          return (
            <div
              key={index}
              className="preparation-filter-row"
              data-testid={`preparation-filter-row-${index}`}
            >
              <input
                data-testid={`preparation-filter-column-${index}`}
                disabled={!canWrite}
                placeholder="column"
                value={condition.column}
                onChange={(event) => {
                  const next = [...conditions];
                  next[index] = { ...condition, column: event.target.value };
                  commit(next);
                }}
              />
              <select
                data-testid={`preparation-filter-operator-${index}`}
                disabled={!canWrite}
                value={condition.operator}
                onChange={(event) => {
                  const next = [...conditions];
                  next[index] = { ...condition, operator: event.target.value };
                  commit(next);
                }}
              >
                {FILTER_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
              {!nullary && (
                <input
                  data-testid={`preparation-filter-value-${index}`}
                  disabled={!canWrite}
                  placeholder={condition.operator === "in" ? "a, b, c" : "value"}
                  value={
                    Array.isArray(condition.value)
                      ? condition.value.map(String).join(", ")
                      : String(condition.value ?? "")
                  }
                  onChange={(event) => {
                    const next = [...conditions];
                    next[index] = { ...condition, value: event.target.value };
                    commit(next);
                  }}
                />
              )}
              {canWrite && (
                <button
                  type="button"
                  className="btn link danger-text"
                  data-testid={`preparation-filter-remove-${index}`}
                  onClick={() => commit(conditions.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-filter-add"
          onClick={() =>
            commit([...conditions, { column: "", operator: "eq", value: "" }])
          }
        >
          Add condition
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
              placeholder="column"
              value={row.column}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, column: event.target.value };
                commit(next);
              }}
            />
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
                  {dtype}
                </option>
              ))}
            </select>
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-cast-remove-${index}`}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                Remove
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
          Add cast
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
        Key columns
        <input
          data-testid="preparation-deduplicate-columns"
          disabled={!canWrite}
          value={formatKeyList(config.columns)}
          placeholder="Leave empty to use all columns"
          onChange={(event) =>
            onChange({ ...config, columns: parseKeyList(event.target.value) })
          }
        />
        <small>Comma-separated. Empty means all columns.</small>
      </label>
      <label>
        Keep
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
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [rows, setRows] = useState(() => parseFillValues(config.values));

  function commit(nextRows: FillValueRow[]) {
    setRows(nextRows);
    onChange({ ...config, values: serializeFillValues(nextRows) });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-fill-inspector">
      <div className="preparation-fill-rows">
        {rows.map((row, index) => (
          <div
            key={index}
            className="preparation-fill-row"
            data-testid={`preparation-fill-row-${index}`}
          >
            <input
              data-testid={`preparation-fill-column-${index}`}
              disabled={!canWrite}
              placeholder="column"
              value={row.column}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, column: event.target.value };
                commit(next);
              }}
            />
            <select
              data-testid={`preparation-fill-kind-${index}`}
              disabled={!canWrite}
              value={row.kind}
              onChange={(event) => {
                const next = [...rows];
                next[index] = {
                  ...row,
                  kind: event.target.value as FillValueRow["kind"],
                };
                commit(next);
              }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
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
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                data-testid={`preparation-fill-value-${index}`}
                disabled={!canWrite}
                placeholder="value"
                value={row.value}
                onChange={(event) => {
                  const next = [...rows];
                  next[index] = { ...row, value: event.target.value };
                  commit(next);
                }}
              />
            )}
            {canWrite && (
              <button
                type="button"
                className="btn link danger-text"
                data-testid={`preparation-fill-remove-${index}`}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {canWrite && (
        <button
          type="button"
          className="btn secondary"
          data-testid="preparation-fill-add"
          onClick={() =>
            commit([...rows, { column: "", kind: "string", value: "" }])
          }
        >
          Add fill
        </button>
      )}
    </div>
  );
}

function DerivedInspector({
  config,
  canWrite,
  onChange,
}: {
  config: Record<string, unknown>;
  canWrite: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const left = parseDerivedOperand(config.left, { kind: "column", value: "" });
  const right = parseDerivedOperand(config.right, { kind: "literal", value: 0 });

  function updateOperand(side: "left" | "right", next: DerivedOperand) {
    onChange({ ...config, [side]: next });
  }

  return (
    <div className="preparation-inspector-form" data-testid="preparation-derived-inspector">
      <label>
        Column name
        <input
          data-testid="preparation-derived-name"
          disabled={!canWrite}
          value={String(config.name ?? "")}
          onChange={(event) => onChange({ ...config, name: event.target.value })}
        />
      </label>
      <label>
        Operation
        <select
          data-testid="preparation-derived-operation"
          disabled={!canWrite}
          value={String(config.operation || "add")}
          onChange={(event) => onChange({ ...config, operation: event.target.value })}
        >
          {DERIVED_OPERATIONS.map((operation) => (
            <option key={operation} value={operation}>
              {operation}
            </option>
          ))}
        </select>
      </label>
      <OperandFields
        label="Left"
        testIdPrefix="preparation-derived-left"
        operand={left}
        canWrite={canWrite}
        onChange={(next) => updateOperand("left", next)}
      />
      <OperandFields
        label="Right"
        testIdPrefix="preparation-derived-right"
        operand={right}
        canWrite={canWrite}
        onChange={(next) => updateOperand("right", next)}
      />
    </div>
  );
}

function OperandFields({
  label,
  testIdPrefix,
  operand,
  canWrite,
  onChange,
}: {
  label: string;
  testIdPrefix: string;
  operand: DerivedOperand;
  canWrite: boolean;
  onChange: (next: DerivedOperand) => void;
}) {
  return (
    <fieldset className="preparation-operand-fields">
      <legend>{label}</legend>
      <label>
        Kind
        <select
          data-testid={`${testIdPrefix}-kind`}
          disabled={!canWrite}
          value={operand.kind}
          onChange={(event) =>
            onChange({
              kind: event.target.value === "literal" ? "literal" : "column",
              value: event.target.value === "literal" ? 0 : "",
            })
          }
        >
          <option value="column">column</option>
          <option value="literal">literal</option>
        </select>
      </label>
      <label>
        Value
        <input
          data-testid={`${testIdPrefix}-value`}
          disabled={!canWrite}
          value={String(operand.value ?? "")}
          onChange={(event) => {
            if (operand.kind === "literal") {
              const raw = event.target.value;
              if (raw === "true" || raw === "false") {
                onChange({ kind: "literal", value: raw === "true" });
                return;
              }
              const asNumber = Number(raw);
              onChange({
                kind: "literal",
                value: raw !== "" && Number.isFinite(asNumber) ? asNumber : raw,
              });
              return;
            }
            onChange({ kind: "column", value: event.target.value });
          }}
        />
      </label>
    </fieldset>
  );
}
