import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Project } from "../api";

export default function ProjectCreate() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<Project>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Create project</h1>
      <p className="lead">Name a workspace for your datasets and training runs.</p>
      {error && <div className="error">{error}</div>}
      <form className="form panel" onSubmit={onSubmit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} data-testid="project-name" />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} data-testid="project-description" />
        </label>
        <button className="btn" type="submit" disabled={busy} data-testid="project-submit">
          {busy ? "Creating…" : "Create project"}
        </button>
      </form>
    </div>
  );
}
