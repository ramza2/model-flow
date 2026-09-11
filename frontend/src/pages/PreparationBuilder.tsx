import {
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
import { Link, useBeforeUnload, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Dataset,
  type DatasetPreparation,
  type DatasetPreparationNodeType,
  type DatasetPreparationPreviewResult,
  type DatasetPreparationValidationResult,
  type DatasetVersion,
} from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, Loading, SuccessNotice } from "../components";
import {
  PREPARATION_FLOW_NODE_TYPE,
  PREPARATION_NODE_LIBRARY,
  apiGraphToFlow,
  defaultConfigForPreparation,
  flowToApiGraph,
  formatKeyList,
  labelForPreparationType,
  nextPreparationNodeId,
  parseKeyList,
  preparationConfigSummary,
  staggerPreparationPosition,
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
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [preparation, setPreparation] = useState<DatasetPreparation | null>(null);
  const [nodes, setNodes] = useState<PrepNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [validation, setValidation] = useState<DatasetPreparationValidationResult | null>(
    null,
  );
  const [preview, setPreview] = useState<DatasetPreparationPreviewResult | null>(null);
  const previewSeqRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
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
  }, []);

  const markGraphEdited = useCallback(() => {
    setDirty(true);
    setValidation(null);
    clearPreview();
  }, [clearPreview]);

  const load = useCallback(async () => {
    try {
      const [row, datasetRows] = await Promise.all([
        api<DatasetPreparation>(
          `/projects/${projectId}/dataset-preparations/${preparationId}`,
        ),
        api<Dataset[]>(`/projects/${projectId}/datasets`).catch(() => [] as Dataset[]),
      ]);
      const graph = row.version?.graph || { schema_version: 1 as const, nodes: [], edges: [] };
      const flow = apiGraphToFlow(graph);
      setPreparation(row);
      setNodes(toPrepNodes(flow.nodes));
      setEdges(toPrepEdges(flow.edges));
      setDatasets(datasetRows);
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
      const version = await api(
        `/projects/${projectId}/dataset-preparations/${preparationId}/versions`,
        { method: "POST", body: JSON.stringify({ graph }) },
      );
      setDirty(false);
      setSuccess("Version saved.");
      setPreparation((prev) =>
        prev
          ? {
              ...prev,
              latest_version:
                (version as { version?: number }).version ?? prev.latest_version + 1,
              version: version as DatasetPreparation["version"],
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
      if (seq === previewSeqRef.current) {
        setPreview(result);
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Preview failed.");
      setPreview(null);
    } finally {
      if (seq === previewSeqRef.current) setBusy("");
    }
  }

  function onBack(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    if (!window.confirm("You have unsaved changes. Leave without saving?")) {
      event.preventDefault();
    }
  }

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
            <button
              type="button"
              className="btn"
              data-testid="preparation-save-version"
              disabled={busy !== ""}
              onClick={() => void saveVersion()}
            >
              {busy === "save" ? "Saving…" : "Save version"}
            </button>
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

      <div
        className={`builder-layout-3zone${!canWrite ? " is-readonly" : ""}`}
        data-testid="preparation-builder-layout"
        data-readonly={canWrite ? "false" : "true"}
      >
        {canWrite && (
          <aside className="preparation-node-library panel">
            <span className="eyebrow">Node library</span>
            <p className="form-hint">Click a node type to add it to the canvas.</p>
            <ul className="preparation-library-list">
              {PREPARATION_NODE_LIBRARY.map((item) => (
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
                    Add dataset sources, then join or union them into a single output.
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
                <div>
                  <dt>Output dataset</dt>
                  <dd>
                    {preparation.output_dataset_id == null
                      ? "Not configured"
                      : `#${preparation.output_dataset_id}`}
                  </dd>
                </div>
              </dl>
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
            </>
          )}
        </aside>
      </div>

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
            onChange({
              ...config,
              dataset_id: value ? Number(value) : null,
              dataset_version_id:
                strategy === "fixed" ? config.dataset_version_id ?? null : undefined,
            });
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
  return (
    <div className="preparation-inspector-form" data-testid="preparation-union-inspector">
      <label>
        Mode
        <select
          data-testid="preparation-union-mode"
          disabled={!canWrite}
          value={String(config.mode || "strict")}
          onChange={(event) => onChange({ ...config, mode: event.target.value })}
        >
          <option value="strict">strict</option>
          <option value="align_by_name">align_by_name</option>
        </select>
      </label>
    </div>
  );
}
