import {
  memo,
  useCallback,
  useEffect,
  useMemo,
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
  api,
  type Dataset,
  type DatasetVersion,
  type Pipeline,
  type PipelineGraph,
  type PipelineRun,
  type PipelineVersion,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";
import { NodeConfigForm } from "../pipelineForms";
import {
  PIPELINE_NODE_LIBRARY,
  configSummary,
  defaultConfigFor,
  edgeBranch,
  labelForType,
  nodeConfigWarnings,
  parseValidationIssue,
  type ConditionBranch,
  type PipelineNodeType,
} from "../pipelineHelpers";
import { userCanProject, useProject } from "../ProjectContext";

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
      <span className="pipeline-step-type">{labelForType(data.node_type)}</span>
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

let pipelineNodeSeq = 0;

function nextPipelineNodeId(nodeType: string): string {
  pipelineNodeSeq += 1;
  return `${nodeType}-${pipelineNodeSeq}`;
}

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

  return (
    <div>
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
      {canWrite && showCreate && (
        <form className="panel inline-form" onSubmit={create} data-testid="pipeline-create-form">
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
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Status</th>
                <th>Version</th>
                <th>Type</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.map((pipeline) => (
                <tr key={pipeline.id}>
                  <td>
                    <Link to={`/projects/${projectId}/pipelines/${pipeline.id}`}>
                      <strong>{pipeline.name}</strong>
                    </Link>
                    <small className="table-subtitle">
                      {pipeline.description || "Visual workflow"}
                    </small>
                  </td>
                  <td>
                    <StatusBadge status={pipeline.status} />
                  </td>
                  <td>v{pipeline.latest_version}</td>
                  <td>{pipeline.is_template ? "Template" : "Project pipeline"}</td>
                  <td>{formatDate(pipeline.created_at)}</td>
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationVisible, setValidationVisible] = useState(false);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<string[]>([]);
  const [upstreamColumns, setUpstreamColumns] = useState<string[]>([]);
  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const load = useCallback(async () => {
    try {
      const [row, runRows, datasetRows] = await Promise.all([
        api<Pipeline>(`/projects/${projectId}/pipelines/${pipelineId}`),
        api<PipelineRun[]>(`/projects/${projectId}/pipelines/${pipelineId}/runs`),
        api<Dataset[]>(`/projects/${projectId}/datasets`).catch(() => [] as Dataset[]),
      ]);
      const nextNodes = toStepNodes(row.version?.graph.nodes);
      setPipeline(row);
      setNodes(nextNodes);
      setEdges(toDisplayEdges(row.version?.graph.edges, nextNodes));
      setRuns(runRows);
      setDatasets(datasetRows);
      setDirty(false);
      setValidationErrors([]);
      setValidationVisible(false);
      setHighlightedNodeIds([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline could not be loaded.");
    }
  }, [pipelineId, projectId]);

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

  function selectNode(node: StepNode) {
    setSelectedId(node.id);
    setJsonText(JSON.stringify(node.data.config || {}, null, 2));
    setJsonError("");
  }

  function updateSelectedData(partial: Partial<StepData>, nextConfig?: Record<string, unknown>) {
    if (!selectedId) return;
    setDirty(true);
    setNodes((rows) =>
      rows.map((node) => {
        if (node.id !== selectedId) return node;
        const config = nextConfig ?? node.data.config;
        const data = { ...node.data, ...partial, config };
        return { ...node, data };
      }),
    );
    if (nextConfig) {
      setJsonText(JSON.stringify(nextConfig, null, 2));
      setJsonError("");
    }
  }

  function onConfigChange(next: Record<string, unknown>) {
    updateSelectedData({}, next);
  }

  function onJsonChange(text: string) {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError("Configuration must be a JSON object.");
        return;
      }
      setJsonError("");
      setDirty(true);
      setNodes((rows) =>
        rows.map((node) =>
          node.id === selectedId
            ? { ...node, data: { ...node.data, config: parsed as Record<string, unknown> } }
            : node,
        ),
      );
    } catch {
      setJsonError("Invalid JSON — changes are not applied until the text parses.");
    }
  }

  function addNodeOfType(nodeType: PipelineNodeType) {
    const id = nextPipelineNodeId(nodeType);
    const node: StepNode = {
      id,
      type: STEP_NODE_TYPE,
      position: {
        x: 80 + (nodes.length % 3) * 240,
        y: 80 + Math.floor(nodes.length / 3) * 160,
      },
      data: {
        label: labelForType(nodeType),
        node_type: nodeType,
        config: defaultConfigFor(nodeType),
      },
    };
    setNodes((rows) => [...rows, node]);
    setSelectedId(id);
    setJsonText(JSON.stringify(node.data.config, null, 2));
    setJsonError("");
    setDirty(true);
    setValidationErrors([]);
    setValidationVisible(false);
  }

  function removeSelected() {
    if (!selectedId) return;
    setNodes((rows) => rows.filter((node) => node.id !== selectedId));
    setEdges((rows) =>
      rows.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
    );
    setSelectedId("");
    setDirty(true);
  }

  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => {
    const marksDirty = changes.some(
      (change) =>
        change.type === "remove" ||
        change.type === "add" ||
        (change.type === "position" && change.dragging === false),
    );
    if (marksDirty) setDirty(true);
    setNodes((rows) => applyNodeChanges(changes, rows));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (changes.some((change) => change.type === "remove" || change.type === "add")) {
      setDirty(true);
    }
    setEdges((rows) => applyEdgeChanges(changes, rows));
  }, []);

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

  async function validateCurrentGraph(): Promise<boolean> {
    const result = await api<ValidationResult>(
      `/projects/${projectId}/pipelines/${pipelineId}/validate`,
      { method: "POST", body: JSON.stringify({ graph: graph() }) },
    );
    setValidationVisible(true);
    if (!result.valid) {
      setValidationErrors(result.errors || ["Pipeline graph is invalid."]);
      setHighlightedNodeIds(extractHighlightedNodeIds(result.errors || [], nodes.map((n) => n.id)));
      return false;
    }
    setValidationErrors([]);
    setHighlightedNodeIds([]);
    return true;
  }

  async function runValidate() {
    setBusy("validate");
    setError("");
    setSuccess("");
    try {
      const ok = await validateCurrentGraph();
      setSuccess(ok ? "Pipeline graph is valid." : "");
      if (!ok) setError("Fix validation errors before continuing.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline validation failed.");
    } finally {
      setBusy("");
    }
  }

  async function action(kind: "save" | "publish" | "run") {
    setBusy(kind);
    setError("");
    setSuccess("");
    try {
      if (kind === "save") {
        await api(`/projects/${projectId}/pipelines/${pipelineId}/versions`, {
          method: "POST",
          body: JSON.stringify({ graph: graph() }),
        });
        setDirty(false);
        setSuccess("Pipeline version saved.");
        setValidationErrors([]);
        setValidationVisible(false);
        await load();
        return;
      }
      if (dirty) {
        setError("Save your changes before publishing or running.");
        return;
      }
      const ok = await validateCurrentGraph();
      if (!ok) {
        setError("Fix validation errors before continuing.");
        return;
      }
      if (kind === "publish") {
        await api(`/projects/${projectId}/pipelines/${pipelineId}/publish`, { method: "POST" });
        setSuccess("Pipeline published.");
        await load();
      } else {
        const run = await api<PipelineRun>(`/projects/${projectId}/pipelines/${pipelineId}/run`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        navigate(`/projects/${projectId}/pipeline-runs/${run.id}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Pipeline ${kind} failed.`);
    } finally {
      setBusy("");
    }
  }

  function confirmLeave(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    const ok = window.confirm(
      "Unsaved pipeline changes\n\nYour latest changes have not been saved as a pipeline version. Leave anyway?",
    );
    if (!ok) event.preventDefault();
  }

  if (!pipeline) {
    return (
      <>
        <ErrorNotice message={error} />
        <Loading label="Loading pipeline builder" />
      </>
    );
  }

  const actionsDisabled = Boolean(busy);
  const publishRunDisabled = actionsDisabled || dirty;

  return (
    <div className="pipeline-page">
      <header className="pipeline-builder-header">
        <div className="pipeline-builder-header-meta">
          <Link
            className="pipeline-back-link"
            to={`/projects/${projectId}/pipelines`}
            onClick={confirmLeave}
          >
            ← Pipelines
          </Link>
          <div>
            <h1>{pipeline.name}</h1>
            <p className="muted">
              <StatusBadge status={pipeline.status} /> · v{pipeline.latest_version}
            </p>
          </div>
        </div>
        <div className="pipeline-builder-header-actions">
          {dirty && (
            <span className="pipeline-dirty-badge" data-testid="pipeline-dirty-badge">
              Unsaved changes
            </span>
          )}
          {canWrite && (
            <>
              <button
                className="btn secondary"
                disabled={actionsDisabled}
                data-testid="pipeline-validate"
                onClick={() => void runValidate()}
              >
                {busy === "validate" ? "Validating…" : "Validate"}
              </button>
              <button
                className="btn secondary"
                disabled={actionsDisabled}
                data-testid="pipeline-save"
                onClick={() => void action("save")}
              >
                {busy === "save" ? "Saving…" : "Save version"}
              </button>
              <button
                className="btn secondary"
                disabled={publishRunDisabled}
                title={dirty ? "Save your changes before publishing" : undefined}
                data-testid="pipeline-publish"
                onClick={() => void action("publish")}
              >
                Publish
              </button>
              <button
                className="btn"
                disabled={publishRunDisabled}
                title={dirty ? "Save your changes before running" : undefined}
                data-testid="pipeline-run"
                onClick={() => void action("run")}
              >
                ▶ Run pipeline
              </button>
            </>
          )}
        </div>
      </header>
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {dirty && (
        <p className="form-hint" data-testid="pipeline-dirty-hint">
          Save a version before publish or run. Changes are not auto-saved.
        </p>
      )}

      <div className="builder-layout-3zone">
        {canWrite && (
          <aside className="pipeline-node-library panel">
            <span className="eyebrow">Node library</span>
            <p className="form-hint">Click a step type to add it to the canvas.</p>
            {PIPELINE_NODE_LIBRARY.map((group) => (
              <div className="pipeline-library-category" key={group.category}>
                <strong>{group.category}</strong>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.type}>
                      <button
                        type="button"
                        className="pipeline-library-item"
                        data-testid={`pipeline-library-${item.type}`}
                        onClick={() => addNodeOfType(item.type)}
                        title={item.description}
                      >
                        <span aria-hidden="true">{item.icon}</span>
                        <span>{labelForType(item.type)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {/* Backward-compatible add control used by unit/e2e tests */}
            <button
              className="btn btn-wide secondary"
              data-testid="pipeline-add-node"
              onClick={() => addNodeOfType("dataset_load")}
            >
              ＋ Add Dataset Load
            </button>
          </aside>
        )}

        <div className="pipeline-canvas" aria-label="Pipeline graph" data-testid="pipeline-canvas">
          {nodes.length === 0 ? (
            <div className="pipeline-empty-canvas">
              <h2>Start with a dataset</h2>
              <p className="muted">
                Add a Dataset Load step, then connect quality checks, training, and deployment.
              </p>
              {canWrite && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => addNodeOfType("dataset_load")}
                >
                  Add Dataset Load
                </button>
              )}
            </div>
          ) : (
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(connection: Connection) => {
                const source = nodes.find((node) => node.id === connection.source);
                const isCondition = source?.data.node_type === "condition";
                const handle = connection.sourceHandle;
                const branch: ConditionBranch =
                  handle === "true" || handle === "false" || handle === "always"
                    ? handle
                    : "always";
                const edge = isCondition
                  ? {
                      ...connection,
                      sourceHandle: branch,
                      label: branch.toUpperCase(),
                      className: `pipeline-edge-${branch}`,
                      data: { branch },
                    }
                  : connection;
                setDirty(true);
                setEdges((rows) => addEdge(edge, rows));
              }}
              onNodeClick={(_, node) => selectNode(node as StepNode)}
              fitView
            >
              <Background />
              <MiniMap />
              <Controls />
            </ReactFlow>
          )}
        </div>

        <aside className="pipeline-inspector panel">
          {!selectedNode ? (
            <>
              <span className="eyebrow">Pipeline</span>
              <h2>{pipeline.name}</h2>
              <p className="muted">{pipeline.description || "No description yet."}</p>
              <dl className="pipeline-inspector-meta">
                <div>
                  <dt>Status</dt>
                  <dd>
                    <StatusBadge status={pipeline.status} />
                  </dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>v{pipeline.latest_version}</dd>
                </div>
                <div>
                  <dt>Nodes</dt>
                  <dd>{nodes.length}</dd>
                </div>
              </dl>
              <p className="form-hint">
                Select a step on the canvas to configure it, or add one from the node library.
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">General</span>
              <label>
                Step name
                <input
                  data-testid="pipeline-step-name"
                  value={selectedNode.data.label}
                  disabled={!canWrite}
                  onChange={(event) => updateSelectedData({ label: event.target.value })}
                />
              </label>
              <p className="form-hint" data-testid="pipeline-step-type">
                Type: {labelForType(selectedNode.data.node_type)}
              </p>
              <small className="muted pipeline-node-id" data-testid="pipeline-node-id">
                Node id: {selectedNode.id}
              </small>

              <hr />
              <span className="eyebrow">Configuration</span>
              {canWrite ? (
                <NodeConfigForm
                  projectId={String(projectId)}
                  nodeType={selectedNode.data.node_type}
                  config={selectedNode.data.config || {}}
                  onChange={onConfigChange}
                  upstreamDatasetId={upstreamDatasetId}
                  datasetColumns={upstreamColumns}
                />
              ) : (
                <p className="muted">Read-only configuration.</p>
              )}

              <details className="advanced-json">
                <summary>Advanced JSON</summary>
                <label>
                  Configuration
                  <textarea
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
                  <span className="eyebrow">Danger</span>
                  <button className="btn link danger-text" onClick={removeSelected}>
                    Remove step
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
              <span className="eyebrow">Validation</span>
              <h2>
                {validationErrors.length === 0
                  ? "No issues"
                  : `${validationErrors.length} issue${validationErrors.length === 1 ? "" : "s"}`}
              </h2>
            </div>
          </div>
          {validationErrors.length === 0 ? (
            <p className="muted">Graph validation passed.</p>
          ) : (
            <ul className="pipeline-validation-list">
              {validationIssues.map((issue) => (
                <li key={issue.message}>
                  <button
                    type="button"
                    className="pipeline-validation-issue"
                    onClick={() => {
                      if (!issue.nodeId) return;
                      const node = nodes.find((row) => row.id === issue.nodeId);
                      if (node) selectNode(node);
                    }}
                  >
                    <strong>
                      {issue.nodeId
                        ? nodes.find((row) => row.id === issue.nodeId)?.data.label ||
                          issue.nodeId
                        : "Graph"}
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
    </div>
  );
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
    <div>
      <PageHeader
        title={`Pipeline run #${runId}`}
        description={
          version
            ? `Historical graph · pipeline version v${version.version}`
            : "Step-level execution state and logs."
        }
        actions={
          <>
            <StatusBadge status={run?.status} />
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
      <ErrorNotice message={error || versionError} />
      {!run ? (
        <Loading label="Loading pipeline run" />
      ) : (
        <>
          {usedRerun && (
            <p className="muted pipeline-rerun-note" data-testid="pipeline-rerun-note">
              Rerun from failed was used. Successful upstream steps were reused.
            </p>
          )}
          {run.status === "failed" && run.error_message && (
            <div className="pipeline-validation-errors">
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
                    className="source-card pipeline-run-step"
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
                    <small className="muted pipeline-node-id">Node id: {id}</small>
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
            <div className="pipeline-run-layout">
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
                  <div data-testid={`pipeline-run-step-${selectedId}`}>
                    <span className="eyebrow">
                      {selectedType ? labelForType(selectedType) : "Step"}
                    </span>
                    <h2>{selectedLabel}</h2>
                    <StatusBadge status={selectedState?.status || "pending"} />
                    <p
                      className="pipeline-run-attempt"
                      data-testid={`pipeline-run-attempt-${selectedId}`}
                    >
                      Attempt {selectedAttempt}
                    </p>
                    <small className="muted pipeline-node-id">Node id: {selectedId}</small>
                    {selectedState?.branch && (
                      <p className="muted">Selected branch: {selectedState.branch}</p>
                    )}
                    {selectedState?.started_at && (
                      <p className="muted">Started: {formatDate(selectedState.started_at)}</p>
                    )}
                    {selectedState?.finished_at && (
                      <p className="muted">Finished: {formatDate(selectedState.finished_at)}</p>
                    )}
                    {selectedState?.reason && <p className="muted">{selectedState.reason}</p>}
                    {selectedState?.error && <p className="error">{selectedState.error}</p>}
                    {selectedArtifact != null && (
                      <>
                        <span className="eyebrow">Artifacts</span>
                        <pre className="code-block">{artifactSnippet(selectedArtifact)}</pre>
                      </>
                    )}
                    {selectedState?.output != null && (
                      <>
                        <span className="eyebrow">Output</span>
                        <pre className="code-block">{artifactSnippet(selectedState.output)}</pre>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="muted">Select a step on the graph to inspect execution details.</p>
                )}
              </aside>
            </div>
          )}

          <section className="panel">
            <span className="eyebrow">Execution</span>
            <h2>Logs</h2>
            <div className="logs">{run.logs || "Waiting for execution…"}</div>
          </section>
        </>
      )}
    </div>
  );
}
