import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, Endpoint, RegisteredModel } from "../api";

export default function Endpoints() {
  const { projectId } = useParams();
  const location = useLocation() as { state?: { modelName?: string; modelVersion?: string } };
  const [items, setItems] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [name, setName] = useState("predict-v1");
  const [modelName, setModelName] = useState(location.state?.modelName || "");
  const [modelVersion, setModelVersion] = useState(location.state?.modelVersion || "");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [e, m] = await Promise.all([
      api<Endpoint[]>(`/api/projects/${projectId}/endpoints`),
      api<RegisteredModel[]>(`/api/projects/${projectId}/models`),
    ]);
    setItems(e);
    setModels(m);
    if (!modelName && m[0]) {
      setModelName(m[0].name);
      setModelVersion(m[0].latest_versions[0]?.version || "");
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(String(err.message || err)));
  }, [projectId]);

  const versions = models.find((m) => m.name === modelName)?.latest_versions || [];

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/projects/${projectId}/endpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, model_name: modelName, model_version: modelVersion }),
      });
      await refresh();
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  }

  return (
    <div>
      <h1>Inference endpoints</h1>
      <p className="lead">Serve a registered model version for local predictions.</p>
      {error && <div className="error">{error}</div>}
      <form className="panel form" onSubmit={onCreate}>
        <label>
          Endpoint name
          <input value={name} onChange={(e) => setName(e.target.value)} required data-testid="endpoint-name" />
        </label>
        <label>
          Model
          <select value={modelName} onChange={(e) => setModelName(e.target.value)} required data-testid="endpoint-model">
            {models.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Version
          <select value={modelVersion} onChange={(e) => setModelVersion(e.target.value)} required data-testid="endpoint-version">
            {versions.map((v) => (
              <option key={v.version} value={v.version}>v{v.version}</option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit" disabled={!modelName || !modelVersion} data-testid="endpoint-create">
          Create endpoint
        </button>
      </form>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Model</th><th>Status</th><th>Requests</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((ep) => (
              <tr key={ep.id}>
                <td>{ep.name}</td>
                <td className="mono">{ep.model_name}:v{ep.model_version}</td>
                <td><span className="badge ok">{ep.status}</span></td>
                <td>{ep.request_count}</td>
                <td><Link to={`/projects/${projectId}/endpoints/${ep.id}/predict`}>Test inference</Link></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="muted">No endpoints yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
