import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Project } from "../api";
import { ErrorNotice, PageHeader } from "../components";
import { useProject } from "../ProjectContext";

export default function ProjectCreate() {
  const nav = useNavigate();
  const { refreshProjects, selectProject } = useProject();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const project = await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      await refreshProjects();
      selectProject(project.id);
      nav(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "프로젝트를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="프로젝트 만들기" description="데이터·모델 학습·배포를 관리할 작업 공간을 만듭니다." />
      <ErrorNotice message={error} />
      <form className="form panel" onSubmit={onSubmit}>
        <label>
          프로젝트 이름
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} data-testid="project-name" />
        </label>
        <label>
          설명
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="이 프로젝트에서 진행할 작업을 설명해 주세요."
            data-testid="project-description"
          />
        </label>
        <div className="row-actions form-actions">
          <button className="btn" type="submit" disabled={busy} data-testid="project-submit">
            {busy ? "생성 중…" : "프로젝트 만들기"}
          </button>
          <Link className="btn secondary" to="/projects">취소</Link>
        </div>
      </form>
    </div>
  );
}
