import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Run } from "../api";
import { ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";

export default function RunDetail() {
  const { projectId, runId } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId || !runId) {
      return;
    }
    setLoading(true);
    api<Run>(`/projects/${projectId}/experiments/runs/${runId}`)
      .then(setRun)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Experiment run could not be loaded."))
      .finally(() => setLoading(false));
  }, [projectId, runId]);

  const displayName = run?.tags["mlflow.runName"] || run?.run_id || "Experiment run";

  return (
    <div>
      <PageHeader
        title={displayName}
        description="Tracked parameters, metrics, tags, and artifact lineage for this MLflow run."
        actions={run ? <StatusBadge status={run.status} /> : undefined}
      />
      <ErrorNotice message={error} />
      {loading ? <Loading label="Loading experiment run" /> : !run ? null : (
        <>
          <div className="row-actions toolbar-actions">
            <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>← Back to experiments</Link>
            <Link
              className="btn secondary"
              to={`/projects/${projectId}/experiments/compare?run_ids=${run.run_id}`}
            >
              Compare this run
            </Link>
          </div>
          <div className="two-column">
            <section className="panel">
              <span className="eyebrow">Run</span>
              <h2>Summary</h2>
              <dl className="key-values">
                <div><dt>Run ID</dt><dd className="mono break-word">{run.run_id}</dd></div>
                <div><dt>Status</dt><dd><StatusBadge status={run.status} /></dd></div>
                <div><dt>Started</dt><dd>{run.start_time ? formatDate(new Date(run.start_time).toISOString()) : "—"}</dd></div>
                <div><dt>Finished</dt><dd>{run.end_time ? formatDate(new Date(run.end_time).toISOString()) : "—"}</dd></div>
                <div><dt>Artifact URI</dt><dd className="mono break-word">{run.artifact_uri || "—"}</dd></div>
              </dl>
            </section>
            <section className="panel">
              <span className="eyebrow">Tags</span>
              <h2>Run tags</h2>
              {Object.keys(run.tags).length === 0 ? (
                <p>—</p>
              ) : (
                <dl className="key-values">
                  {Object.entries(run.tags).map(([key, value]) => (
                    <div key={key}><dt>{key}</dt><dd className="mono break-word">{value}</dd></div>
                  ))}
                </dl>
              )}
            </section>
          </div>
          <div className="two-column">
            <section className="panel">
              <span className="eyebrow">Metrics</span>
              <h2>Logged metrics</h2>
              {Object.keys(run.metrics).length === 0 ? (
                <p>—</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Metric</th><th>Value</th></tr></thead>
                    <tbody>
                      {Object.entries(run.metrics).map(([key, value]) => (
                        <tr key={key}><td className="mono">{key}</td><td>{Number(value).toFixed(6)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel">
              <span className="eyebrow">Parameters</span>
              <h2>Run parameters</h2>
              <pre className="json-view">{JSON.stringify(run.params, null, 2)}</pre>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
