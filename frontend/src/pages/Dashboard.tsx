import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Alert, type Dataset, type Endpoint, type Job } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge } from "../components";
import { useProject } from "../ProjectContext";

type ProjectStats = {
  datasets: number;
  jobs: number;
  running: number;
  failed: number;
  endpoints: number;
  unreadAlerts: number;
};

export default function Dashboard() {
  const { projects, selectedProject, loading: projectLoading } = useProject();
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedProject) {
      setStats(null);
      return;
    }
    setStats(null);
    setError("");
    Promise.all([
      api<Dataset[]>(`/projects/${selectedProject.id}/datasets`),
      api<Job[]>(`/projects/${selectedProject.id}/jobs`),
      api<Endpoint[]>(`/projects/${selectedProject.id}/endpoints`),
      api<Alert[]>(`/projects/${selectedProject.id}/alerts?is_read=false&is_resolved=false`),
    ])
      .then(([datasets, trainingJobs, endpoints, alerts]) => {
        setJobs(trainingJobs.slice(0, 5));
        setStats({
          datasets: datasets.length,
          jobs: trainingJobs.length,
          running: trainingJobs.filter((job) => ["pending", "queued", "running"].includes(job.status)).length,
          failed: trainingJobs.filter((job) => job.status === "failed").length,
          endpoints: endpoints.length,
          unreadAlerts: alerts.length,
        });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Dashboard could not be loaded."));
  }, [selectedProject]);

  return (
    <div>
      <PageHeader
        title="Workspace home"
        description="Move from trusted data to monitored predictions in one place."
        actions={<Link className="btn" to="/projects/new">＋ Create project</Link>}
      />
      <ErrorNotice message={error} />
      {projectLoading ? (
        <Loading label="Loading workspace" />
      ) : !selectedProject ? (
        <EmptyState
          title="Create your first project"
          description="Projects organize data, training, models, deployments, and access."
          action={<Link className="btn" to="/projects/new">Create project</Link>}
        />
      ) : (
        <>
          <div className="section-heading">
            <div>
              <span className="eyebrow">Current project</span>
              <h2>{selectedProject.name}</h2>
            </div>
            <Link to={`/projects/${selectedProject.id}`}>View project overview →</Link>
          </div>
          {!stats ? <Loading label="Calculating project activity" /> : (
            <div className="grid stats-grid">
              <div className="stat"><div className="label">Projects</div><div className="value">{projects.length}</div></div>
              <div className="stat"><div className="label">Datasets</div><div className="value">{stats.datasets}</div></div>
              <div className="stat"><div className="label">Training jobs</div><div className="value">{stats.jobs}</div><small>{stats.running} active</small></div>
              <div className="stat"><div className="label">Failed jobs</div><div className="value">{stats.failed}</div></div>
              <div className="stat"><div className="label">Deployments</div><div className="value">{stats.endpoints}</div></div>
              <div className="stat"><div className="label">Unread alerts</div><div className="value">{stats.unreadAlerts}</div></div>
            </div>
          )}
          <div className="two-column">
            <section className="panel">
              <div className="panel-title">
                <div><span className="eyebrow">Activity</span><h2>Recent training jobs</h2></div>
                <Link to={`/projects/${selectedProject.id}/jobs`}>View all</Link>
              </div>
              {jobs.length === 0 ? (
                <EmptyState
                  title="No training jobs"
                  description="Upload a dataset, then configure your first training run."
                  action={<Link className="btn secondary" to={`/projects/${selectedProject.id}/datasets`}>Add data</Link>}
                />
              ) : (
                <div className="activity-list">
                  {jobs.map((job) => (
                    <Link key={job.id} to={`/projects/${selectedProject.id}/jobs/${job.id}`}>
                      <div><strong>{job.name}</strong><small>{job.algorithm}</small></div>
                      <StatusBadge status={job.status} />
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="panel">
              <span className="eyebrow">Next actions</span>
              <h2>Keep your workflow moving</h2>
              <div className="action-list">
                <Link to={`/projects/${selectedProject.id}/datasets`}><span>1</span><div><strong>Add a dataset</strong><small>Upload CSV, JSON, or Parquet.</small></div>→</Link>
                <Link to={`/projects/${selectedProject.id}/jobs/new`}><span>2</span><div><strong>Train a model</strong><small>Choose data, target, and algorithm.</small></div>→</Link>
                <Link to={`/projects/${selectedProject.id}/monitoring`}><span>3</span><div><strong>Review operations</strong><small>Check service, data, and model health.</small></div>→</Link>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
