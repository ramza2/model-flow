import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ModelVersion, type Run } from "../api";
import { useAuth } from "../AuthContext";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, SuccessNotice, formatDate } from "../components";
import { formatPrimaryMetric } from "../metricHelpers";
import { userCanProject, useProject } from "../ProjectContext";

export default function Registry() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [modelName, setModelName] = useState("classifier");
  const [showRegister, setShowRegister] = useState(false);
  const [lifecycle, setLifecycle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    const [m, r] = await Promise.all([
      api<ModelVersion[]>(`/projects/${projectId}/models${lifecycle ? `?lifecycle=${lifecycle}` : ""}`),
      api<Run[]>(`/projects/${projectId}/experiments/runs`),
    ]);
    setModels(m);
    setRuns(r);
    setRunId((current) => current || r[0]?.run_id || "");
    setLoading(false);
  }, [lifecycle, projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Model registry could not be loaded.");
    });
  }, [refresh]);

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMsg("");
    try {
      const res = await api<ModelVersion>(`/projects/${projectId}/models/register`, {
        method: "POST",
        body: JSON.stringify({
          run_id: runId,
          name: modelName,
        }),
      });
      setMsg(`Registered ${res.name} v${res.version}`);
      setShowRegister(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Model could not be registered.");
    }
  }

  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  return (
    <div>
      <PageHeader
        title="Model Registry"
        description="Govern model versions from candidate through production."
        actions={canWrite ? <button className="btn" onClick={() => setShowRegister(!showRegister)}>＋ Register from run</button> : undefined}
      />
      <ErrorNotice message={error} /><SuccessNotice message={msg} />
      {showRegister && <form className="panel form" onSubmit={onRegister}>
        <div className="panel-title"><div><span className="eyebrow">New candidate</span><h2>Register experiment run</h2></div></div>
        <label>Source run<select value={runId} onChange={(event) => setRunId(event.target.value)} required data-testid="register-run">{runs.map((run) => <option key={run.run_id} value={run.run_id}>{run.tags["mlflow.runName"] || run.run_id.slice(0, 12)} ({run.status})</option>)}</select></label>
        <label>Model name<input value={modelName} onChange={(event) => setModelName(event.target.value)} required data-testid="register-name" /></label>
        <div className="row-actions"><button className="btn" disabled={!runId} data-testid="register-submit">Register version</button><button className="btn secondary" type="button" onClick={() => setShowRegister(false)}>Cancel</button></div>
      </form>}
      <div className="filter-bar"><label>Lifecycle<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}><option value="">All stages</option><option value="CANDIDATE">Candidate</option><option value="PENDING_APPROVAL">Pending approval</option><option value="APPROVED">Approved</option><option value="PRODUCTION">Production</option><option value="REJECTED">Rejected</option><option value="ARCHIVED">Archived</option></select></label><span>{models.length} version{models.length === 1 ? "" : "s"}</span></div>
      {loading ? <Loading label="Loading model registry" /> : models.length === 0 ? (
        <EmptyState title="No registered models" description="Register a successful training job or experiment run to start governance." />
      ) : (
        <div className="panel table-wrap">
          <table><thead><tr><th>Model</th><th>Version</th><th>Lifecycle</th><th>Gates</th><th>Primary metric</th><th>Registered</th></tr></thead>
            <tbody>{models.map((model) => <tr key={model.id}><td><Link to={`/projects/${projectId}/models/${model.id}`}><strong>{model.name}</strong></Link><small className="table-subtitle mono">{model.mlflow_run_id?.slice(0, 12)}</small></td><td>v{model.version}</td><td><StatusBadge status={model.lifecycle} /></td><td><StatusBadge status={model.gates_passed ? "passed" : "pending"} /></td><td>{formatPrimaryMetric(model.metrics, { problemType: typeof model.metadata?.problem_type === "string" ? model.metadata.problem_type : undefined, targetColumns: Array.isArray(model.metadata?.target_columns) ? model.metadata.target_columns.map(String) : [] })}</td><td>{formatDate(model.created_at)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
