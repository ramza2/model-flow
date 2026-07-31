import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, RegisteredModel, Run } from "../api";

export default function Registry() {
  const { projectId } = useParams();
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [modelName, setModelName] = useState("classifier");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    const [m, r] = await Promise.all([
      api<RegisteredModel[]>(`/api/projects/${projectId}/models`),
      api<Run[]>(`/api/projects/${projectId}/runs`),
    ]);
    setModels(m);
    setRuns(r);
    if (!runId && r[0]) setRunId(r[0].run_id);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
  }, [projectId]);

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      const res = await api<{ name: string; version: string }>(`/api/projects/${projectId}/models/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, model_name: modelName }),
      });
      setMsg(`Registered ${res.name} v${res.version}`);
      await refresh();
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  }

  return (
    <div>
      <h1>Model registry</h1>
      <p className="lead">Promote experiment runs into versioned models.</p>
      {error && <div className="error">{error}</div>}
      {msg && <div className="panel">{msg}</div>}
      <form className="panel form" onSubmit={onRegister}>
        <label>
          Source run
          <select value={runId} onChange={(e) => setRunId(e.target.value)} required data-testid="register-run">
            {runs.map((r) => (
              <option key={r.run_id} value={r.run_id}>{r.run_id.slice(0, 12)} ({r.status})</option>
            ))}
          </select>
        </label>
        <label>
          Model name suffix
          <input value={modelName} onChange={(e) => setModelName(e.target.value)} required data-testid="register-name" />
        </label>
        <button className="btn" type="submit" disabled={!runId} data-testid="register-submit">Register version</button>
      </form>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Model</th><th>Latest versions</th></tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.name}>
                <td className="mono">{m.name}</td>
                <td>
                  {m.latest_versions.map((v) => (
                    <div key={v.version}>
                      <Link to={`/projects/${projectId}/models/${encodeURIComponent(m.name)}/versions/${v.version}`}>
                        v{v.version}
                      </Link>{" "}
                      <span className="badge">{v.status}</span>
                    </div>
                  ))}
                  {m.latest_versions.length === 0 && <span className="muted">No versions</span>}
                </td>
              </tr>
            ))}
            {models.length === 0 && <tr><td colSpan={2} className="muted">No registered models yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
