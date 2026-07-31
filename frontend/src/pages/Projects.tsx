import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Project } from "../api";

export default function Projects() {
  const [items, setItems] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Project[]>("/api/projects").then(setItems).catch((e) => setError(String(e.message || e)));
  }, []);

  return (
    <div>
      <div className="row-actions" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Projects</h1>
          <p className="lead">Each project groups datasets, experiments, models, and endpoints.</p>
        </div>
        <Link className="btn" to="/projects/new">New project</Link>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Description</th><th>Created</th></tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/projects/${p.id}`}>{p.name}</Link></td>
                <td className="muted">{p.description || "—"}</td>
                <td className="mono">{new Date(p.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={3} className="muted">No projects yet. Create one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
