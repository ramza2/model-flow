import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, type Endpoint, type ModelVersion } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  metric,
} from "../components";
import { userCanProject, useProject } from "../ProjectContext";

export default function Endpoints() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const location = useLocation() as { state?: { modelVersionId?: number } };
  const [items, setItems] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [name, setName] = useState("prediction-service");
  const [modelVersionId, setModelVersionId] = useState(String(location.state?.modelVersionId || ""));
  const [showCreate, setShowCreate] = useState(Boolean(location.state?.modelVersionId));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canDeploy = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const refresh = useCallback(async () => {
    const [e, m] = await Promise.all([
      api<Endpoint[]>(`/projects/${projectId}/endpoints`),
      api<ModelVersion[]>(`/projects/${projectId}/models`),
    ]);
    setItems(e);
    const deployable = m.filter((model) => ["APPROVED", "PRODUCTION"].includes(model.lifecycle));
    setModels(deployable);
    setModelVersionId((current) => current || String(deployable[0]?.id || ""));
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Deployments could not be loaded.");
    });
  }, [refresh]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy("create");
    try {
      await api(`/projects/${projectId}/endpoints`, {
        method: "POST",
        body: JSON.stringify({ name, model_version_id: Number(modelVersionId) }),
      });
      await refresh();
      setShowCreate(false);
      setSuccess("Deployment is ready for predictions.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment could not be created.");
    } finally {
      setBusy("");
    }
  }

  async function endpointAction(endpoint: Endpoint, action: "start" | "stop") {
    if (action === "stop" && !confirmAction(`Stop deployment “${endpoint.name}”? Predictions will be unavailable.`)) return;
    setBusy(`${action}-${endpoint.id}`);
    setError("");
    try {
      await api(`/endpoints/${endpoint.id}/${action}`, { method: "POST" });
      setSuccess(action === "start" ? "Deployment started." : "Deployment stopped.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Deployment could not ${action}.`);
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <PageHeader title="Deployments" description="Serve approved model versions and verify live predictions." actions={canDeploy ? <div className="row-actions"><Link className="btn secondary" to={`/projects/${projectId}/deployments/batch`}>Batch inference</Link><button className="btn" onClick={() => setShowCreate(!showCreate)}>＋ New deployment</button></div> : undefined} />
      <ErrorNotice message={error} /><SuccessNotice message={success} />
      {canDeploy && showCreate && <form className="panel form" onSubmit={onCreate}>
        <div className="panel-title"><div><span className="eyebrow">Online prediction</span><h2>Create deployment</h2></div></div>
        {models.length === 0 && <div className="notice">Approve a model version before creating a deployment.</div>}
        <label>Deployment name<input value={name} onChange={(event) => setName(event.target.value)} required data-testid="endpoint-name" /></label>
        <label>Approved model<select value={modelVersionId} onChange={(event) => setModelVersionId(event.target.value)} required data-testid="endpoint-model"><option value="">Select a model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} · v{model.version} · {model.lifecycle.toLowerCase()}</option>)}</select></label>
        <div className="row-actions"><button className="btn" disabled={!modelVersionId || busy === "create"} data-testid="endpoint-create">{busy === "create" ? "Creating…" : "Create deployment"}</button><button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>Cancel</button></div>
      </form>}
      {loading ? <Loading label="Loading deployments" /> : items.length === 0 ? (
        <EmptyState title="No deployments" description="Approve a registered model, then create a prediction service." action={canDeploy ? <button className="btn" onClick={() => setShowCreate(true)}>Create deployment</button> : undefined} />
      ) : (
        <div className="deployment-grid">
          {items.map((endpoint) => <article className="deployment-card" key={endpoint.id}>
            <header><div><span className="eyebrow">Online service</span><h2>{endpoint.name}</h2></div><StatusBadge status={endpoint.status} /></header>
            <p className="mono">{endpoint.model_name} · v{endpoint.model_version}</p>
            <div className="deployment-metrics">
              <div><strong>{endpoint.request_count.toLocaleString()}</strong><span>Requests</span></div>
              <div><strong>{endpoint.success_rate === null ? "—" : `${metric(endpoint.success_rate * 100, 1)}%`}</strong><span>Success</span></div>
              <div><strong>{endpoint.average_latency_ms === null ? "—" : `${metric(endpoint.average_latency_ms, 1)} ms`}</strong><span>Avg latency</span></div>
              <div><strong>{metric(endpoint.latency_p95_ms, 1)} ms</strong><span>p95 latency</span></div>
            </div>
            <footer>
              <Link className="btn" to={`/projects/${projectId}/deployments/${endpoint.id}/predict`} data-testid={`endpoint-predict-${endpoint.id}`}>Test prediction</Link>
              <Link className="btn secondary" to={`/projects/${projectId}/deployments/${endpoint.id}/api`} data-testid={`endpoint-api-usage-${endpoint.id}`}>API usage</Link>
              {canDeploy && (endpoint.status === "ready" ? <button className="btn secondary" disabled={Boolean(busy)} onClick={() => endpointAction(endpoint, "stop")}>Stop</button> : <button className="btn secondary" disabled={Boolean(busy)} onClick={() => endpointAction(endpoint, "start")}>Start</button>)}
            </footer>
          </article>)}
        </div>
      )}
    </div>
  );
}
