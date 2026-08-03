import { Link } from "react-router-dom";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";
import { useProject } from "../ProjectContext";

export default function Projects() {
  const { projects, loading, error } = useProject();

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Organize data, experiments, models, deployments, and collaborators."
        actions={<Link className="btn" to="/projects/new">＋ New project</Link>}
      />
      <ErrorNotice message={error} />
      {loading ? <Loading label="Loading projects" /> : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create a project to begin your machine learning workflow."
          action={<Link className="btn" to="/projects/new">Create project</Link>}
        />
      ) : (
        <div className="card-grid">
          {projects.map((project) => (
            <Link className="project-card" key={project.id} to={`/projects/${project.id}`}>
              <div className="project-card-top">
                <span className="project-icon">{project.name.slice(0, 1).toUpperCase()}</span>
                <StatusBadge status={project.is_active ? "active" : "inactive"} />
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || "No description provided."}</p>
              <footer>
                <span>{project.role.replaceAll("_", " ")}</span>
                <span>{formatDate(project.created_at)}</span>
              </footer>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
