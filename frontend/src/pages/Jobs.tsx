import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Job } from "../api";

function statusBadge(status: string) {
  const cls = status === "succeeded" ? "ok" : status === "failed" ? "err" : status === "running" ? "run" : "warn";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export default function Jobs() {
  const { projectId } = useParams();
  const [items, setItems] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Job[]>(`/api/projects/${projectId}/jobs`)
        .then((d) => alive && setItems(d))
        .catch((e) => alive && setError(String(e.message || e)));
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId]);

  return (
    <div>
      <div className="row-actions" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Training jobs</h1>
          <p className="lead">Status and logs for queued and completed training work.</p>
        </div>
        <Link className="btn" to={`/projects/${projectId}/jobs/new`}>New job</Link>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Status</th><th>Target</th><th>Run</th><th>Created</th></tr>
          </thead>
          <tbody>
            {items.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/projects/${projectId}/jobs/${j.id}`}>{j.name}</Link></td>
                <td>{statusBadge(j.status)}</td>
                <td className="mono">{j.target_column}</td>
                <td className="mono muted">{j.mlflow_run_id?.slice(0, 8) || "—"}</td>
                <td className="mono">{new Date(j.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="muted">No training jobs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
