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
      setError(err instanceof Error ? err.message : "Project could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Create project" description="Set up a secure workspace for your ML lifecycle." />
      <ErrorNotice message={error} />
      <form className="form panel" onSubmit={onSubmit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} data-testid="project-name" />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What will this project deliver?"
            data-testid="project-description"
          />
        </label>
        <div className="row-actions form-actions">
          <button className="btn" type="submit" disabled={busy} data-testid="project-submit">
            {busy ? "Creating…" : "Create project"}
          </button>
          <Link className="btn secondary" to="/projects">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
