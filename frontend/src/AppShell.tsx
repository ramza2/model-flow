import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, type Alert } from "./api";
import { useAuth } from "./AuthContext";
import { hasProjectAdminRole, useProject } from "./ProjectContext";

const projectNav = [
  ["Data Sources", "data-sources", "⌁"],
  ["Datasets", "datasets", "▤"],
  ["Experiments", "experiments", "⌇"],
  ["Training Jobs", "jobs", "▶"],
  ["Pipelines", "pipelines", "⌘"],
  ["Model Registry", "models", "◆"],
  ["Deployments", "deployments", "↗"],
  ["Monitoring", "monitoring", "◉"],
  ["Alerts", "alerts", "⚑"],
] as const;

const crumbLabels: Record<string, string> = {
  projects: "Projects",
  "data-sources": "Data Sources",
  datasets: "Datasets",
  experiments: "Experiments",
  jobs: "Training Jobs",
  pipelines: "Pipelines",
  "pipeline-runs": "Pipeline Runs",
  models: "Model Registry",
  deployments: "Deployments",
  predict: "Prediction Test",
  batch: "Batch Inference",
  monitoring: "Monitoring",
  alerts: "Alerts",
  audit: "Audit Logs",
  admin: "Administration",
  password: "Change Password",
  new: "Create",
};

function Breadcrumbs() {
  const location = useLocation();
  const { projects } = useProject();
  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => {
    const path = `/${segments.slice(0, index + 1).join("/")}`;
    let label = crumbLabels[segment];
    if (!label && segments[index - 1] === "projects") {
      label = projects.find((project) => String(project.id) === segment)?.name || "Project";
    }
    if (!label && /^\d+$/.test(segment)) label = `#${segment}`;
    return { path, label: label || segment };
  });
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link to="/">Home</Link>
      {crumbs.map((crumb, index) => (
        <span key={crumb.path}>
          <span aria-hidden="true">/</span>
          {index === crumbs.length - 1 ? (
            <span aria-current="page">{crumb.label}</span>
          ) : (
            <Link to={crumb.path}>{crumb.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const {
    projects,
    selectedProject,
    selectProject,
    loading: projectsLoading,
  } = useProject();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const projectBase = selectedProject ? `/projects/${selectedProject.id}` : "";
  const canAudit = user?.is_system_admin || hasProjectAdminRole(selectedProject);

  useEffect(() => {
    if (!selectedProject) {
      setUnread(0);
      return;
    }
    api<Alert[]>(`/projects/${selectedProject.id}/alerts?is_read=false&is_resolved=false`)
      .then((alerts) => setUnread(alerts.length))
      .catch(() => setUnread(0));
  }, [selectedProject]);

  async function signOut() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app-frame">
      <header className="topbar">
        <Link to="/" className="brand">
          Model<span>Flow</span>
        </Link>
        <div className="project-picker">
          <label htmlFor="project-select">Project</label>
          <select
            id="project-select"
            value={selectedProject?.id ?? ""}
            disabled={projectsLoading || projects.length === 0}
            onChange={(event) => {
              const id = Number(event.target.value);
              selectProject(id);
              navigate(`/projects/${id}`);
            }}
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((project) => (
              <option value={project.id} key={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
        <div className="top-actions">
          <Link
            className="icon-button"
            to={selectedProject ? `${projectBase}/alerts` : "/projects"}
            aria-label={`${unread} unread alerts`}
          >
            <span aria-hidden="true">♢</span>
            {unread > 0 && <span className="notification-count">{unread > 99 ? "99+" : unread}</span>}
          </Link>
          <details className="user-menu">
            <summary>
              <span className="avatar">{(user?.full_name || user?.email || "U").slice(0, 1).toUpperCase()}</span>
              <span className="user-copy">
                <strong>{user?.full_name || "ModelFlow user"}</strong>
                <small>{user?.is_system_admin ? "System administrator" : user?.email}</small>
              </span>
            </summary>
            <div className="menu-popover">
              <div className="menu-email">{user?.email}</div>
              <Link to="/password">Change password</Link>
              <button type="button" onClick={signOut}>Sign out</button>
            </div>
          </details>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="nav" aria-label="Main navigation">
          <div className="nav-group">
            <span className="nav-label">Workspace</span>
            <NavLink to="/" end><span aria-hidden="true">⌂</span>Home</NavLink>
            <NavLink to="/projects"><span aria-hidden="true">▦</span>Projects</NavLink>
          </div>
          <div className="nav-group">
            <span className="nav-label">Project</span>
            {!selectedProject && <p className="nav-hint">Select or create a project to continue.</p>}
            {selectedProject && projectNav.map(([label, path, icon]) => (
              <NavLink key={path} to={`${projectBase}/${path}`}>
                <span aria-hidden="true">{icon}</span>{label}
              </NavLink>
            ))}
          </div>
          {(canAudit || user?.is_system_admin) && (
            <div className="nav-group">
              <span className="nav-label">Governance</span>
              {canAudit && (
                <NavLink to={user?.is_system_admin ? "/audit" : `${projectBase}/audit`}>
                  <span aria-hidden="true">≡</span>Audit Logs
                </NavLink>
              )}
              {user?.is_system_admin && (
                <NavLink to="/admin"><span aria-hidden="true">⚙</span>Administration</NavLink>
              )}
            </div>
          )}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" /> Connected to ModelFlow
        </div>
      </aside>

      <main className="content">
        <Breadcrumbs />
        {children}
      </main>
    </div>
  );
}
