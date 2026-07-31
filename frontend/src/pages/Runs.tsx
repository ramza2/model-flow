import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Run } from "../api";

export default function Runs() {
  const { projectId } = useParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Run[]>(`/api/projects/${projectId}/runs`).then(setRuns).catch((e) => setError(String(e.message || e)));
  }, [projectId]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div>
      <div className="row-actions" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Experiment runs</h1>
          <p className="lead">Parameters, metrics, and artifacts recorded in MLflow.</p>
        </div>
        <Link
          className="btn secondary"
          to={`/projects/${projectId}/runs/compare?run_ids=${selected.join(",")}`}
          style={{ pointerEvents: selected.length < 2 ? "none" : undefined, opacity: selected.length < 2 ? 0.5 : 1 }}
        >
          Compare selected ({selected.length})
        </Link>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr><th></th><th>Run</th><th>Status</th><th>Metrics</th><th>Params</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id}>
                <td>
                  <input type="checkbox" checked={selected.includes(r.run_id)} onChange={() => toggle(r.run_id)} />
                </td>
                <td className="mono">{r.run_id.slice(0, 12)}</td>
                <td><span className="badge">{r.status}</span></td>
                <td className="mono muted">{Object.entries(r.metrics).map(([k, v]) => `${k}=${v.toFixed?.(4) ?? v}`).join(", ") || "—"}</td>
                <td className="mono muted">{r.params.algorithm || r.params.task || "—"}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet. Complete a training job first.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
