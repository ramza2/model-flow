import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Dataset,
  type Endpoint,
  type Job,
  type Membership,
  type Project,
  type ProjectRole,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  formatDate,
} from "../components";
import { useProject } from "../ProjectContext";

export default function ProjectOverview() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectProject, refreshProjects } = useProject();
  const [project, setProject] = useState<Project | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<ProjectRole>("viewer");
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
      const canManage = projectRow.role === "project_admin" || user?.is_system_admin;
      const [datasetRows, jobRows, endpointRows, memberRows] = await Promise.all([
        api<Dataset[]>(`/projects/${projectId}/datasets`),
        api<Job[]>(`/projects/${projectId}/jobs`),
        api<Endpoint[]>(`/projects/${projectId}/endpoints`),
        canManage ? api<Membership[]>(`/projects/${projectId}/members`) : Promise.resolve([]),
      ]);
      setProject(projectRow);
      setName(projectRow.name);
      setDescription(projectRow.description);
      setDatasets(datasetRows);
      setJobs(jobRows);
      setEndpoints(endpointRows);
      setMembers(memberRows);
      selectProject(projectRow.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectProject, user?.is_system_admin]);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = project?.role === "project_admin" || user?.is_system_admin;

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
    <div>
      <PageHeader
        title={project?.name ?? "Project overview"}
        description={project?.description || "Project activity, access, and next actions."}
        actions={canManage ? <button className="btn secondary" onClick={() => setEditing(!editing)}>Edit project</button> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {loading ? <Loading label="Loading project" /> : (
        <>
          {editing && (
            <form className="panel form" onSubmit={saveProject}>
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
              <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <div className="row-actions">
                <button className="btn">Save changes</button>
                <button className="btn secondary" type="button" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          )}
          <div className="grid stats-grid">
            <div className="stat"><div className="label">Datasets</div><div className="value">{datasets.length}</div></div>
            <div className="stat"><div className="label">Training jobs</div><div className="value">{jobs.length}</div></div>
            <div className="stat"><div className="label">Active jobs</div><div className="value">{jobs.filter((job) => ["pending", "queued", "running"].includes(job.status)).length}</div></div>
            <div className="stat"><div className="label">Deployments</div><div className="value">{endpoints.length}</div></div>
          </div>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">Quick start</span><h2>Project workflow</h2></div></div>
            <div className="row-actions">
              <Link className="btn" to={`/projects/${projectId}/datasets`}>Upload dataset</Link>
              <Link className="btn secondary" to={`/projects/${projectId}/jobs/new`}>Start training</Link>
              <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>View experiments</Link>
              <Link className="btn secondary" to={`/projects/${projectId}/pipelines`}>Build pipeline</Link>
            </div>
          </section>
          {canManage && (
            <section className="panel">
              <div className="panel-title">
                <div><span className="eyebrow">Access</span><h2>Project members</h2></div>
                <StatusBadge status={project?.role} />
              </div>
              <form className="inline-form" onSubmit={addMember}>
                <label>Email<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} required placeholder="teammate@example.com" /></label>
                <label>Role<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as ProjectRole)}>
                  <option value="viewer">Viewer</option>
                  <option value="data_scientist">Data scientist</option>
                  <option value="ml_engineer">ML engineer</option>
                  <option value="project_admin">Project administrator</option>
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
            <section className="panel danger-zone">
              <div><h2>Delete project</h2><p>Remove this project from active use. Retained data follows system policy.</p></div>
              <button className="btn danger" onClick={deleteProject}>Delete project</button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
