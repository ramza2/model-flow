import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ModelVersion as ModelVersionType } from "../api";

export default function ModelVersion() {
  const { projectId, modelName, version } = useParams();
  const [mv, setMv] = useState<ModelVersionType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ModelVersionType>(`/api/models/${encodeURIComponent(modelName!)}/versions/${version}`)
      .then(setMv)
      .catch((e) => setError(String(e.message || e)));
  }, [modelName, version]);

  return (
    <div>
      <h1>Model version</h1>
      <p className="lead">{mv ? `${mv.name} · v${mv.version}` : "Loading…"}</p>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table>
          <tbody>
            <tr><th>Status</th><td><span className="badge">{mv?.status}</span></td></tr>
            <tr><th>Run</th><td className="mono">{mv?.run_id || "—"}</td></tr>
            <tr><th>Source</th><td className="mono muted">{mv?.source || "—"}</td></tr>
          </tbody>
        </table>
        {mv && (
          <div className="row-actions" style={{ marginTop: "1rem" }}>
            <Link
              className="btn"
              to={`/projects/${projectId}/endpoints`}
              state={{ modelName: mv.name, modelVersion: mv.version }}
            >
              Create endpoint from this version
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
