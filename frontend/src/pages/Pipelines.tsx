import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
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
import { Link, useBeforeUnload, useNavigate, useParams } from "react-router-dom";
import {
  ApiRequestError,
  api,
  type Dataset,
  type DatasetVersion,
  type Pipeline,
  type PipelineCopilotDraftResponse,
  type PipelineCopilotPatchOperation,
  type PipelineCopilotPatchResponse,
  type PipelineGraph,
  type PipelineRun,
  type PipelineVersion,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  HelpTip,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  TermLabel,
  confirmAction,
  formatDate,
} from "../components";
import { Drawer } from "../Drawer";
import { centerFlowOnMiniMapNode, centerFlowOnMiniMapPoint } from "../flowMiniMapNav";
import { NodeConfigForm } from "../pipelineForms";
import {
  capturePipelineGraphSnapshot,
  createEmptyPipelineGraphHistory,
  pipelineGraphSnapshotsEqual,
  pushPipelineGraphHistory,
  redoPipelineGraphHistory,
  undoPipelineGraphHistory,
  type PipelineGraphHistoryState,
  type PipelineGraphSnapshot,
} from "../pipelineGraphHistory";
import {
  PIPELINE_NODE_LIBRARY,
  configSummary,
  defaultConfigFor,
  edgeBranch,
  filterNodeLibrary,
  labelForType,
  nextPipelineNodeId,
  nodeConfigWarnings,
  parseValidationIssue,
  pipelineNodeLibraryCategoryLabel,
  pipelineNodeTypeDescription,
  pipelineNodeTypeLabel,
  type ConditionBranch,
  type PipelineNodeType,
} from "../pipelineHelpers";
import { isEditableKeyboardTarget } from "../preparationGraphHistory";
import { userCanProject, useProject } from "../ProjectContext";
import { UI_HELP } from "../uiTerminology";
import { UNSAVED_CHANGES_MESSAGE } from "../unsavedChanges";

type StepData = {
  label: string;
  node_type: string;
  config: Record<string, unknown>;
  runStatus?: string;
};

type StepNode = Node<StepData>;

type ValidationResult = {
  valid: boolean;
  errors: string[];
  order?: string[];
};

const STEP_NODE_TYPE = "pipelineStep";
const CONDITION_HANDLES: ConditionBranch[] = ["true", "false", "always"];

function asConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toStepNodes(raw: PipelineGraph["nodes"] | undefined): StepNode[] {
  return (raw || []).map((node) => {
    const data = (node.data || {}) as Record<string, unknown>;
    const nodeType = String(data.node_type || "dataset_load");
    return {
      id: node.id,
      type: STEP_NODE_TYPE,
      position: node.position || { x: 0, y: 0 },
      data: {
        label: String(data.label || labelForType(nodeType)),
        node_type: nodeType,
        config: asConfig(data.config),
      },
      className: undefined,
    };
  });
}

function findUpstreamDatasetLoad(
  nodeId: string,
  nodes: StepNode[],
  edges: Edge[],
): StepNode | null {
  const visited = new Set<string>();
  const queue = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  while (queue.length) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const node = nodes.find((row) => row.id === currentId);
    if (!node) continue;
    if (node.data.node_type === "dataset_load") return node;
    for (const edge of edges) {
      if (edge.target === currentId) queue.push(edge.source);
    }
  }
  return null;
}

function extractHighlightedNodeIds(errors: string[], nodeIds: string[]): string[] {
  const hits = new Set<string>();
  for (const error of errors) {
    for (const id of nodeIds) {
      if (error.includes(`'${id}'`) || error.includes(`"${id}"`) || error.includes(id)) {
        hits.add(id);
      }
    }
  }
  return [...hits];
}

function toDisplayEdges(
  raw: PipelineGraph["edges"] | Edge[] | undefined,
  nodes: StepNode[],
): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (raw || []).map((edge, index) => {
    const source = byId.get(edge.source);
    const isCondition = source?.data.node_type === "condition";
    const branch = edgeBranch(edge);
    const sourceHandle =
      edge.sourceHandle || (isCondition ? branch : undefined) || undefined;
    return {
      id: edge.id || `edge-${index}`,
      source: edge.source,
      target: edge.target,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      ...(isCondition
        ? {
            label: branch.toUpperCase(),
            className: `pipeline-edge-${branch}`,
            data: { ...(edge.data || {}), branch },
          }
        : edge.data
          ? { data: edge.data as Edge["data"] }
          : {}),
      ...(edge.label && !isCondition ? { label: String(edge.label) } : {}),
    };
  });
}

