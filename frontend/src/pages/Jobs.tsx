import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Job } from "../api";
import { useAuth } from "../AuthContext";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";
import { effectiveTargetColumns } from "../jobHelpers";
import { TargetChips } from "../lifecycleComponents";
import { formatPrimaryMetric } from "../metricHelpers";
import { userCanProject, useProject } from "../ProjectContext";

export default function Jobs() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [items, setItems] = useState<Job[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canTrain = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

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
        description="Scan training work by status, then open a job for metrics, lineage, and logs."
        actions={canTrain ? <Link className="btn" to={`/projects/${projectId}/jobs/new`}>＋ New training job</Link> : undefined}
      />
      <ErrorNotice message={error} />
      <div className="workflow-catalog">
        <div className="filter-bar catalog-filter">
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <div className="catalog-summary" aria-live="polite">
            <span className="catalog-summary-count">{items.length}</span>
            <span className="catalog-summary-label">
              {items.length === 1 ? "job" : "jobs"}
              {status ? ` · ${status}` : ""}
            </span>
          </div>
        </div>
        {loading ? (
          <Loading label="Loading training jobs" />
        ) : items.length === 0 ? (
          <EmptyState
            title={status ? `No ${status} jobs` : "No training jobs"}
            description="Create a job from a versioned dataset to begin an experiment."
            action={!status && canTrain ? <Link className="btn" to={`/projects/${projectId}/jobs/new`}>Create training job</Link> : undefined}
          />
        ) : (
          <div className="panel table-wrap catalog-table">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Problem</th>
                  <th>Algorithm</th>
                  <th>Targets</th>
                  <th>Primary metric</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link className="catalog-primary-link" to={`/projects/${projectId}/jobs/${job.id}`}>
                        <strong>{job.name}</strong>
                      </Link>
                      <small className="table-subtitle">
                        <span className="mono">Dataset #{job.dataset_id}</span>
                        {job.description ? ` · ${job.description}` : ""}
                      </small>
                    </td>
                    <td><StatusBadge status={job.status} /></td>
                    <td>
                      <span className="type-chip">{job.problem_type}</span>
                    </td>
                    <td className="catalog-secondary-text">
                      {job.algorithm.replaceAll("_", " ")}
                    </td>
                    <td><TargetChips targets={effectiveTargetColumns(job)} /></td>
                    <td className="tabular-num">
                      {formatPrimaryMetric(job.metrics, {
                        problemType: job.problem_type,
                        targetColumns: effectiveTargetColumns(job),
                      })}
                    </td>
                    <td className="catalog-meta-date">{formatDate(job.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
