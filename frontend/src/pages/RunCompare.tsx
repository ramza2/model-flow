import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type Run } from "../api";
import { ErrorNotice, Loading, PageHeader, StatusBadge } from "../components";

type Compare = { runs: Run[]; metric_keys: string[]; param_keys: string[] };

export default function RunCompare() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState("");
  const runIds = params.get("run_ids") || "";

  useEffect(() => {
    if (!runIds) {
      setError("Select at least two runs to compare.");
      return;
    }
    api<Compare>(`/projects/${projectId}/experiments/runs/compare?run_ids=${encodeURIComponent(runIds)}`)
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Runs could not be compared."));
  }, [projectId, runIds]);

  return (
    <div>
      <PageHeader title="Compare runs" description="Review model quality and configuration differences side by side." />
      <ErrorNotice message={error} />
      {!data && !error ? <Loading label="Comparing runs" /> : data && (
        <>
          <div className="compare-header">
            <div />
            {data.runs.map((run) => <div key={run.run_id}><strong>{run.tags["mlflow.runName"] || run.run_id.slice(0, 8)}</strong><StatusBadge status={run.status} /><small className="mono">{run.run_id.slice(0, 12)}</small></div>)}
          </div>
        <div className="panel">
          <span className="eyebrow">Performance</span><h2>Metrics</h2>
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
                    <td key={r.run_id} className="mono">{r.metrics[k] === undefined ? "—" : Number(r.metrics[k]).toFixed(4)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <span className="eyebrow">Configuration</span><h2>Parameters</h2>
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
        </>
      )}
    </div>
  );
}
