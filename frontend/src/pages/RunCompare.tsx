import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, Run } from "../api";

type Compare = { runs: Run[]; metric_keys: string[]; param_keys: string[] };

export default function RunCompare() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIds = params.get("run_ids") || "";

  useEffect(() => {
    if (!runIds) {
      setError("Select at least two runs to compare.");
      return;
    }
    api<Compare>(`/api/projects/${projectId}/runs/compare?run_ids=${encodeURIComponent(runIds)}`)
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, [projectId, runIds]);

  return (
    <div>
      <h1>Compare runs</h1>
      <p className="lead">Side-by-side metrics and parameters.</p>
      {error && <div className="error">{error}</div>}
      {data && (
        <div className="panel">
          <h2>Metrics</h2>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                {data.runs.map((r) => (
                  <th key={r.run_id} className="mono">{r.run_id.slice(0, 8)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.metric_keys.map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  {data.runs.map((r) => (
                    <td key={r.run_id} className="mono">{r.metrics[k]?.toFixed?.(4) ?? "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Parameters</h2>
          <table>
            <thead>
              <tr>
                <th>Param</th>
                {data.runs.map((r) => (
                  <th key={r.run_id} className="mono">{r.run_id.slice(0, 8)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.param_keys.map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  {data.runs.map((r) => (
                    <td key={r.run_id} className="mono">{r.params[k] ?? "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
