import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Dataset, Endpoint, Job, Project } from "../api";

export default function ProjectOverview() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    Promise.all([
      api<Project>(`/api/projects/${projectId}`),
      api<Dataset[]>(`/api/projects/${projectId}/datasets`),
      api<Job[]>(`/api/projects/${projectId}/jobs`),
      api<Endpoint[]>(`/api/projects/${projectId}/endpoints`),
    ])
      .then(([p, d, j, e]) => {
        setProject(p);
        setDatasets(d);
        setJobs(j);
        setEndpoints(e);
      })
      .catch((err) => setError(String(err.message || err)));
  }, [projectId]);

  return (
    <div>
      <h1>{project?.name ?? "Project"}</h1>
      <p className="lead">{project?.description || "Project overview and next actions."}</p>
      {error && <div className="error">{error}</div>}
      <div className="grid">
        <div className="stat"><div className="label">Datasets</div><div className="value">{datasets.length}</div></div>
        <div className="stat"><div className="label">Jobs</div><div className="value">{jobs.length}</div></div>
        <div className="stat"><div className="label">Endpoints</div><div className="value">{endpoints.length}</div></div>
      </div>
      <div className="panel">
        <div className="row-actions">
          <Link className="btn" to={`/projects/${projectId}/datasets`}>Upload dataset</Link>
          <Link className="btn secondary" to={`/projects/${projectId}/jobs/new`}>Start training</Link>
          <Link className="btn secondary" to={`/projects/${projectId}/runs`}>View experiments</Link>
        </div>
      </div>
    </div>
  );
}
