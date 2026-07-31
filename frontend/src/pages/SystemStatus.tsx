import { useEffect, useState } from "react";
import { api, SystemStatus } from "../api";

function pill(v: string) {
  const cls = v === "ok" ? "ok" : "err";
  return <span className={`badge ${cls}`}>{v}</span>;
}

export default function SystemStatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SystemStatus>("/api/system/status").then(setStatus).catch((e) => setError(String(e.message || e)));
  }, []);

  return (
    <div>
      <h1>System status</h1>
      <p className="lead">Connectivity for the API, database, object storage, and experiment tracker.</p>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <tbody>
            <tr><th>API</th><td>{status ? pill(status.api) : "…"}</td></tr>
            <tr><th>Database</th><td>{status ? pill(status.database) : "…"}</td></tr>
            <tr><th>Object storage</th><td>{status ? pill(status.minio) : "…"}</td></tr>
            <tr><th>Experiment tracker</th><td>{status ? pill(status.mlflow) : "…"}</td></tr>
            <tr><th>Pending jobs</th><td>{status?.pending_jobs ?? "—"}</td></tr>
            <tr><th>Running jobs</th><td>{status?.running_jobs ?? "—"}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
