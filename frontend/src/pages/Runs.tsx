import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Run } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";

export default function Runs() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    api<Run[]>(`/projects/${projectId}/experiments/runs${query}`)
      .then((rows) => {
        setRuns(rows);
        const requested = params.get("run");
        if (requested && rows.some((run) => run.run_id === requested)) setSelected([requested]);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Experiment runs could not be loaded."))
      .finally(() => setLoading(false));
  }, [params, projectId, search]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div>
      <PageHeader
        title="Experiments"
        description="Compare tracked parameters and metrics across model training runs."
        actions={<Link
          className="btn secondary"
          to={`/projects/${projectId}/experiments/compare?run_ids=${selected.join(",")}`}
          aria-disabled={selected.length < 2}
          onClick={(event) => selected.length < 2 && event.preventDefault()}
        >
          Compare selected ({selected.length})
        </Link>}
      />
      <ErrorNotice message={error} />
      <div className="filter-bar">
        <label>Search runs<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Run name or ID" /></label>
        <span>Select two or more runs to compare.</span>
      </div>
      {loading ? <Loading label="Loading experiments" /> : runs.length === 0 ? (
        <EmptyState title="No experiment runs" description="Completed training jobs record runs here automatically." action={<Link className="btn" to={`/projects/${projectId}/jobs/new`}>Start training</Link>} />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th aria-label="Select" /><th>Run</th><th>Status</th><th>Started</th><th>Metrics</th><th>Algorithm</th></tr></thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id} className={selected.includes(run.run_id) ? "selected-row" : ""}>
                  <td><input aria-label={`Select run ${run.run_id}`} type="checkbox" checked={selected.includes(run.run_id)} onChange={() => toggle(run.run_id)} /></td>
                  <td>
                    <Link to={`/projects/${projectId}/experiments/runs/${run.run_id}`}>
                      <strong>{run.tags["mlflow.runName"] || run.run_id.slice(0, 12)}</strong>
                    </Link>
                    <small className="table-subtitle mono">{run.run_id}</small>
                  </td>
                  <td><StatusBadge status={run.status} /></td>
                  <td>{formatDate(run.start_time)}</td>
                  <td className="mono">{Object.entries(run.metrics).slice(0, 2).map(([key, value]) => `${key} ${Number(value).toFixed(3)}`).join(" · ") || "—"}</td>
                  <td>{run.params.algorithm || run.params.task || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