function PipelineStepNodeComponent({ data, selected }: NodeProps<StepNode>) {
  const config = data.config || {};
  const warnings = nodeConfigWarnings(data.node_type, config);
  const summary = configSummary(data.node_type, config);
  const isCondition = data.node_type === "condition";
  return (
    <div
      className={[
        "pipeline-step-node",
        selected ? "is-selected" : "",
        warnings.length ? "has-warning" : "",
        data.runStatus ? `has-run-status status-${data.runStatus}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="pipeline-step-node"
    >
      <Handle type="target" position={Position.Left} />
      <strong className="pipeline-step-label">{data.label}</strong>
      <span className="pipeline-step-type">{pipelineNodeTypeLabel(data.node_type)}</span>
      {data.runStatus && (
        <span className="pipeline-step-run-status">
          <StatusBadge status={data.runStatus} />
        </span>
      )}
      {summary.map((line) => (
        <span key={line} className="pipeline-step-summary">
          {line}
        </span>
      ))}
      {warnings.length > 0 && !data.runStatus && (
        <span className="pipeline-step-warning" title={warnings.join("; ")}>
          ⚠ {warnings[0]}
        </span>
      )}
      {isCondition ? (
        CONDITION_HANDLES.map((branch, index) => (
          <Handle
            key={branch}
            id={branch}
            type="source"
            position={Position.Right}
            className={`pipeline-condition-handle pipeline-condition-handle-${branch}`}
            style={{ top: `${28 + index * 22}%` }}
            title={branch.toUpperCase()}
          >
            <span className="pipeline-condition-handle-label">{branch.toUpperCase()}</span>
          </Handle>
        ))
      ) : (
        <Handle type="source" position={Position.Right} id="out" />
      )}
    </div>
  );
}

const PipelineStepNode = memo(PipelineStepNodeComponent);

const nodeTypes = { [STEP_NODE_TYPE]: PipelineStepNode };

export function Pipelines() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const load = useCallback(async () => {
    try {
      setPipelines(await api<Pipeline[]>(`/projects/${projectId}/pipelines`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipelines could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    try {
      const pipeline = await api<Pipeline>(`/projects/${projectId}/pipelines`, {
        method: "POST",
        body: JSON.stringify({ name, description: "", graph: { nodes: [], edges: [] } }),
      });
      navigate(`/projects/${projectId}/pipelines/${pipeline.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline could not be created.");
    }
  }

  async function deletePipeline(pipeline: Pipeline) {
    if (!projectId || deletingId !== null) return;
    const confirmed = confirmAction(
      `Delete pipeline "${pipeline.name}"?\n\nThis permanently deletes the pipeline and its saved versions. Pipelines with run history cannot be deleted.`,
    );
    if (!confirmed) return;

    setDeletingId(pipeline.id);
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/pipelines/${pipeline.id}`, { method: "DELETE" });
      setPipelines((current) => current.filter((row) => row.id !== pipeline.id));
      setSuccess(`Pipeline "${pipeline.name}" deleted.`);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) {
        setError(
          "This pipeline has run history and cannot be deleted. Run history is retained for auditability.",
        );
      } else {
        setError(reason instanceof Error ? reason.message : "Pipeline could not be deleted.");
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="page-stack pipeline-catalog-page">
      <PageHeader
        title="Pipelines"
        description="Build repeatable data, training, approval, and deployment workflows."
        actions={
          canWrite ? (
            <button className="btn" onClick={() => setShowCreate(!showCreate)}>
              ＋ New pipeline
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {canWrite && showCreate && (
        <form className="panel inline-form pipeline-create-form" onSubmit={create} data-testid="pipeline-create-form">
          <label>
            Pipeline name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="Production training workflow"
              data-testid="pipeline-name"
            />
          </label>
          <button className="btn" data-testid="pipeline-create-submit">
            Create and open builder
          </button>
          <button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>
            Cancel
          </button>
        </form>
      )}
      {loading ? (
        <Loading label="Loading pipelines" />
      ) : pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines"
          description="Create a visual workflow to standardize your model lifecycle."
          action={
            canWrite ? (
              <button className="btn" onClick={() => setShowCreate(true)}>
                Create pipeline
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="panel table-wrap catalog-table pipeline-catalog-table">
          <table>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Status</th>
                <th>Version</th>
                <th>Type</th>
                <th>Created</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {pipelines.map((pipeline) => (
                <tr key={pipeline.id}>
                  <td>
                    <Link
                      className="catalog-primary-link"
                      to={`/projects/${projectId}/pipelines/${pipeline.id}`}
                    >
                      <strong>{pipeline.name}</strong>
                    </Link>
                    <small className="table-subtitle">
                      {pipeline.description || "Visual workflow"}
                    </small>
                  </td>
                  <td>
                    <StatusBadge status={pipeline.status} />
                  </td>
                  <td>
                    <span className="version-chip">v{pipeline.latest_version}</span>
                  </td>
                  <td>
                    <span className={`type-chip${pipeline.is_template ? "" : " is-muted"}`}>
                      {pipeline.is_template ? "Template" : "Project pipeline"}
                    </span>
                  </td>
                  <td className="catalog-meta-date">{formatDate(pipeline.created_at)}</td>
                  <td className="align-right">
                    <div className="catalog-row-actions">
                      {canWrite && pipeline.status === "published" && (
                        <Link
                          className="btn link"
                          data-testid={`pipeline-schedule-${pipeline.id}`}
                          to={`/projects/${projectId}/schedules?create=1&target_type=pipeline_run&pipeline_id=${pipeline.id}`}
                        >
                          Schedule
                        </Link>
                      )}
                      {canWrite && pipeline.status !== "published" && (
                        <button
                          type="button"
                          className="btn link pipeline-schedule-disabled"
                          data-testid={`pipeline-schedule-${pipeline.id}`}
                          disabled
                          title="Publish this pipeline before scheduling."
                          aria-label="Schedule unavailable. Publish this pipeline before scheduling."
                        >
                          Schedule
                        </button>
                      )}
                      {canWrite && (
                        <button
                          type="button"
                          className="btn link danger-text"
                          data-testid={`pipeline-delete-${pipeline.id}`}
                          disabled={deletingId !== null}
                          aria-label={`Delete ${pipeline.name}`}
                          onClick={() => void deletePipeline(pipeline)}
                        >
                          {deletingId === pipeline.id ? "Deleting…" : "Delete"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PipelineBuilder() {
  const { projectId, pipelineId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [nodes, setNodes] = useState<StepNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [jsonText, setJsonText] = useState("{}");
  const [jsonError, setJsonError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [historyFlags, setHistoryFlags] = useState({ undo: false, redo: false });
  const [inspectorEpoch, setInspectorEpoch] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationVisible, setValidationVisible] = useState(false);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<string[]>([]);
  const [upstreamColumns, setUpstreamColumns] = useState<string[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotMode, setCopilotMode] = useState<"draft" | "patch">("draft");
  const [copilotPrompt, setCopilotPrompt] = useState("");
  const [copilotDraft, setCopilotDraft] = useState<
    PipelineCopilotDraftResponse | PipelineCopilotPatchResponse | null
  >(null);
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [copilotError, setCopilotError] = useState("");
  const [copilotConfirming, setCopilotConfirming] = useState(false);
  const copilotRequestIdRef = useRef(0);
  const validateSeqRef = useRef(0);
  const loadSeqRef = useRef(0);
  const historyRef = useRef<PipelineGraphHistoryState>(createEmptyPipelineGraphHistory());
  const savedSnapshotRef = useRef<PipelineGraphSnapshot | null>(null);
  const nodesRef = useRef<StepNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const dragBaselineRef = useRef<PipelineGraphSnapshot | null>(null);
  const suppressEdgeHistoryRef = useRef(false);
  const flowInstanceRef = useRef<{
    setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
    getZoom: () => number;
  } | null>(null);
  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [edges, nodes]);

  const invalidateValidate = useCallback(() => {
    validateSeqRef.current += 1;
    setValidationErrors([]);
    setValidationVisible(false);
    setHighlightedNodeIds([]);
    setBusy((prev) => (prev === "validate" ? "" : prev));
  }, []);

  const syncDirtyFromSnapshot = useCallback((snapshot: PipelineGraphSnapshot) => {
    setDirty(!pipelineGraphSnapshotsEqual(snapshot, savedSnapshotRef.current));
  }, []);

  const publishHistory = useCallback((next: PipelineGraphHistoryState) => {
    historyRef.current = next;
    setHistoryFlags({
      undo: next.past.length > 0,
      redo: next.future.length > 0,
    });
  }, []);

  const resetGraphHistory = useCallback(() => {
    dragBaselineRef.current = null;
    publishHistory(createEmptyPipelineGraphHistory());
  }, [publishHistory]);

  const nodesFromSnapshot = useCallback((snapshot: PipelineGraphSnapshot): StepNode[] => {
    return snapshot.nodes.map((node) => ({
      id: node.id,
      type: STEP_NODE_TYPE,
      position: { x: node.position.x, y: node.position.y },
      data: {
        label: node.data.label,
        node_type: node.data.node_type,
        config: asConfig(node.data.config),
      },
    }));
  }, []);

  const edgesFromSnapshot = useCallback(
    (snapshot: PipelineGraphSnapshot, nextNodes: StepNode[]): Edge[] =>
      toDisplayEdges(snapshot.edges as PipelineGraph["edges"], nextNodes),
    [],
  );

  const commitGraphEdit = useCallback(
    (
      nextNodes: StepNode[],
      nextEdges: Edge[],
      options?: { baseline?: PipelineGraphSnapshot | null },
    ) => {
      const currentSnapshot =
        options?.baseline ?? capturePipelineGraphSnapshot(nodesRef.current, edgesRef.current);
      const nextSnapshot = capturePipelineGraphSnapshot(nextNodes, nextEdges);
      if (pipelineGraphSnapshotsEqual(currentSnapshot, nextSnapshot)) {
        setNodes(nextNodes);
        setEdges(nextEdges);
        nodesRef.current = nextNodes;
        edgesRef.current = nextEdges;
        return false;
      }
      publishHistory(pushPipelineGraphHistory(historyRef.current, currentSnapshot));
      setNodes(nextNodes);
      setEdges(nextEdges);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setSelectedId((nodeId) =>
        nodeId && nextNodes.some((node) => node.id === nodeId) ? nodeId : "",
      );
      syncDirtyFromSnapshot(nextSnapshot);
      invalidateValidate();
      return true;
    },
    [invalidateValidate, publishHistory, syncDirtyFromSnapshot],
  );

  const applyGraphSnapshot = useCallback(
    (snapshot: PipelineGraphSnapshot, options?: { bumpInspector?: boolean }) => {
      const nextNodes = nodesFromSnapshot(snapshot);
      const nextEdges = edgesFromSnapshot(snapshot, nextNodes);
      setNodes(nextNodes);
      setEdges(nextEdges);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setSelectedId((nodeId) => {
        const still = nodeId && nextNodes.some((node) => node.id === nodeId) ? nodeId : "";
        if (still) {
          const match = nextNodes.find((node) => node.id === still);
          if (match) {
            setJsonText(JSON.stringify(match.data.config || {}, null, 2));
            setJsonError("");
          }
        }
        return still;
      });
      syncDirtyFromSnapshot(snapshot);
      invalidateValidate();
      if (options?.bumpInspector) {
        setInspectorEpoch((value) => value + 1);
      }
    },
    [edgesFromSnapshot, invalidateValidate, nodesFromSnapshot, syncDirtyFromSnapshot],
  );

  const undoGraphEdit = useCallback(() => {
    if (!canWrite) return;
    const current = capturePipelineGraphSnapshot(nodesRef.current, edgesRef.current);
    const result = undoPipelineGraphHistory(historyRef.current, current);
    if (!result) return;
    dragBaselineRef.current = null;
    publishHistory(result.history);
    applyGraphSnapshot(result.snapshot, { bumpInspector: true });
  }, [applyGraphSnapshot, canWrite, publishHistory]);

  const redoGraphEdit = useCallback(() => {
    if (!canWrite) return;
    const current = capturePipelineGraphSnapshot(nodesRef.current, edgesRef.current);
    const result = redoPipelineGraphHistory(historyRef.current, current);
    if (!result) return;
    dragBaselineRef.current = null;
    publishHistory(result.history);
    applyGraphSnapshot(result.snapshot, { bumpInspector: true });
  }, [applyGraphSnapshot, canWrite, publishHistory]);

  const canUndo = canWrite && historyFlags.undo;
  const canRedo = canWrite && historyFlags.redo;

  const copilotPatchOps =
    copilotMode === "patch" && copilotDraft && "patch" in copilotDraft
      ? copilotDraft.patch.operations
      : [];
  const copilotIsNoop = copilotMode === "patch" && copilotPatchOps.length === 0;
  const copilotCanApply = Boolean(
    copilotDraft?.validation.valid && !(copilotMode === "patch" && copilotIsNoop),
  );

  const copilotPreviewNodes = useMemo(
    () => (copilotDraft ? toStepNodes(copilotDraft.graph.nodes) : []),
    [copilotDraft],
  );
  const copilotPreviewEdges = useMemo(
    () =>
      copilotDraft ? toDisplayEdges(copilotDraft.graph.edges, copilotPreviewNodes) : [],
    [copilotDraft, copilotPreviewNodes],
  );

  const openCopilotDrawer = useCallback((mode: "draft" | "patch") => {
    copilotRequestIdRef.current += 1;
    setCopilotMode(mode);
    setCopilotOpen(true);
    setCopilotConfirming(false);
    setCopilotDraft(null);
    setCopilotError("");
    setCopilotLoading(false);
    // Preserve prompt so close mid-flight / reopen keeps the typed request.
  }, []);

  const closeCopilotDrawer = useCallback(() => {
    // Invalidate any in-flight Copilot response so it cannot restore discarded preview state.
    copilotRequestIdRef.current += 1;
    setCopilotOpen(false);
    setCopilotConfirming(false);
    setCopilotDraft(null);
    setCopilotError("");
    setCopilotLoading(false);
  }, []);

  const generateCopilotProposal = useCallback(async () => {
    const prompt = copilotPrompt.trim();
    if (!prompt || !projectId || copilotLoading) return;
    const requestId = ++copilotRequestIdRef.current;
    const modeAtRequest = copilotMode;
    setCopilotLoading(true);
    setCopilotError("");
    setCopilotConfirming(false);
    try {
      const proposal =
        modeAtRequest === "patch"
          ? await api<PipelineCopilotPatchResponse>(
              `/projects/${projectId}/pipeline-copilot/patch`,
              {
                method: "POST",
                body: JSON.stringify({
                  prompt,
                  current_graph: {
                    nodes: nodes.map((node) => ({
                      id: node.id,
                      type: node.type,
                      position: node.position,
                      data: {
                        label: node.data.label,
                        node_type: node.data.node_type,
                        config: node.data.config,
                      },
                    })),
                    edges: edges.map((edge) => {
                      const source = nodes.find((node) => node.id === edge.source);
                      const isCondition = source?.data.node_type === "condition";
                      const branch = isCondition ? edgeBranch(edge) : undefined;
                      return {
                        id: edge.id,
                        source: edge.source,
                        target: edge.target,
                        ...(edge.sourceHandle || branch
                          ? { sourceHandle: edge.sourceHandle || branch }
                          : {}),
                        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
                        ...(branch
                          ? { label: branch, data: { branch } }
                          : edge.label
                            ? { label: String(edge.label) }
                            : {}),
                        ...(!branch && edge.data
                          ? { data: edge.data as PipelineGraph["edges"][number]["data"] }
                          : {}),
                      };
                    }),
                  },
                }),
              },
            )
          : await api<PipelineCopilotDraftResponse>(
              `/projects/${projectId}/pipeline-copilot/draft`,
              { method: "POST", body: JSON.stringify({ prompt }) },
            );
      if (requestId !== copilotRequestIdRef.current) return;
      setCopilotDraft(proposal);
    } catch (reason) {
      if (requestId !== copilotRequestIdRef.current) return;
      setCopilotDraft(null);
      setCopilotError(
        reason instanceof Error ? reason.message : "Pipeline Copilot request failed.",
      );
    } finally {
      if (requestId === copilotRequestIdRef.current) {
        setCopilotLoading(false);
      }
    }
  }, [copilotLoading, copilotMode, copilotPrompt, edges, nodes, projectId]);

  const confirmApplyCopilotProposal = useCallback(() => {
    if (!copilotDraft?.validation.valid) return;
    if (copilotMode === "patch" && "patch" in copilotDraft && copilotDraft.patch.operations.length === 0) {
      return;
    }
    const nextNodes = toStepNodes(copilotDraft.graph.nodes);
    const nextEdges = toDisplayEdges(copilotDraft.graph.edges, nextNodes);
    commitGraphEdit(nextNodes, nextEdges);
    setInspectorEpoch((value) => value + 1);
    setJsonError("");
    setError("");
    setSuccess(
      copilotMode === "patch"
        ? "Copilot changes applied to the Builder. Save a version when you are ready."
        : "Copilot draft applied to the Builder. Save a version when you are ready.",
    );
    closeCopilotDrawer();
  }, [closeCopilotDrawer, commitGraphEdit, copilotDraft, copilotMode]);

  const load = useCallback(async () => {
    const loadId = ++loadSeqRef.current;
    try {
      const [row, runRows, datasetRows] = await Promise.all([
        api<Pipeline>(`/projects/${projectId}/pipelines/${pipelineId}`),
        api<PipelineRun[]>(`/projects/${projectId}/pipelines/${pipelineId}/runs`),
        api<Dataset[]>(`/projects/${projectId}/datasets`).catch(() => [] as Dataset[]),
      ]);
      if (loadId !== loadSeqRef.current) return;
      const nextNodes = toStepNodes(row.version?.graph.nodes);
      const nextEdges = toDisplayEdges(row.version?.graph.edges, nextNodes);
      const baseline = capturePipelineGraphSnapshot(nextNodes, nextEdges);
      setPipeline(row);
      setNodes(nextNodes);
      setEdges(nextEdges);
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setRuns(runRows);
      setDatasets(datasetRows);
      setSelectedId("");
      savedSnapshotRef.current = baseline;
      dragBaselineRef.current = null;
      publishHistory(createEmptyPipelineGraphHistory());
      setInspectorEpoch((value) => value + 1);
      setDirty(false);
      validateSeqRef.current += 1;
      setValidationErrors([]);
      setValidationVisible(false);
      setHighlightedNodeIds([]);
      setJsonText("{}");
      setJsonError("");
    } catch (reason) {
      if (loadId !== loadSeqRef.current) return;
      setError(reason instanceof Error ? reason.message : "Pipeline could not be loaded.");
    }
  }, [pipelineId, projectId, publishHistory]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const upstreamDataset = useMemo(() => {
    if (!selectedNode) return null;
    return findUpstreamDatasetLoad(selectedNode.id, nodes, edges);
  }, [edges, nodes, selectedNode]);

  const upstreamDatasetId = useMemo(() => {
    if (selectedNode?.data.node_type === "dataset_load") {
      const id = selectedNode.data.config.dataset_id;
      return id != null ? Number(id) : null;
    }
    const id = upstreamDataset?.data.config.dataset_id;
    return id != null ? Number(id) : null;
  }, [selectedNode, upstreamDataset]);

  const upstreamVersionId = useMemo(() => {
    const source =
      selectedNode?.data.node_type === "dataset_load" ? selectedNode : upstreamDataset;
    const id = source?.data.config.dataset_version_id;
    return id != null ? Number(id) : null;
  }, [selectedNode, upstreamDataset]);

  useEffect(() => {
    if (!selectedNode || !projectId) {
      setUpstreamColumns([]);
      return;
    }
    const needsColumns =
      selectedNode.data.node_type === "training" ||
      selectedNode.data.node_type === "dataset_load";
    if (!needsColumns) {
      setUpstreamColumns([]);
      return;
    }

    let cancelled = false;
    (async () => {
      if (upstreamDatasetId && upstreamVersionId) {
        try {
          const versions = await api<DatasetVersion[]>(
            `/projects/${projectId}/datasets/${upstreamDatasetId}/versions`,
          );
          const match = versions.find((row) => row.id === upstreamVersionId);
          if (!cancelled && match?.columns?.length) {
            setUpstreamColumns(match.columns);
            return;
          }
        } catch {
          /* fall through */
        }
      }
      if (upstreamDatasetId) {
        const fromList = datasets.find((row) => row.id === upstreamDatasetId);
        if (fromList?.columns?.length) {
          if (!cancelled) setUpstreamColumns(fromList.columns);
          return;
        }
        try {
          const detail = await api<Dataset>(`/projects/${projectId}/datasets/${upstreamDatasetId}`);
          if (!cancelled) setUpstreamColumns(detail.columns || []);
          return;
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setUpstreamColumns([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [datasets, projectId, selectedNode, upstreamDatasetId, upstreamVersionId]);

  useEffect(() => {
    if (!selectedNode) {
      setJsonText("{}");
      setJsonError("");
      return;
    }
    setJsonText(JSON.stringify(selectedNode.data.config || {}, null, 2));
    setJsonError("");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps -- sync JSON when selection changes only

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        className: [
          node.className,
          highlightedNodeIds.includes(node.id) ? "pipeline-node-invalid" : "",
        ]
          .filter(Boolean)
          .join(" "),
        selected: node.id === selectedId,
      })),
    [highlightedNodeIds, nodes, selectedId],
  );

  const displayEdges = useMemo(() => toDisplayEdges(edges, nodes), [edges, nodes]);

  const validationIssues = useMemo(
    () => validationErrors.map((errorText) => parseValidationIssue(errorText, nodes.map((n) => n.id))),
    [nodes, validationErrors],
  );

  const libraryGroups = useMemo(
    () => filterNodeLibrary(PIPELINE_NODE_LIBRARY, libraryQuery),
    [libraryQuery],
  );

  function selectNode(node: StepNode) {
    setSelectedId(node.id);
    setJsonText(JSON.stringify(node.data.config || {}, null, 2));
    setJsonError("");
  }

  function focusValidationNode(nodeId: string) {
    const node = nodes.find((row) => row.id === nodeId);
    if (!node) return;
    selectNode(node);
    const width = typeof node.width === "number" ? node.width : 200;
    const height = typeof node.height === "number" ? node.height : 80;
    flowInstanceRef.current?.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom: Math.max(flowInstanceRef.current.getZoom(), 0.85),
      duration: 280,
    });
  }

  function updateSelectedData(partial: Partial<StepData>, nextConfig?: Record<string, unknown>) {
    if (!canWrite || !selectedId) return;
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id !== selectedId) return node;
      const config = nextConfig ?? node.data.config;
      const data = { ...node.data, ...partial, config };
      return { ...node, data };
    });
    commitGraphEdit(nextNodes, edgesRef.current);
    if (nextConfig) {
      setJsonText(JSON.stringify(nextConfig, null, 2));
      setJsonError("");
    }
  }

  function onConfigChange(next: Record<string, unknown>) {
    if (!canWrite) return;
    updateSelectedData({}, next);
  }

  function onJsonChange(text: string) {
    if (!canWrite) return;
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError("Configuration must be a JSON object.");
        return;
      }
      setJsonError("");
      const nextNodes = nodesRef.current.map((node) =>
        node.id === selectedId
          ? { ...node, data: { ...node.data, config: parsed as Record<string, unknown> } }
          : node,
      );
      commitGraphEdit(nextNodes, edgesRef.current);
    } catch {
      setJsonError("Invalid JSON — changes are not applied until the text parses.");
    }
  }

  function addNodeOfType(nodeType: PipelineNodeType) {
    if (!canWrite) return;
    const currentNodes = nodesRef.current;
    const id = nextPipelineNodeId(
      nodeType,
      currentNodes.map((node) => node.id),
    );
    const node: StepNode = {
      id,
      type: STEP_NODE_TYPE,
      position: {
        x: 80 + (currentNodes.length % 3) * 240,
        y: 80 + Math.floor(currentNodes.length / 3) * 160,
      },
      data: {
        label: labelForType(nodeType),
        node_type: nodeType,
        config: defaultConfigFor(nodeType),
      },
    };
    commitGraphEdit([...currentNodes, node], edgesRef.current);
    setSelectedId(id);
    setJsonText(JSON.stringify(node.data.config, null, 2));
    setJsonError("");
    setInspectorEpoch((value) => value + 1);
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

  const onNodesChange = useCallback(
    (changes: NodeChange<StepNode>[]) => {
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
          dragBaselineRef.current = capturePipelineGraphSnapshot(
            nodesRef.current,
            edgesRef.current,
          );
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
        const baseline = capturePipelineGraphSnapshot(nodesRef.current, edgesRef.current);
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
      const source = nodesRef.current.find((node) => node.id === connection.source);
      const isCondition = source?.data.node_type === "condition";
      const handle = connection.sourceHandle;
      const branch: ConditionBranch =
        handle === "true" || handle === "false" || handle === "always" ? handle : "always";
      const edge = isCondition
        ? {
            ...connection,
            sourceHandle: branch,
            label: branch.toUpperCase(),
            className: `pipeline-edge-${branch}`,
            data: { branch },
          }
        : connection;
      const nextEdges = addEdge(edge, edgesRef.current);
      commitGraphEdit(nodesRef.current, nextEdges);
    },
    [canWrite, commitGraphEdit],
  );

  useEffect(() => {
    if (!canWrite) return;
    const onKeyDown = (event: KeyboardEvent) => {
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

  const graph = (): PipelineGraph => ({
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: {
        label: node.data.label,
        node_type: node.data.node_type,
        config: node.data.config,
      },
    })),
    edges: edges.map((edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      const isCondition = source?.data.node_type === "condition";
      const branch = isCondition ? edgeBranch(edge) : undefined;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle || branch ? { sourceHandle: edge.sourceHandle || branch } : {}),
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
        ...(branch
          ? { label: branch, data: { branch } }
          : edge.label
            ? { label: String(edge.label) }
            : {}),
        ...(!branch && edge.data
          ? { data: edge.data as PipelineGraph["edges"][number]["data"] }
          : {}),
      };
    }) as PipelineGraph["edges"],
  });

  async function validateCurrentGraph(requestId: number): Promise<boolean | null> {
    const result = await api<ValidationResult>(
      `/projects/${projectId}/pipelines/${pipelineId}/validate`,
      { method: "POST", body: JSON.stringify({ graph: graph() }) },
    );
    if (requestId !== validateSeqRef.current) return null;
    setValidationVisible(true);
    if (!result.valid) {
      setValidationErrors(result.errors || ["Pipeline graph is invalid."]);
      setHighlightedNodeIds(
        extractHighlightedNodeIds(result.errors || [], nodesRef.current.map((n) => n.id)),
      );
      return false;
    }
    setValidationErrors([]);
    setHighlightedNodeIds([]);
    return true;
  }

  async function runValidate() {
    const requestId = ++validateSeqRef.current;
    setBusy("validate");
    setError("");
    setSuccess("");
    try {
      const ok = await validateCurrentGraph(requestId);
      if (ok === null || requestId !== validateSeqRef.current) return;
      setSuccess(ok ? "그래프 검증을 통과했습니다." : "");
      if (!ok) setError("검증 오류를 수정한 뒤 다시 시도하세요.");
    } catch (reason) {
      if (requestId !== validateSeqRef.current) return;
      setError(reason instanceof Error ? reason.message : "파이프라인 검증에 실패했습니다.");
    } finally {
      if (requestId === validateSeqRef.current) {
        setBusy((prev) => (prev === "validate" ? "" : prev));
      }
    }
  }

  async function action(kind: "save" | "publish" | "run") {
    setBusy(kind);
    setError("");
    setSuccess("");
    try {
      if (kind === "save") {
        // Freeze the exact graph sent to the API; later canvas edits must not rewrite it.
        const frozenGraph = graph();
        const savedSnapshot = capturePipelineGraphSnapshot(nodesRef.current, edgesRef.current);
        const version = await api<PipelineVersion>(
          `/projects/${projectId}/pipelines/${pipelineId}/versions`,
          {
            method: "POST",
            body: JSON.stringify({ graph: frozenGraph }),
          },
        );
        savedSnapshotRef.current = savedSnapshot;
        const liveSnapshot = capturePipelineGraphSnapshot(nodesRef.current, edgesRef.current);
        // Allow editing during save. Only clear history when the canvas still matches
        // the saved snapshot; otherwise keep post-save-start edits undoable.
        if (pipelineGraphSnapshotsEqual(liveSnapshot, savedSnapshot)) {
          resetGraphHistory();
        } else {
          dragBaselineRef.current = null;
        }
        syncDirtyFromSnapshot(liveSnapshot);
        setPipeline((prev) =>
          prev
            ? {
                ...prev,
                latest_version: version.version ?? prev.latest_version + 1,
                version: {
                  id: version.id,
                  version: version.version,
                  graph: frozenGraph,
                },
              }
            : prev,
        );
        setSuccess("파이프라인 버전을 저장했습니다.");
        setValidationErrors([]);
        setValidationVisible(false);
        // Do not call load() here — it would overwrite edits made during the in-flight save.
        return;
      }
      if (dirty) {
        setError("게시하거나 실행하기 전에 변경사항을 버전으로 저장하세요.");
        return;
      }
      const requestId = ++validateSeqRef.current;
      const ok = await validateCurrentGraph(requestId);
      if (ok === null || requestId !== validateSeqRef.current) return;
      if (!ok) {
        setError("검증 오류를 수정한 뒤 다시 시도하세요.");
        return;
      }
      if (kind === "publish") {
        await api(`/projects/${projectId}/pipelines/${pipelineId}/publish`, { method: "POST" });
        setSuccess("파이프라인을 게시했습니다.");
        await load();
      } else {
        const run = await api<PipelineRun>(`/projects/${projectId}/pipelines/${pipelineId}/run`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        navigate(`/projects/${projectId}/pipeline-runs/${run.id}`);
      }
    } catch (reason) {
      // Keep edit history on save failure so the user can continue undoing.
      setError(
        reason instanceof Error
          ? reason.message
          : kind === "save"
            ? "파이프라인 버전을 저장하지 못했습니다."
            : kind === "publish"
              ? "파이프라인을 게시하지 못했습니다."
              : "파이프라인을 실행하지 못했습니다.",
      );
    } finally {
      setBusy("");
    }
  }

  function confirmLeave(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    const ok = window.confirm(UNSAVED_CHANGES_MESSAGE);
    if (!ok) event.preventDefault();
  }

  if (!pipeline) {
    return (
      <>
        <ErrorNotice message={error} />
        <Loading label="파이프라인 편집기를 불러오는 중…" />
      </>
    );
  }

  const actionsDisabled = Boolean(busy);
  const publishRunDisabled = actionsDisabled || dirty;
  const canSchedule = !dirty && pipeline.status === "published";
  const scheduleReason = dirty
    ? "일정 등록 전에 변경사항을 저장하세요. 일정은 저장되지 않은 그래프가 아니라 저장된 파이프라인을 대상으로 합니다."
    : pipeline.status !== "published"
      ? "일정을 등록하려면 먼저 파이프라인을 게시하세요."
      : "이 파이프라인의 일정을 만듭니다";

  return (
    <div className="pipeline-page">
      <header className="pipeline-builder-header">
        <div className="pipeline-builder-header-meta">
          <Link
            className="pipeline-back-link"
            to={`/projects/${projectId}/pipelines`}
            onClick={confirmLeave}
          >
            ← 파이프라인 목록
          </Link>
          <div>
            <span className="eyebrow">파이프라인 편집기</span>
            <h1>{pipeline.name}</h1>
            <p className="muted builder-header-subcopy">
              <StatusBadge status={pipeline.status} />
              {" · "}
              <span className="version-chip">v{pipeline.latest_version}</span>
            </p>
          </div>
        </div>
        <div className="pipeline-builder-header-actions">
          <button
            type="button"
            className="btn secondary"
            data-testid="pipeline-undo"
            disabled={!canUndo || actionsDisabled}
            onClick={() => undoGraphEdit()}
            title="실행 취소 (Ctrl+Z)"
          >
            실행 취소
          </button>
          <button
            type="button"
            className="btn secondary"
            data-testid="pipeline-redo"
            disabled={!canRedo || actionsDisabled}
            onClick={() => redoGraphEdit()}
            title="다시 실행 (Ctrl+Y / Ctrl+Shift+Z)"
          >
            다시 실행
          </button>
          {canWrite && (
            <>
              <button
                className="btn secondary"
                disabled={actionsDisabled}
                data-testid="pipeline-validate"
                title={UI_HELP.pipelineValidate}
                onClick={() => void runValidate()}
              >
                {busy === "validate" ? "검증 중…" : "검증"}
              </button>
              <button
                className="btn secondary"
                disabled={actionsDisabled}
                data-testid="pipeline-save"
                title={UI_HELP.pipelineSaveVersion}
                onClick={() => void action("save")}
              >
                {busy === "save" ? "저장 중…" : "버전 저장"}
              </button>
              <button
                className="btn secondary"
                disabled={publishRunDisabled}
                title={
                  dirty ? "게시하기 전에 변경사항을 저장하세요" : UI_HELP.pipelinePublish
                }
                data-testid="pipeline-publish"
                onClick={() => void action("publish")}
              >
                게시 (Publish)
              </button>
              {canSchedule ? (
                <Link
                  className="btn secondary"
                  data-testid="pipeline-schedule-entry"
                  to={`/projects/${projectId}/schedules?create=1&target_type=pipeline_run&pipeline_id=${pipeline.id}`}
                  title={scheduleReason}
                >
                  일정 등록
                </Link>
              ) : (
                <button
                  type="button"
                  className="btn secondary"
                  data-testid="pipeline-schedule-entry"
                  disabled
                  title={scheduleReason}
                  aria-label={`일정을 등록할 수 없습니다. ${scheduleReason}`}
                >
                  일정 등록
                </button>
              )}
              <button
                className="btn"
                disabled={publishRunDisabled}
                title={dirty ? "실행하기 전에 변경사항을 저장하세요" : UI_HELP.pipelineRun}
                data-testid="pipeline-run"
                onClick={() => void action("run")}
              >
                ▶ 파이프라인 실행
              </button>
            </>
          )}
        </div>
      </header>
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      <div
        className="builder-state-band pipeline-builder-guide"
        role="note"
        data-testid="pipeline-builder-guide"
      >
        <span className="builder-state-copy">
          <strong>사용 순서:</strong> ① 데이터셋 선택 → ② 필요한 작업 노드 추가·연결 → ③ 그래프
          검증 및 버전 저장 → ④ 파이프라인 실행
          <HelpTip
            text={`${UI_HELP.pipeline} ${UI_HELP.pipelineValidate} ${UI_HELP.pipelineSaveVersion} ${UI_HELP.pipelinePublish} ${UI_HELP.pipelineRun}`}
          />
        </span>
        <span className="form-hint" data-testid="pipeline-builder-guide-details">
          파이프라인 만들기는 실행과 다릅니다. 노드 추가·설정 변경은 자동 저장되지 않으며, 검증은
          설정 오류 확인일 뿐 학습 실행이 아닙니다. 게시·실행 전에는 버전을 저장하세요. 게시는 별도
          상태 변경이고, 일정 등록은 게시된 파이프라인에서 가능합니다.
        </span>
      </div>
      {dirty ? (
        <div className="builder-state-band is-dirty" role="status">
          <span className="builder-state-badge pipeline-dirty-badge" data-testid="pipeline-dirty-badge">
            저장되지 않은 변경사항
          </span>
          <span className="builder-state-copy" data-testid="pipeline-dirty-hint">
            게시하거나 실행하기 전에 버전을 저장하세요. 변경사항은 자동 저장되지 않습니다.
          </span>
        </div>
      ) : (
        <div className="builder-state-band" role="status">
          <span className="builder-state-copy">
            임시 편집 내용은 버전을 저장할 때까지 로컬에만 유지됩니다.
            {pipeline.status === "published"
              ? " 게시된 기준 버전은 계속 실행할 수 있습니다."
              : ""}
          </span>
        </div>
      )}

      <div
        className={`builder-layout-3zone${!canWrite ? " is-readonly" : ""}`}
        data-testid="pipeline-builder-layout"
        data-readonly={canWrite ? "false" : "true"}
      >
        {canWrite && (
          <aside className="pipeline-node-library panel">
            <div className="pipeline-copilot-entry" data-testid="pipeline-copilot-entry">
              <span className="eyebrow">AI 도우미</span>
              <strong>AI Pipeline Copilot</strong>
              <p className="form-hint">
                자연어로 파이프라인 초안을 만들거나 현재 구성을 수정하도록 요청할 수 있습니다. AI가
                제안한 내용을 확인하고 적용하기 전까지 그래프는 변경되지 않습니다.
                <HelpTip text={UI_HELP.pipelineCopilot} />
              </p>
              <p className="form-hint" data-testid="pipeline-copilot-draft-hint">
                초안(Draft): 새로운 전체 그래프 구성을 제안합니다. 적용 시 현재 편집 중인 그래프를
                대체할 수 있습니다.
              </p>
              <p className="form-hint" data-testid="pipeline-copilot-patch-hint">
                수정(Patch): 현재 그래프를 기준으로 수정사항을 제안합니다. 적용 전 변경 내용을
                검토할 수 있습니다.
              </p>
              <div className="pipeline-copilot-entry-actions">
                <button
                  type="button"
                  className="btn secondary"
                  data-testid="pipeline-copilot-open"
                  onClick={() => openCopilotDrawer("draft")}
                >
                  새 파이프라인 초안 만들기
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  data-testid="pipeline-copilot-patch-open"
                  onClick={() => openCopilotDrawer("patch")}
                >
                  현재 파이프라인 수정 제안
                </button>
              </div>
            </div>
            <span className="eyebrow">노드 라이브러리</span>
            <p className="form-hint">단계 유형을 클릭하면 캔버스에 추가됩니다.</p>
            <label className="pipeline-library-search">
              <span className="sr-only">노드 라이브러리 검색</span>
              <input
                type="search"
                placeholder="노드 검색 (예: 분할, split)…"
                value={libraryQuery}
                data-testid="pipeline-library-search"
                onChange={(event) => setLibraryQuery(event.target.value)}
              />
            </label>
            {libraryGroups.length === 0 ? (
              <p className="muted" data-testid="pipeline-library-empty">
                일치하는 노드가 없습니다.
              </p>
            ) : (
              libraryGroups.map((group) => (
                <div className="pipeline-library-category" key={group.category}>
                  <strong>{pipelineNodeLibraryCategoryLabel(group.category)}</strong>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.type}>
                        <button
                          type="button"
                          className="pipeline-library-item"
                          data-testid={`pipeline-library-${item.type}`}
                          onClick={() => addNodeOfType(item.type)}
                          title={pipelineNodeTypeDescription(item.type) || item.description}
                        >
                          <span aria-hidden="true">{item.icon}</span>
                          <span>{pipelineNodeTypeLabel(item.type)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </aside>
        )}

        <div className="pipeline-canvas" aria-label="파이프라인 그래프" data-testid="pipeline-canvas">
          {nodes.length === 0 ? (
            <div className="pipeline-empty-canvas">
              {canWrite ? (
                <>
                  <h2>데이터셋으로 시작하세요</h2>
                  <p className="muted">
                    데이터셋 불러오기(Dataset Load) 단계를 추가한 뒤, 품질 검사·학습·배포 노드를
                    연결하세요.
                  </p>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => addNodeOfType("dataset_load")}
                  >
                    데이터셋 불러오기 추가
                  </button>
                </>
              ) : (
                <>
                  <h2>이 파이프라인 버전에는 단계가 없습니다.</h2>
                  <p className="muted">빈 그래프에서 확인할 내용이 없습니다.</p>
                </>
              )}
            </div>
          ) : (
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              nodesDraggable={canWrite}
              nodesConnectable={canWrite}
              edgesReconnectable={canWrite}
              elementsSelectable
              deleteKeyCode={canWrite ? ["Backspace", "Delete"] : null}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => selectNode(node as StepNode)}
              onInit={(instance) => {
                flowInstanceRef.current = instance;
              }}
              fitView
            >
              <Background />
              <MiniMap
                pannable
                ariaLabel="파이프라인 미니맵 — 클릭하거나 드래그하여 이동"
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

        <aside className="pipeline-inspector panel">
          {!selectedNode ? (
            <>
              <span className="eyebrow">
                <TermLabel ko="파이프라인" en="Pipeline" help={UI_HELP.pipeline} />
              </span>
              <h2>{pipeline.name}</h2>
              <p className="muted">{pipeline.description || "설명이 아직 없습니다."}</p>
              <dl className="pipeline-inspector-meta">
                <div>
                  <dt>상태</dt>
                  <dd>
                    <StatusBadge status={pipeline.status} />
                  </dd>
                </div>
                <div>
                  <dt>버전</dt>
                  <dd>v{pipeline.latest_version}</dd>
                </div>
                <div>
                  <dt>노드 수</dt>
                  <dd>{nodes.length}</dd>
                </div>
              </dl>
              <p className="form-hint" data-testid="pipeline-inspector-hint">
                {canWrite
                  ? "캔버스에서 단계를 선택해 설정하거나, 노드 라이브러리에서 단계를 추가하세요."
                  : "캔버스에서 단계를 선택해 설정을 확인하세요."}
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">기본 정보</span>
              <label>
                단계 이름
                <input
                  key={`pipeline-step-name-${selectedNode.id}-${inspectorEpoch}`}
                  data-testid="pipeline-step-name"
                  value={selectedNode.data.label}
                  disabled={!canWrite}
                  onChange={(event) => updateSelectedData({ label: event.target.value })}
                />
              </label>
              <p className="form-hint" data-testid="pipeline-step-type">
                유형: {pipelineNodeTypeLabel(selectedNode.data.node_type)}
              </p>
              <small className="muted pipeline-node-id" data-testid="pipeline-node-id">
                노드 ID: {selectedNode.id}
              </small>

              <hr />
              <span className="eyebrow">설정</span>
              {canWrite ? (
                <NodeConfigForm
                  key={`pipeline-config-${selectedNode.id}-${inspectorEpoch}`}
                  projectId={String(projectId)}
                  nodeType={selectedNode.data.node_type}
                  config={selectedNode.data.config || {}}
                  onChange={onConfigChange}
                  upstreamDatasetId={upstreamDatasetId}
                  datasetColumns={upstreamColumns}
                />
              ) : (
                <p className="muted">읽기 전용 설정입니다.</p>
              )}

              <details className="advanced-json">
                <summary>고급 JSON</summary>
                <label>
                  설정
                  <textarea
                    key={`pipeline-json-${selectedNode.id}-${inspectorEpoch}`}
                    className="code-input"
                    data-testid="pipeline-advanced-json"
                    value={jsonText}
                    spellCheck={false}
                    disabled={!canWrite}
                    onChange={(event) => onJsonChange(event.target.value)}
                  />
                </label>
                {jsonError && (
                  <p className="error" data-testid="pipeline-json-error">
                    {jsonError}
                  </p>
                )}
              </details>

              {canWrite && (
                <>
                  <hr />
                  <span className="eyebrow">위험</span>
                  <button className="btn link danger-text" onClick={removeSelected}>
                    단계 제거
                  </button>
                </>
              )}
            </>
          )}
        </aside>
      </div>

      {(validationVisible || validationErrors.length > 0) && (
        <section
          className="pipeline-validation-panel panel"
          data-testid="pipeline-validation-errors"
        >
          <div className="panel-title">
            <div>
              <span className="eyebrow">검증</span>
              <h2>
                {validationErrors.length === 0
                  ? "문제 없음"
                  : `문제 ${validationErrors.length}건`}
              </h2>
            </div>
          </div>
          {validationErrors.length === 0 ? (
            <p className="muted">그래프 검증을 통과했습니다.</p>
          ) : (
            <ul className="pipeline-validation-list">
              {validationIssues.map((issue) => (
                <li key={issue.message}>
                  <button
                    type="button"
                    className="pipeline-validation-issue"
                    onClick={() => {
                      if (!issue.nodeId) return;
                      focusValidationNode(issue.nodeId);
                    }}
                    data-testid={
                      issue.nodeId
                        ? `pipeline-validation-issue-${issue.nodeId}`
                        : "pipeline-validation-issue-graph"
                    }
                  >
                    <strong>
                      {issue.nodeId
                        ? nodes.find((row) => row.id === issue.nodeId)?.data.label ||
                          issue.nodeId
                        : "그래프"}
                    </strong>
                    <span>{issue.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">History</span>
            <h2>Pipeline runs</h2>
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <div className="activity-list">
            {runs.map((run) => (
              <Link key={run.id} to={`/projects/${projectId}/pipeline-runs/${run.id}`}>
                <div>
                  <strong>Run #{run.id}</strong>
                  <small>{formatDate(run.created_at)}</small>
                </div>
                <StatusBadge status={run.status} />
              </Link>
            ))}
          </div>
        )}
      </section>

      {canWrite && (
        <Drawer
          open={copilotOpen}
          title={
            copilotMode === "patch" ? "AI 파이프라인 수정 제안" : "AI 파이프라인 초안 생성"
          }
          size="large"
          testId="pipeline-copilot-drawer"
          onClose={closeCopilotDrawer}
          footer={
            copilotConfirming ? (
              <div className="pipeline-copilot-confirm-actions">
                <button
                  type="button"
                  className="btn secondary"
                  data-testid="pipeline-copilot-confirm-back"
                  onClick={() => setCopilotConfirming(false)}
                >
                  미리보기로 돌아가기
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid="pipeline-copilot-confirm-apply"
                  onClick={confirmApplyCopilotProposal}
                >
                  적용 확인
                </button>
              </div>
            ) : undefined
          }
        >
          <div className="pipeline-copilot-form">
            <label htmlFor="pipeline-copilot-prompt">
              {copilotMode === "patch"
                ? "현재 파이프라인에서 변경할 내용을 설명해 주세요"
                : "만들고 싶은 파이프라인을 설명해 주세요"}
            </label>
            <textarea
              id="pipeline-copilot-prompt"
              data-testid="pipeline-copilot-prompt"
              data-drawer-initial-focus
              value={copilotPrompt}
              maxLength={4000}
              rows={5}
              placeholder={
                copilotMode === "patch"
                  ? "예: 현재 모델 학습 노드의 알고리즘을 Ridge로 변경하고 단계 이름을 열수요 예측 학습으로 바꿔 줘."
                  : "예: 열수요 데이터를 사용해 시간순으로 데이터를 분할하고 회귀 모델을 학습하는 파이프라인을 만들어 줘."
              }
              disabled={copilotLoading}
              onChange={(event) => setCopilotPrompt(event.target.value)}
            />
            <div className="pipeline-copilot-form-actions">
              <button
                type="button"
                className="btn"
                data-testid="pipeline-copilot-generate"
                disabled={copilotLoading || !copilotPrompt.trim()}
                aria-busy={copilotLoading}
                onClick={() => void generateCopilotProposal()}
              >
                {copilotLoading ? "제안 생성 중…" : "제안 생성"}
              </button>
              <span className="muted">{copilotPrompt.trim().length}/4000</span>
            </div>
            {copilotLoading && (
              <p className="form-hint" data-testid="pipeline-copilot-loading" role="status">
                AI가 제안을 생성하고 있습니다. 적용을 확정하기 전에는 기존 그래프가 변경되지
                않습니다.
              </p>
            )}
            {copilotError && (
              <div data-testid="pipeline-copilot-error">
                <p className="form-hint" data-testid="pipeline-copilot-error-title">
                  제안을 가져오지 못했습니다. Copilot 설정·네트워크·서비스 상태를 확인한 뒤 다시
                  시도하세요.
                </p>
                <ErrorNotice message={copilotError} />
              </div>
            )}
          </div>

          {copilotDraft && !copilotConfirming && (
            <div className="pipeline-copilot-preview" data-testid="pipeline-copilot-preview">
              <div className="pipeline-copilot-meta">
                <span className="eyebrow">제안 미리보기</span>
                <p className="pipeline-copilot-summary-block" data-testid="pipeline-copilot-summary">
                  <strong>AI 제안 요약.</strong> {copilotDraft.summary}
                </p>
                <p
                  className="form-hint pipeline-copilot-proposal-note"
                  data-testid="pipeline-copilot-proposal-note"
                >
                  적용하기 전까지 편집기 그래프는 변경되지 않습니다. 적용하면 편집기 그래프가
                  변경되지만, 파이프라인 버전은 자동으로 저장되지 않습니다.
                </p>
                <p
                  className={
                    copilotDraft.validation.valid
                      ? "pipeline-copilot-validation is-valid"
                      : "pipeline-copilot-validation is-invalid"
                  }
                  data-testid="pipeline-copilot-validation-status"
                  role="status"
                >
                  {copilotMode === "patch"
                    ? copilotDraft.validation.valid
                      ? "적용 가능한 수정 제안"
                      : "적용할 수 없는 수정 제안"
                    : copilotDraft.validation.valid
                      ? "적용 가능한 초안"
                      : "적용할 수 없는 초안"}
                  {" · "}
                  노드 {copilotDraft.graph.nodes.length}개 · 연결선{" "}
                  {copilotDraft.graph.edges.length}개
                  {copilotMode === "patch" ? ` · 수정 작업 ${copilotPatchOps.length}건` : ""}
                  {copilotDraft.model ? ` · ${copilotDraft.model}` : ""}
                </p>
                {copilotMode === "patch" && (
                  <div className="pipeline-copilot-ops-block" data-testid="pipeline-copilot-operations">
                    <strong>제안된 변경사항</strong>
                    {copilotIsNoop ? (
                      <p className="form-hint" data-testid="pipeline-copilot-noop">
                        변경할 내용이 없습니다
                      </p>
                    ) : (
                      <ul className="pipeline-copilot-op-list">
                        {copilotPatchOps.map((operation, index) => (
                          <li key={`${operation.op}-${index}`}>
                            {describeCopilotPatchOperation(operation)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {(copilotDraft.warnings || []).length > 0 && (
                  <ul className="pipeline-copilot-warnings" data-testid="pipeline-copilot-warnings">
                    {copilotDraft.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
                {!copilotDraft.validation.valid && (
                  <>
                    <p className="form-hint" data-testid="pipeline-copilot-apply-blocked">
                      {copilotMode === "patch"
                        ? "이 수정 제안은 적용할 수 없습니다. 아래 오류를 확인한 뒤 설명을 수정하고 다시 생성하세요."
                        : "이 초안은 아직 적용할 수 없습니다. 아래 오류를 확인한 뒤 설명을 수정하고 다시 생성하세요."}
                    </p>
                    <ul data-testid="pipeline-copilot-validation-errors">
                      {(copilotDraft.validation.errors || []).map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </>
                )}
                {copilotDraft.validation.valid && copilotIsNoop && (
                  <p className="form-hint" data-testid="pipeline-copilot-apply-blocked">
                    변경할 내용이 없습니다. 적용 버튼이 비활성화되어 있습니다.
                  </p>
                )}
              </div>
              <div className="pipeline-copilot-preview-label">
                <span className="eyebrow">읽기 전용 미리보기</span>
              </div>
              <div
                className="pipeline-copilot-preview-canvas"
                data-testid="pipeline-copilot-preview-canvas"
                aria-label={
                  copilotMode === "patch"
                    ? "읽기 전용 Copilot 수정 제안 미리보기"
                    : "읽기 전용 Copilot 초안 미리보기"
                }
              >
                <ReactFlow
                  nodes={copilotPreviewNodes}
                  edges={copilotPreviewEdges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  edgesReconnectable={false}
                  deleteKeyCode={null}
                  panOnDrag
                  zoomOnScroll
                >
                  <Background />
                  <Controls />
                </ReactFlow>
              </div>
              <div className="pipeline-copilot-preview-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="pipeline-copilot-apply"
                  disabled={!copilotCanApply}
                  title={
                    copilotCanApply
                      ? "적용하기 전에 확인 단계에서 내용을 검토하세요"
                      : copilotIsNoop
                        ? "변경할 내용이 없습니다"
                        : copilotMode === "patch"
                          ? "이 수정 제안은 적용할 수 없습니다"
                          : "이 초안은 아직 적용할 수 없습니다"
                  }
                  onClick={() => setCopilotConfirming(true)}
                >
                  {copilotMode === "patch" ? "변경사항 적용" : "편집기에 적용"}
                </button>
              </div>
            </div>
          )}

          {copilotDraft && copilotConfirming && (
            <div className="pipeline-copilot-confirm" data-testid="pipeline-copilot-confirm">
              {copilotMode === "patch" ? (
                <>
                  <h3>이 수정 제안을 적용할까요?</h3>
                  <p>
                    현재 그래프를 기준으로 생성된 수정 제안을 편집기에 적용합니다. 적용은 편집기
                    메모리의 그래프를 변경하는 동작이며, 버전 저장·게시·일정 등록·실행은 자동으로
                    수행되지 않습니다.
                  </p>
                  <p className="form-hint">
                    적용 후 실행 취소(Undo)로 적용 전 그래프로 되돌릴 수 있습니다.
                  </p>
                  {dirty && (
                    <p className="form-hint" data-testid="pipeline-copilot-dirty-warning">
                      기존의 저장되지 않은 그래프 변경사항을 기반으로 수정한 결과이며, 적용 후에도
                      버전 저장이 필요합니다.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3>이 초안을 적용할까요?</h3>
                  <p>
                    이 초안을 적용하면 현재 편집 중인 그래프가 제안된 전체 그래프로 대체됩니다.
                    적용은 편집기 메모리의 그래프를 변경하는 동작이며, 버전 저장·게시·일정 등록·실행은
                    자동으로 수행되지 않습니다.
                  </p>
                  <p className="form-hint">
                    적용 후 실행 취소(Undo)로 적용 전 그래프로 되돌릴 수 있습니다.
                  </p>
                  {dirty && (
                    <p className="form-hint" data-testid="pipeline-copilot-dirty-warning">
                      저장하지 않은 변경사항이 있다면 대체될 수 있습니다. 마지막으로 저장된
                      파이프라인 버전은 변경되지 않습니다.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}

function describeCopilotPatchOperation(operation: PipelineCopilotPatchOperation): string {
  switch (operation.op) {
    case "add_node":
      return `노드 추가 ${operation.node.id}`;
    case "update_node": {
      const parts: string[] = [`노드 수정 ${operation.node_id}`];
      if (operation.label) parts.push(`label → ${operation.label}`);
      if (operation.config_patch) {
        for (const [key, value] of Object.entries(operation.config_patch)) {
          parts.push(`${key} → ${formatCopilotPatchValue(value)}`);
        }
      }
      if (operation.position) {
        parts.push(`position → (${operation.position.x}, ${operation.position.y})`);
      }
      return parts.join(" · ");
    }
    case "remove_node":
      return `노드 삭제 ${operation.node_id}`;
    case "add_edge":
      return `연결 추가 ${operation.edge.id || `${operation.edge.source}→${operation.edge.target}`}`;
    case "update_edge": {
      const parts: string[] = [`연결 수정 ${operation.edge_id}`];
      if (operation.branch) parts.push(`branch → ${operation.branch}`);
      if ("sourceHandle" in operation) {
        parts.push(`sourceHandle → ${String(operation.sourceHandle)}`);
      }
      if ("targetHandle" in operation) {
        parts.push(`targetHandle → ${String(operation.targetHandle)}`);
      }
      return parts.join(" · ");
    }
    case "remove_edge":
      return `연결 삭제 ${operation.edge_id}`;
    default:
      return "제안된 변경";
  }
}

function formatCopilotPatchValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return String(value);
  }
}

function artifactSnippet(value: unknown): string {
  if (value == null) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return String(value);
  }
}

export function PipelineRunDetail() {
  const { projectId, runId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [version, setVersion] = useState<PipelineVersion | null>(null);
  const [versionError, setVersionError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState("");
  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  useEffect(() => {
    let active = true;
    const load = () =>
      api<PipelineRun>(`/projects/${projectId}/pipeline-runs/${runId}`)
        .then((row) => {
          if (!active) return;
          setRun(row);
        })
        .catch(
          (reason) =>
            active &&
            setError(reason instanceof Error ? reason.message : "Pipeline run could not be loaded."),
        );
    void load();
    const timer = window.setInterval(load, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectId, runId]);

  useEffect(() => {
    if (!run?.pipeline_version_id || !projectId) return;
    let cancelled = false;
    setVersionError("");
    api<PipelineVersion>(`/projects/${projectId}/pipeline-versions/${run.pipeline_version_id}`)
      .then((row) => {
        if (!cancelled) setVersion(row);
      })
      .catch((reason) => {
        if (!cancelled) {
          setVersion(null);
          setVersionError(
            reason instanceof Error ? reason.message : "Historical pipeline version could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, run?.pipeline_version_id]);

  async function rerunFromFailed() {
    setRerunning(true);
    setError("");
    try {
      const restarted = await api<PipelineRun>(
        `/projects/${projectId}/pipeline-runs/${runId}/rerun-from-failed`,
        { method: "POST" },
      );
      setRun(restarted);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline run could not be restarted.");
    } finally {
      setRerunning(false);
    }
  }

  const usedRerun =
    run != null &&
    Object.values(run.node_states).some((state) => (state.attempt ?? 1) > 1);

  const graphNodes = useMemo(() => {
    if (!run || !version?.graph) return [] as StepNode[];
    return toStepNodes(version.graph.nodes).map((node) => {
      const state = run.node_states[node.id];
      return {
        ...node,
        data: {
          ...node.data,
          label: state?.label || node.data.label,
          runStatus: state?.status,
        },
        selected: node.id === selectedId,
      };
    });
  }, [run, selectedId, version]);

  const graphEdges = useMemo(
    () => (version?.graph ? toDisplayEdges(version.graph.edges, graphNodes) : []),
    [graphNodes, version],
  );

  useEffect(() => {
    if (!run || selectedId) return;
    const failed = Object.entries(run.node_states).find(([, state]) => state.status === "failed");
    if (failed) {
      setSelectedId(failed[0]);
      return;
    }
    const firstGraph = version?.graph.nodes?.[0]?.id;
    if (firstGraph) setSelectedId(firstGraph);
    else {
      const firstState = Object.keys(run.node_states)[0];
      if (firstState) setSelectedId(firstState);
    }
  }, [run, selectedId, version]);

  const selectedState = run && selectedId ? run.node_states[selectedId] : undefined;
  const selectedGraphNode = graphNodes.find((node) => node.id === selectedId);
  const selectedLabel =
    selectedState?.label ||
    selectedGraphNode?.data.label ||
    selectedId ||
    "Step";
  const selectedType =
    selectedState?.node_type || selectedGraphNode?.data.node_type || undefined;
  const selectedAttempt = selectedState?.attempt ?? 1;
  const selectedArtifact = run && selectedId ? run.node_artifacts?.[selectedId] : undefined;

  const versionPending = Boolean(run?.pipeline_version_id && !version && !versionError);
  const useCardFallback = Boolean(
    run && !versionPending && (!version?.graph?.nodes || version.graph.nodes.length === 0),
  );

  return (
    <div className="page-stack pipeline-run-page">
      <PageHeader
        title={`Pipeline run #${runId}`}
        description="Step-level execution state against the immutable historical pipeline version."
        actions={
          <>
            <span className="header-status">
              <StatusBadge status={run?.status} />
            </span>
            {canWrite && run?.status === "failed" && (
              <button
                className="btn"
                disabled={rerunning}
                data-testid="pipeline-rerun"
                onClick={() => void rerunFromFailed()}
              >
                {rerunning ? "Restarting…" : "↻ Rerun from failed"}
              </button>
            )}
          </>
        }
      />
      {version ? (
        <div className="builder-state-band pipeline-run-version-band" role="status">
          <span className="builder-state-copy">Historical graph</span>
          <span className="version-chip" data-testid="pipeline-run-version-chip">
            v{version.version}
          </span>
          <span className="muted mono">version id #{version.id}</span>
        </div>
      ) : null}
      <ErrorNotice message={error || versionError} />
      {!run ? (
        <Loading label="Loading pipeline run" />
      ) : (
        <>
          {usedRerun && (
            <p className="muted pipeline-rerun-note" data-testid="pipeline-rerun-note">
              Rerun from failed was used. Restarted steps show Attempt 2 or higher.
            </p>
          )}
          {run.status === "failed" && run.error_message && (
            <div className="pipeline-validation-errors pipeline-run-failed-banner">
              <strong>Run failed</strong>
              <p>{run.error_message}</p>
            </div>
          )}

          {versionPending ? (
            <Loading label="Loading pipeline version graph" />
          ) : useCardFallback ? (
            <div className="card-grid pipeline-run-steps">
              {Object.entries(run.node_states).map(([id, state]) => {
                const title = state.label || id;
                const attempt = state.attempt ?? 1;
                return (
                  <article
                    className={`source-card pipeline-run-step status-${state.status || "pending"}`}
                    key={id}
                    data-testid={`pipeline-run-step-${id}`}
                  >
                    <span className="eyebrow">
                      {state.node_type ? labelForType(state.node_type) : "Step"}
                    </span>
                    <h2>{title}</h2>
                    <StatusBadge status={state.status} />
                    <p className="pipeline-run-attempt" data-testid={`pipeline-run-attempt-${id}`}>
                      Attempt {attempt}
                    </p>
                    <small className="muted pipeline-node-id mono">Node id: {id}</small>
                    {state.branch && <p className="muted">Selected branch: {state.branch}</p>}
                    {state.reason && <p className="muted">{state.reason}</p>}
                    {state.error && <p className="error">{state.error}</p>}
                  </article>
                );
              })}
              {Object.keys(run.node_states).length === 0 && (
                <EmptyState
                  title="No steps in this run"
                  description="This pipeline version contains an empty graph."
                />
              )}
            </div>
          ) : (
            <div className="pipeline-run-layout pipeline-run-workspace">
              <div
                className="pipeline-canvas"
                aria-label="Pipeline run graph"
                data-testid="pipeline-run-canvas"
              >
                <ReactFlow
                  nodes={graphNodes}
                  edges={graphEdges}
                  nodeTypes={nodeTypes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable
                  onNodeClick={(_, node) => setSelectedId(node.id)}
                  fitView
                >
                  <Background />
                  <MiniMap />
                  <Controls />
                </ReactFlow>
              </div>
              <aside className="pipeline-run-inspector panel">
                {selectedId ? (
                  <div
                    className="pipeline-run-inspector-body"
                    data-testid={`pipeline-run-step-${selectedId}`}
                  >
                    <span className="eyebrow">
                      {selectedType ? labelForType(selectedType) : "Step"}
                    </span>
                    <h2>{selectedLabel}</h2>
                    <div className="pipeline-run-inspector-status">
                      <StatusBadge status={selectedState?.status || "pending"} />
                      <p
                        className="pipeline-run-attempt"
                        data-testid={`pipeline-run-attempt-${selectedId}`}
                      >
                        Attempt {selectedAttempt}
                      </p>
                    </div>
                    <dl className="pipeline-run-inspector-meta">
                      <div>
                        <dt>Node id</dt>
                        <dd className="mono pipeline-node-id">{selectedId}</dd>
                      </div>
                      {selectedState?.branch ? (
                        <div>
                          <dt>Branch</dt>
                          <dd>{selectedState.branch}</dd>
                        </div>
                      ) : null}
                      {selectedState?.started_at ? (
                        <div>
                          <dt>Started</dt>
                          <dd className="catalog-meta-date">{formatDate(selectedState.started_at)}</dd>
                        </div>
                      ) : null}
                      {selectedState?.finished_at ? (
                        <div>
                          <dt>Finished</dt>
                          <dd className="catalog-meta-date">{formatDate(selectedState.finished_at)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {selectedState?.reason && (
                      <p className="muted pipeline-run-reason">{selectedState.reason}</p>
                    )}
                    {selectedState?.error && (
                      <p className="error pipeline-run-error">{selectedState.error}</p>
                    )}
                    {selectedArtifact != null && (
                      <div className="pipeline-run-artifact-block">
                        <span className="eyebrow">Artifacts</span>
                        <pre className="code-block engineering-surface">
                          {artifactSnippet(selectedArtifact)}
                        </pre>
                      </div>
                    )}
                    {selectedState?.output != null && (
                      <div className="pipeline-run-artifact-block">
                        <span className="eyebrow">Output</span>
                        <pre className="code-block engineering-surface">
                          {artifactSnippet(selectedState.output)}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted">Select a step on the graph to inspect execution details.</p>
                )}
              </aside>
            </div>
          )}

          <section className="panel pipeline-run-logs-section">
            <span className="eyebrow">Execution</span>
            <h2>Logs</h2>
            <div className="logs engineering-surface">{run.logs || "Waiting for execution…"}</div>
          </section>
        </>
      )}
    </div>
  );
}
