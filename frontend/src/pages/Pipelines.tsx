import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Pipeline, type PipelineGraph, type PipelineRun } from "../api";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";

const NODE_TYPES = [
  "dataset_load",
  "quality_check",
  "split",
  "preprocessing",
  "training",
  "evaluation",
  "condition",
  "model_registration",
  "approval_request",
  "endpoint_deployment",
  "batch_prediction",
  "notification",
] as const;

const labelFor = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export function Pipelines() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setPipelines(await api<Pipeline[]>(`/projects/${projectId}/pipelines`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipelines could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

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
      <PageHeader title="Pipelines" description="Build repeatable data, training, approval, and deployment workflows." actions={<button className="btn" onClick={() => setShowCreate(!showCreate)}>＋ New pipeline</button>} />
      <ErrorNotice message={error} />
      {showCreate && <form className="panel inline-form" onSubmit={create}><label>Pipeline name<input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Production training workflow" /></label><button className="btn">Create and open builder</button><button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>Cancel</button></form>}
      {loading ? <Loading label="Loading pipelines" /> : pipelines.length === 0 ? (
        <EmptyState title="No pipelines" description="Create a visual workflow to standardize your model lifecycle." action={<button className="btn" onClick={() => setShowCreate(true)}>Create pipeline</button>} />
      ) : (
        <div className="panel table-wrap">
          <table><thead><tr><th>Pipeline</th><th>Status</th><th>Version</th><th>Type</th><th>Created</th></tr></thead>
            <tbody>{pipelines.map((pipeline) => <tr key={pipeline.id}><td><Link to={`/projects/${projectId}/pipelines/${pipeline.id}`}><strong>{pipeline.name}</strong></Link><small className="table-subtitle">{pipeline.description || "Visual workflow"}</small></td><td><StatusBadge status={pipeline.status} /></td><td>v{pipeline.latest_version}</td><td>{pipeline.is_template ? "Template" : "Project pipeline"}</td><td>{formatDate(pipeline.created_at)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PipelineBuilder() {
  const { projectId, pipelineId } = useParams();
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [nodeType, setNodeType] = useState<(typeof NODE_TYPES)[number]>("dataset_load");
  const [selectedId, setSelectedId] = useState("");
  const [nodeConfig, setNodeConfig] = useState("{}");
  const [conditionBranch, setConditionBranch] = useState<"true" | "false" | "always">("true");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    try {
      const [row, runRows] = await Promise.all([
        api<Pipeline>(`/projects/${projectId}/pipelines/${pipelineId}`),
        api<PipelineRun[]>(`/projects/${projectId}/pipelines/${pipelineId}/runs`),
      ]);
      setPipeline(row);
      setNodes((row.version?.graph.nodes || []) as Node[]);
      setEdges((row.version?.graph.edges || []).map((edge, index) => ({ id: edge.id || `edge-${index}`, ...edge })));
      setRuns(runRows);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline could not be loaded.");
    }
  }, [pipelineId, projectId]);

  useEffect(() => { void load(); }, [load]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId), [nodes, selectedId]);

  function addNode() {
    const id = `${nodeType}-${Date.now()}`;
    const node: Node = {
      id,
      position: { x: 80 + (nodes.length % 3) * 240, y: 80 + Math.floor(nodes.length / 3) * 140 },
      data: { label: labelFor(nodeType), node_type: nodeType, config: {} },
    };
    setNodes((rows) => [...rows, node]);
    setSelectedId(id);
    setNodeConfig("{}");
  }

  function selectNode(node: Node) {
    setSelectedId(node.id);
    setNodeConfig(JSON.stringify((node.data.config as Record<string, unknown>) || {}, null, 2));
  }

  function updateConfig() {
    try {
      const parsed = JSON.parse(nodeConfig) as Record<string, unknown>;
      setNodes((rows) => rows.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, config: parsed } } : node));
      setSuccess("Node configuration applied locally. Save a version to persist it.");
      setError("");
    } catch {
      setError("Node configuration must be valid JSON.");
    }
  }

  const graph = (): PipelineGraph => ({
    nodes: nodes.map((node) => ({
      id: node.id,
      position: node.position,
      data: node.data as Record<string, unknown>,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      ...(edge.label ? { label: String(edge.label) } : {}),
      ...(edge.data ? { data: edge.data as PipelineGraph["edges"][number]["data"] } : {}),
    })) as PipelineGraph["edges"],
  });

  async function action(kind: "save" | "publish" | "run") {
    setBusy(kind);
    setError("");
    setSuccess("");
    try {
      if (kind === "save") {
        await api(`/projects/${projectId}/pipelines/${pipelineId}/versions`, { method: "POST", body: JSON.stringify({ graph: graph() }) });
        setSuccess("Pipeline version saved.");
      } else if (kind === "publish") {
        await api(`/projects/${projectId}/pipelines/${pipelineId}/publish`, { method: "POST" });
        setSuccess("Pipeline published.");
      } else {
        const run = await api<PipelineRun>(`/projects/${projectId}/pipelines/${pipelineId}/run`, { method: "POST", body: JSON.stringify({}) });
        navigate(`/projects/${projectId}/pipeline-runs/${run.id}`);
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Pipeline ${kind} failed.`);
    } finally {
      setBusy("");
    }
  }

  if (!pipeline) return <><ErrorNotice message={error} /><Loading label="Loading pipeline builder" /></>;

  return (
    <div className="pipeline-page">
      <PageHeader
        title={pipeline.name}
        description={`Visual pipeline builder · version ${pipeline.latest_version}`}
        actions={<><StatusBadge status={pipeline.status} /><button className="btn secondary" disabled={Boolean(busy)} onClick={() => action("save")}>{busy === "save" ? "Saving…" : "Save version"}</button><button className="btn secondary" disabled={Boolean(busy)} onClick={() => action("publish")}>Publish</button><button className="btn" disabled={Boolean(busy)} onClick={() => action("run")}>▶ Run pipeline</button></>}
      />
      <ErrorNotice message={error} /><SuccessNotice message={success} />
      <div className="builder-layout">
        <aside className="builder-sidebar panel">
          <span className="eyebrow">Add step</span>
          <select value={nodeType} onChange={(event) => setNodeType(event.target.value as (typeof NODE_TYPES)[number])}>{NODE_TYPES.map((type) => <option value={type} key={type}>{labelFor(type)}</option>)}</select>
          <button className="btn btn-wide" onClick={addNode}>＋ Add to canvas</button>
          <p className="form-hint">Connect steps by dragging between their handles.</p>
          <label>Condition edge branch
            <select value={conditionBranch} onChange={(event) => setConditionBranch(event.target.value as "true" | "false" | "always")}>
              <option value="true">True</option>
              <option value="false">False</option>
              <option value="always">Always</option>
            </select>
            <small className="form-hint">Applied when the connection starts from a condition step.</small>
          </label>
          {selectedNode && <>
            <hr />
            <span className="eyebrow">Selected step</span>
            <h2>{String(selectedNode.data.label)}</h2>
            <label>Configuration<textarea className="code-input" value={nodeConfig} onChange={(event) => setNodeConfig(event.target.value)} spellCheck={false} /></label>
            <button className="btn secondary btn-wide" onClick={updateConfig}>Apply configuration</button>
            <button className="btn link danger-text" onClick={() => { setNodes((rows) => rows.filter((node) => node.id !== selectedId)); setEdges((rows) => rows.filter((edge) => edge.source !== selectedId && edge.target !== selectedId)); setSelectedId(""); }}>Remove step</button>
          </>}
        </aside>
        <div className="pipeline-canvas" aria-label="Pipeline graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes: NodeChange[]) => setNodes((rows) => applyNodeChanges(changes, rows))}
            onEdgesChange={(changes: EdgeChange[]) => setEdges((rows) => applyEdgeChanges(changes, rows))}
            onConnect={(connection: Connection) => {
              const source = nodes.find((node) => node.id === connection.source);
              const isCondition = source?.data.node_type === "condition";
              const edge = isCondition
                ? { ...connection, label: conditionBranch, data: { branch: conditionBranch } }
                : connection;
              setEdges((rows) => addEdge(edge, rows));
            }}
            onNodeClick={(_, node) => selectNode(node)}
            fitView
          >
            <Background />
            <MiniMap />
            <Controls />
          </ReactFlow>
        </div>
      </div>
      <section className="panel">
        <div className="panel-title"><div><span className="eyebrow">History</span><h2>Pipeline runs</h2></div></div>
        {runs.length === 0 ? <p className="muted">No runs yet.</p> : <div className="activity-list">{runs.map((run) => <Link key={run.id} to={`/projects/${projectId}/pipeline-runs/${run.id}`}><div><strong>Run #{run.id}</strong><small>{formatDate(run.created_at)}</small></div><StatusBadge status={run.status} /></Link>)}</div>}
      </section>
    </div>
  );
}

export function PipelineRunDetail() {
  const { projectId, runId } = useParams();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = () => api<PipelineRun>(`/projects/${projectId}/pipeline-runs/${runId}`).then((row) => active && setRun(row)).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Pipeline run could not be loaded."));
    void load();
    const timer = window.setInterval(load, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, runId]);

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

  return <div>
    <PageHeader title={`Pipeline run #${runId}`} description="Step-level execution state and logs." actions={<><StatusBadge status={run?.status} />{run?.status === "failed" && <button className="btn" disabled={rerunning} onClick={rerunFromFailed}>{rerunning ? "Restarting…" : "↻ Rerun from failed"}</button>}</>} />
    <ErrorNotice message={error} />
    {!run ? <Loading label="Loading pipeline run" /> : <>
      <div className="card-grid">{Object.entries(run.node_states).map(([id, state]) => <article className="source-card" key={id}><span className="eyebrow">Step</span><h2>{id}</h2><StatusBadge status={state.status} />{state.branch && <p className="muted">Selected branch: {state.branch}</p>}{state.reason && <p className="muted">{state.reason}</p>}{state.error && <p className="error">{state.error}</p>}</article>)}</div>
      {Object.keys(run.node_states).length === 0 && <EmptyState title="No steps in this run" description="This pipeline version contains an empty graph." />}
      <section className="panel"><span className="eyebrow">Execution</span><h2>Logs</h2><div className="logs">{run.logs || "Waiting for execution…"}</div></section>
    </>}
  </div>;
}
