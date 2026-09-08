import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Alert, type Dataset, type Endpoint, type Job } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge } from "../components";
import {
  buildHomeNextActions,
  countActiveJobs,
  countAttentionAlerts,
  countFailedJobs,
  type HomeStats,
} from "../operationsHelpers";
import { useProject } from "../ProjectContext";

export default function Dashboard() {
  const { projects, selectedProject, loading: projectLoading } = useProject();
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedProject) {
      setStats(null);
      setJobs([]);
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
          running: countActiveJobs(trainingJobs),
          failed: countFailedJobs(trainingJobs),
          endpoints: endpoints.length,
          unreadAlerts: alerts.length,
          attentionAlerts: countAttentionAlerts(alerts),
        });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Dashboard could not be loaded."));
  }, [selectedProject]);

  const nextActions = useMemo(
    () => (selectedProject && stats ? buildHomeNextActions(selectedProject.id, stats) : []),
    [selectedProject, stats],
  );

  return (
    <div className="ops-page">
      <PageHeader
        title="Workspace home"
        description="See what needs attention in the selected project and choose the next supported action."
        actions={<Link className="btn" to="/projects/new">Create project</Link>}
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
          <section className="panel ops-context-panel" data-testid="home-current-project">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Current project</span>
                <h2>{selectedProject.name}</h2>
                <p className="muted">
                  {selectedProject.description || "Selected project context for workspace activity."}
                </p>
              </div>
              <Link className="btn secondary" to={`/projects/${selectedProject.id}`}>
                View overview
              </Link>
            </div>
          </section>

          {!stats ? (
            <Loading label="Calculating project activity" />
          ) : (
            <>
              {(stats.failed > 0 || stats.attentionAlerts > 0) && (
                <section className="panel ops-attention-panel" data-testid="home-attention">
                  <span className="eyebrow">Needs attention</span>
                  <ul className="ops-signal-list">
                    {stats.failed > 0 && (
                      <li>
                        <Link to={`/projects/${selectedProject.id}/jobs`}>
                          {stats.failed} failed training job{stats.failed === 1 ? "" : "s"}
                        </Link>
                      </li>
                    )}
                    {stats.attentionAlerts > 0 && (
                      <li>
                        <Link to={`/projects/${selectedProject.id}/alerts`}>
                          {stats.attentionAlerts} alert{stats.attentionAlerts === 1 ? "" : "s"} needing attention
                        </Link>
                      </li>
                    )}
                  </ul>
                </section>
              )}

              <div className="grid stats-grid" data-testid="home-stats">
                <div className="stat">
                  <div className="label">Workspace projects</div>
                  <div className="value">{projects.length}</div>
                </div>
                <div className="stat">
                  <div className="label">Datasets</div>
                  <div className="value">{stats.datasets}</div>
                </div>
                <div className="stat">
                  <div className="label">Training jobs</div>
                  <div className="value">{stats.jobs}</div>
                  <small>{stats.running} active</small>
                </div>
                <div className={`stat${stats.failed > 0 ? " is-attention" : ""}`}>
                  <div className="label">Failed jobs</div>
                  <div className="value">{stats.failed}</div>
                </div>
                <div className="stat">
                  <div className="label">Deployments</div>
                  <div className="value">{stats.endpoints}</div>
                </div>
                <div className={`stat${stats.attentionAlerts > 0 ? " is-attention" : ""}`}>
                  <div className="label">Unread alerts</div>
                  <div className="value">{stats.unreadAlerts}</div>
                  {stats.unreadAlerts > 0 && (
                    <small>
                      <Link to={`/projects/${selectedProject.id}/alerts`}>Open alerts</Link>
                    </small>
                  )}
                </div>
              </div>
            </>
          )}

          <div className="two-column">
            <section className="panel">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Recent activity</span>
                  <h2>Training jobs</h2>
                </div>
                <Link to={`/projects/${selectedProject.id}/jobs`}>View all</Link>
              </div>
              {jobs.length === 0 ? (
                <EmptyState
                  title="No training jobs"
                  description="Upload a dataset, then configure your first training run."
                  action={
                    <Link className="btn secondary" to={`/projects/${selectedProject.id}/datasets`}>
                      Add data
                    </Link>
                  }
                />
              ) : (
                <div className="activity-list">
                  {jobs.map((job) => (
                    <Link key={job.id} to={`/projects/${selectedProject.id}/jobs/${job.id}`}>
                      <div>
                        <strong>{job.name}</strong>
                        <small>{job.algorithm}</small>
                      </div>
                      <StatusBadge status={job.status} />
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="panel" data-testid="home-next-actions">
              <span className="eyebrow">Next actions</span>
              <h2>Continue from here</h2>
              <div className="action-list">
                {nextActions.map((action, index) => (
                  <Link
                    key={action.id}
                    to={action.to}
                    className={action.attention ? "is-attention" : undefined}
                    data-testid={`home-next-action-${action.id}`}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{action.title}</strong>
                      <small>{action.description}</small>
                    </div>
                    →
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
