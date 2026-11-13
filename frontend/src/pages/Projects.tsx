import { Link } from "react-router-dom";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";
import { useProject } from "../ProjectContext";
import { operationalStatusLabel, projectRoleLabel } from "../uiTerminology";

export default function Projects() {
  const { projects, loading, error } = useProject();

  return (
    <div>
      <PageHeader
        title="프로젝트"
        description="데이터·실험·모델·배포 및 협업자를 프로젝트별로 관리합니다."
        actions={<Link className="btn" to="/projects/new">＋ 프로젝트 만들기</Link>}
      />
      <ErrorNotice message={error} />
      {loading ? <Loading label="프로젝트 불러오는 중" /> : projects.length === 0 ? (
        <EmptyState
          title="등록된 프로젝트가 없습니다"
          description="프로젝트를 만들어 머신러닝 작업을 시작하세요."
          action={<Link className="btn" to="/projects/new">프로젝트 만들기</Link>}
        />
      ) : (
        <div className="card-grid">
          {projects.map((project) => (
            <Link className="project-card" key={project.id} to={`/projects/${project.id}`}>
              <div className="project-card-top">
                <span className="project-icon">{project.name.slice(0, 1).toUpperCase()}</span>
                <StatusBadge status={project.is_active ? "active" : "inactive"} label={operationalStatusLabel(project.is_active ? "active" : "inactive")} />
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || "프로젝트 설명이 없습니다."}</p>
              <footer>
                <span>{projectRoleLabel(project.role)}</span>
                <span>{formatDate(project.created_at)}</span>
              </footer>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
