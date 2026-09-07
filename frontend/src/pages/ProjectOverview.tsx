import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Alert,
  type Job,
  type Membership,
  type Project,
  type ProjectRole,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  formatDate,
} from "../components";
import { DetailSection } from "../lifecycleComponents";
import {
  countActiveJobs,
  countFailedJobs,
  factualSignalLines,
  type OverviewSignals,
} from "../operationsHelpers";
import { userCanProject, useProject } from "../ProjectContext";

type DataMetrics = {
  dataset_count: number;
  dataset_version_count: number;
  quality_check_count: number;
  failed_quality_check_count: number;
  latest_quality_status: string | null;
};

type ModelMetrics = {
  model_version_count: number;
  lifecycle_counts: Record<string, number>;
  endpoint_count: number;
  ready_endpoint_count: number;
  total_requests: number;
  total_errors: number;
  latest_drift_status: string | null;
};

export default function ProjectOverview() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectProject, refreshProjects } = useProject();
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dataMetrics, setDataMetrics] = useState<DataMetrics | null>(null);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics | null>(null);
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<ProjectRole>("VIEWER");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const projectRow = await api<Project>(`/projects/${projectId}`);
      const canManage = userCanProject(user, projectRow, "PROJECT_ADMIN");
      const [jobRows, dataRows, modelRows, alertRows, memberRows] = await Promise.all([
        api<Job[]>(`/projects/${projectId}/jobs`),
        api<DataMetrics>(`/projects/${projectId}/monitoring/data`),
        api<ModelMetrics>(`/projects/${projectId}/monitoring/models`),
        api<Alert[]>(`/projects/${projectId}/alerts?is_resolved=false`),
        canManage ? api<Membership[]>(`/projects/${projectId}/members`) : Promise.resolve([]),
      ]);
      setProject(projectRow);
      setName(projectRow.name);
      setDescription(projectRow.description);
      setJobs(jobRows);
      setDataMetrics(dataRows);
      setModelMetrics(modelRows);
      setOpenAlerts(alertRows);
      setMembers(memberRows);
      selectProject(projectRow.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectProject, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = userCanProject(user, project, "PROJECT_ADMIN");
  const canWriteData = userCanProject(user, project, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");
  const canTrain = userCanProject(user, project, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");
  const canBuildPipeline = userCanProject(user, project, "ML_ENGINEER", "PROJECT_ADMIN");

  const signals: OverviewSignals | null = useMemo(() => {
    if (!dataMetrics || !modelMetrics) return null;
    return {
      datasetCount: dataMetrics.dataset_count,
      failedQualityChecks: dataMetrics.failed_quality_check_count,
      latestQualityStatus: dataMetrics.latest_quality_status,
      jobCount: jobs.length,
      activeJobs: countActiveJobs(jobs),
      failedJobs: countFailedJobs(jobs),
      modelVersionCount: modelMetrics.model_version_count,
      productionModels: modelMetrics.lifecycle_counts.PRODUCTION ?? 0,
      lifecycleCounts: modelMetrics.lifecycle_counts,
      endpointCount: modelMetrics.endpoint_count,
      readyEndpoints: modelMetrics.ready_endpoint_count,
      openAlerts: openAlerts.length,
    };
  }, [dataMetrics, modelMetrics, jobs, openAlerts]);

  const signalLines = signals ? factualSignalLines(signals) : [];
  const recentJobs = jobs.slice(0, 5);

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    try {
      const updated = await api<Project>(`/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
      });
      setProject(updated);
      setEditing(false);
      setSuccess("Project details updated.");
      await refreshProjects();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project could not be updated.");
    }
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      });
      setMemberEmail("");
      setSuccess("Project member added.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Member could not be added.");
    }
  }

  async function removeMember(member: Membership) {
    if (!confirmAction(`Remove ${member.email} from this project?`)) return;
    setError("");
    try {
      await api(`/projects/${projectId}/members/${member.user_id}`, { method: "DELETE" });
      setMembers((rows) => rows.filter((row) => row.id !== member.id));
      setSuccess("Project member removed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Member could not be removed.");
    }
  }

  async function deleteProject() {
    if (!project || !confirmAction(`Delete project “${project.name}”? Its data will no longer be accessible.`)) return;
    setError("");
    try {
      await api(`/projects/${project.id}`, { method: "DELETE" });
      await refreshProjects();
      navigate("/projects");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project could not be deleted.");
    }
  }

  return (
    <div className="ops-page">
      <PageHeader
        title={project?.name ?? "Project overview"}
        description={project?.description || "Project lifecycle control center for data, build, models, serving, and alerts."}
        actions={canManage ? <button className="btn secondary" onClick={() => setEditing(!editing)}>Edit project</button> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {loading ? <Loading label="Loading project" /> : (
        <>
          {editing && (
            <form className="panel form" onSubmit={saveProject} data-testid="project-edit-form">
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
              <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <div className="row-actions">
                <button className="btn">Save changes</button>
                <button className="btn secondary" type="button" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          )}

          {signals && (
            <section className="panel ops-attention-panel" data-testid="overview-signals">
              <span className="eyebrow">Lifecycle signals</span>
              <ul className="ops-signal-list">
                {signalLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="ops-lifecycle-grid">
            <DetailSection eyebrow="Data" title="Datasets & quality" testId="overview-data">
              {!dataMetrics ? <Loading label="Loading data signals" /> : (
                <dl className="key-values">
                  <div><dt>Datasets</dt><dd>{dataMetrics.dataset_count}</dd></div>
                  <div><dt>Versions</dt><dd>{dataMetrics.dataset_version_count}</dd></div>
                  <div><dt>Failed quality checks</dt><dd>{dataMetrics.failed_quality_check_count}</dd></div>
                  <div>
                    <dt>Latest quality</dt>
                    <dd>{dataMetrics.latest_quality_status
                      ? <StatusBadge status={dataMetrics.latest_quality_status} />
                      : "—"}</dd>
                  </div>
                </dl>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/datasets`}>Open datasets</Link>
              </div>
            </DetailSection>

            <DetailSection eyebrow="Build" title="Training activity" testId="overview-build">
              <dl className="key-values">
                <div><dt>Training jobs</dt><dd>{signals?.jobCount ?? 0}</dd></div>
                <div><dt>Active jobs</dt><dd>{signals?.activeJobs ?? 0}</dd></div>
                <div><dt>Failed jobs</dt><dd>{signals?.failedJobs ?? 0}</dd></div>
              </dl>
              {recentJobs.length === 0 ? (
                <EmptyState title="No training jobs yet" description="Start training from a dataset when data is ready." />
              ) : (
                <div className="activity-list compact">
                  {recentJobs.map((job) => (
                    <Link key={job.id} to={`/projects/${projectId}/jobs/${job.id}`}>
                      <div>
                        <strong>{job.name}</strong>
                        <small>{job.algorithm}</small>
                      </div>
                      <StatusBadge status={job.status} />
                    </Link>
                  ))}
                </div>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/jobs`}>Open training jobs</Link>
              </div>
            </DetailSection>

            <DetailSection eyebrow="Models" title="Registry lifecycle" testId="overview-models">
              {!modelMetrics ? <Loading label="Loading model signals" /> : (
                <>
                  <dl className="key-values">
                    <div><dt>Model versions</dt><dd>{modelMetrics.model_version_count}</dd></div>
                    <div><dt>Production</dt><dd>{modelMetrics.lifecycle_counts.PRODUCTION ?? 0}</dd></div>
                  </dl>
                  <div className="tag-list">
                    {Object.entries(modelMetrics.lifecycle_counts).map(([name, count]) => (
                      <span key={name}>{name.replaceAll("_", " ")} · {count}</span>
                    ))}
                  </div>
                </>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/registry`}>Open registry</Link>
              </div>
            </DetailSection>

            <DetailSection eyebrow="Serving" title="Deployments" testId="overview-serving">
              {!modelMetrics ? <Loading label="Loading serving signals" /> : (
                <dl className="key-values">
                  <div><dt>Deployments</dt><dd>{modelMetrics.endpoint_count}</dd></div>
                  <div><dt>Ready</dt><dd>{modelMetrics.ready_endpoint_count} / {modelMetrics.endpoint_count}</dd></div>
                  <div><dt>Total requests</dt><dd>{modelMetrics.total_requests.toLocaleString()}</dd></div>
                  <div><dt>Total errors</dt><dd>{modelMetrics.total_errors.toLocaleString()}</dd></div>
                </dl>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/deployments`}>Open deployments</Link>
              </div>
            </DetailSection>
          </div>

          <DetailSection
            eyebrow="Alerts"
            title="Open alerts"
            testId="overview-alerts"
            actions={<Link to={`/projects/${projectId}/alerts`}>View all alerts</Link>}
          >
            {openAlerts.length === 0 ? (
              <p className="muted" data-testid="overview-alerts-empty">0 open alerts</p>
            ) : (
              <div className="activity-list">
                {openAlerts.slice(0, 3).map((alert) => (
                  <div key={alert.id} className="ops-alert-row">
                    <div>
                      <div className="row-actions">
                        <StatusBadge status={alert.severity} />
                        {!alert.is_read && <span className="unread-label">Unread</span>}
                      </div>
                      <strong>{alert.title}</strong>
                      <small>{formatDate(alert.created_at)}</small>
                    </div>
                    {alert.link_path ? <Link to={alert.link_path}>Open</Link> : null}
                  </div>
                ))}
              </div>
            )}
          </DetailSection>

          <section className="panel" data-testid="overview-next-actions">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Next actions</span>
                <h2>Continue the lifecycle</h2>
              </div>
            </div>
            <div className="row-actions">
              {canWriteData && <Link className="btn" to={`/projects/${projectId}/datasets`}>Upload dataset</Link>}
              {canTrain && <Link className="btn secondary" to={`/projects/${projectId}/jobs/new`}>Start training</Link>}
              <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>View experiments</Link>
              {canBuildPipeline && <Link className="btn secondary" to={`/projects/${projectId}/pipelines`}>Build pipeline</Link>}
              <Link className="btn secondary" to={`/projects/${projectId}/monitoring`}>Open monitoring</Link>
            </div>
          </section>

          {canManage && (
            <section className="panel ops-secondary-panel" data-testid="overview-members">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Access</span>
                  <h2>Project members</h2>
                </div>
                <StatusBadge status={project?.role} />
              </div>
              <form className="inline-form" onSubmit={addMember}>
                <label>Email<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} required placeholder="teammate@example.com" /></label>
                <label>Role<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as ProjectRole)}>
                  <option value="VIEWER">Viewer</option>
                  <option value="DATA_SCIENTIST">Data scientist</option>
                  <option value="ML_ENGINEER">ML engineer</option>
                  <option value="PROJECT_ADMIN">Project administrator</option>
                </select></label>
                <button className="btn">Add member</button>
              </form>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Member</th><th>Role</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.id}>
                        <td><strong>{member.full_name || member.email}</strong><small className="table-subtitle">{member.email}</small></td>
                        <td>{member.role.replaceAll("_", " ")}</td>
                        <td>{formatDate(member.created_at)}</td>
                        <td className="align-right"><button className="btn link danger-text" onClick={() => removeMember(member)} disabled={member.user_id === user?.id}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {canManage && (
            <section className="panel danger-zone ops-secondary-panel" data-testid="overview-danger">
              <div><h2>Delete project</h2><p>Remove this project from active use. Retained data follows system policy.</p></div>
              <button className="btn danger" onClick={deleteProject}>Delete project</button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
