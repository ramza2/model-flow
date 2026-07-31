import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Job } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";

export default function Jobs() {
  const { projectId } = useParams();
  const [items, setItems] = useState<Job[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Job[]>(`/projects/${projectId}/jobs${status ? `?status=${status}` : ""}`)
        .then((rows) => {
          if (alive) setItems(rows);
        })
        .catch((reason) => {
          if (alive) setError(reason instanceof Error ? reason.message : "Training jobs could not be loaded.");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId, status]);

  return (
    <div>
      <PageHeader
        title="Training Jobs"
        description="Configure, track, and reproduce model training work."
        actions={<Link className="btn" to={`/projects/${projectId}/jobs/new`}>＋ New training job</Link>}
      />
      <ErrorNotice message={error} />
      <div className="filter-bar">
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option><option value="pending">Pending</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option>
        </select></label>
        <span>{items.length} job{items.length === 1 ? "" : "s"}</span>
      </div>
      {loading ? <Loading label="Loading training jobs" /> : items.length === 0 ? (
        <EmptyState
          title={status ? `No ${status} jobs` : "No training jobs"}
          description="Create a job from a versioned dataset to begin an experiment."
          action={!status && <Link className="btn" to={`/projects/${projectId}/jobs/new`}>Create training job</Link>}
        />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Algorithm</th><th>Target</th><th>Metrics</th><th>Created</th></tr></thead>
            <tbody>
              {items.map((job) => (
                <tr key={job.id}>
                  <td><Link to={`/projects/${projectId}/jobs/${job.id}`}><strong>{job.name}</strong></Link><small className="table-subtitle">{job.description || `Job #${job.id}`}</small></td>
                  <td><StatusBadge status={job.status} /></td>
                  <td>{job.algorithm.replaceAll("_", " ")}</td>
                  <td className="mono">{job.target_column}</td>
                  <td>{Object.keys(job.metrics).length ? Object.entries(job.metrics).slice(0, 1).map(([key, value]) => `${key}: ${Number(value).toFixed(3)}`) : "—"}</td>
                  <td>{formatDate(job.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
