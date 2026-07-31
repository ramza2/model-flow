import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, DashboardStats } from "../api";

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardStats>("/api/dashboard")
      .then(setStats)
      .catch((e) => setError(String(e.message || e)));
  }, []);

  return (
    <div>
      <h1>Workspace home</h1>
      <p className="lead">Track datasets, train models, register versions, and test inference — end to end.</p>
      {error && <div className="error">{error}</div>}
      <div className="grid">
        <div className="stat"><div className="label">Projects</div><div className="value">{stats?.projects ?? "—"}</div></div>
        <div className="stat"><div className="label">Datasets</div><div className="value">{stats?.datasets ?? "—"}</div></div>
        <div className="stat"><div className="label">Training jobs</div><div className="value">{stats?.jobs ?? "—"}</div></div>
        <div className="stat"><div className="label">Succeeded</div><div className="value">{stats?.succeeded_jobs ?? "—"}</div></div>
        <div className="stat"><div className="label">Failed</div><div className="value">{stats?.failed_jobs ?? "—"}</div></div>
        <div className="stat"><div className="label">Endpoints</div><div className="value">{stats?.endpoints ?? "—"}</div></div>
      </div>
      <div className="panel" style={{ marginTop: "1.25rem" }}>
        <div className="row-actions">
          <Link className="btn" to="/projects/new">Create project</Link>
          <Link className="btn secondary" to="/projects">Browse projects</Link>
          <Link className="btn secondary" to="/system">Check system status</Link>
        </div>
      </div>
    </div>
  );
}
