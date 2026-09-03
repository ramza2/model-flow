import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, type Alert } from "./api";
import { useAuth } from "./AuthContext";
import { hasProjectAdminRole, useProject } from "./ProjectContext";

type NavItem = { label: string; to: string; icon: string; end?: boolean };
type ProjectNavItem = { label: string; path: string; icon: string; end?: boolean };

const projectGroups: { label: string; items: ProjectNavItem[] }[] = [
  {
    label: "Data",
    items: [
      { label: "Data Sources", path: "data-sources", icon: "⌁" },
      { label: "Datasets", path: "datasets", icon: "▤" },
    ],
  },
  {
    label: "Build",
    items: [
      { label: "Pipelines", path: "pipelines", icon: "⌘" },
      { label: "Training Jobs", path: "jobs", icon: "▶" },
      { label: "Experiments", path: "experiments", icon: "⌇" },
    ],
  },
  {
    label: "Models & Serving",
    items: [
      { label: "Model Registry", path: "models", icon: "◆" },
      { label: "Deployments", path: "deployments", icon: "↗" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Schedules", path: "schedules", icon: "⏱" },
      { label: "Monitoring", path: "monitoring", icon: "◉" },
      { label: "Alerts", path: "alerts", icon: "⚑" },
    ],
  },
];

const crumbLabels: Record<string, string> = {
  projects: "Projects",
  "data-sources": "Data Sources",
  datasets: "Datasets",
  experiments: "Experiments",
  jobs: "Training Jobs",
  pipelines: "Pipelines",
  schedules: "Schedules",
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
  compare: "Compare",
  runs: "Run",
  api: "API Usage",
};

function Breadcrumbs() {
  const location = useLocation();
  const { projects } = useProject();
  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => {
    const path = `/${segments.slice(0, index + 1).join("/")}`;
    let label = crumbLabels[segment];
    if (segment === "audit" && !segments.includes("projects")) {
      label = "Global Audit Logs";
    }
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
            <span aria-current="page" className="breadcrumb-current">{crumb.label}</span>
          ) : (
            <Link to={crumb.path}>{crumb.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}

function NavItemLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onNavigate}>
      <span className="nav-icon" aria-hidden="true">{item.icon}</span>
      <span className="nav-text">{item.label}</span>
    </NavLink>
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
  const location = useLocation();
  const [unread, setUnread] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const projectBase = selectedProject ? `/projects/${selectedProject.id}` : "";
  const canProjectAudit = Boolean(selectedProject) && (user?.is_system_admin || hasProjectAdminRole(selectedProject));

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

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

  function closeNav() {
    setNavOpen(false);
  }

  return (
    <div className={`app-frame${navOpen ? " nav-open" : ""}`}>
      <header className="topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((open) => !open)}
        >
          <span aria-hidden="true">{navOpen ? "✕" : "☰"}</span>
        </button>
        <Link to="/" className="brand" onClick={closeNav}>
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

      {navOpen && <button type="button" className="nav-backdrop" aria-label="Close navigation" onClick={closeNav} />}

      <aside className="sidebar" id="app-sidebar">
        <nav className="nav" aria-label="Main navigation">
          <div className="nav-group">
            <span className="nav-label">Workspace</span>
            <NavItemLink item={{ label: "Home", to: "/", icon: "⌂", end: true }} onNavigate={closeNav} />
            <NavItemLink item={{ label: "Projects", to: "/projects", icon: "▦", end: true }} onNavigate={closeNav} />
          </div>

          <div className="nav-group">
            <span className="nav-label">Project</span>
            {!selectedProject && <p className="nav-hint">Select or create a project to continue.</p>}
            {selectedProject && (
              <NavItemLink
                item={{ label: "Overview", to: projectBase, icon: "◎", end: true }}
                onNavigate={closeNav}
              />
            )}
          </div>

          {selectedProject && projectGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.items.map((item) => (
                <NavItemLink
                  key={item.path}
                  item={{ label: item.label, to: `${projectBase}/${item.path}`, icon: item.icon, end: item.end }}
                  onNavigate={closeNav}
                />
              ))}
            </div>
          ))}

          {canProjectAudit && (
            <div className="nav-group">
              <span className="nav-label">Governance</span>
              <NavItemLink
                item={{ label: "Audit Logs", to: `${projectBase}/audit`, icon: "≡" }}
                onNavigate={closeNav}
              />
            </div>
          )}

          {user?.is_system_admin && (
            <div className="nav-group">
              <span className="nav-label">System</span>
              <NavItemLink
                item={{ label: "Global Audit Logs", to: "/audit", icon: "☷" }}
                onNavigate={closeNav}
              />
              <NavItemLink
                item={{ label: "Administration", to: "/admin", icon: "⚙" }}
                onNavigate={closeNav}
              />
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
