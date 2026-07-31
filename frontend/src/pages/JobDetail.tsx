import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Job } from "../api";

export default function JobDetail() {
  const { projectId, jobId } = useParams();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registerMsg, setRegisterMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Job>(`/api/jobs/${jobId}`)
        .then((j) => alive && setJob(j))
        .catch((e) => alive && setError(String(e.message || e)));
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobId]);

  async function register() {
    if (!job?.mlflow_run_id) return;
    setRegisterMsg(null);
    try {
      const res = await api<{ name: string; version: string }>(`/api/projects/${projectId}/models/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: job.mlflow_run_id, model_name: "classifier" }),
      });
      setRegisterMsg(`Registered ${res.name} v${res.version}`);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  return (
    <div>
      <h1>{job?.name ?? "Training job"}</h1>
      <p className="lead">Live status, metrics, and worker logs.</p>
      {error && <div className="error">{error}</div>}
      {registerMsg && <div className="panel">{registerMsg}</div>}
      <div className="panel">
        <div className="row-actions">
          <span className={`badge ${job?.status === "succeeded" ? "ok" : job?.status === "failed" ? "err" : "run"}`}>
            {job?.status ?? "…"}
          </span>
          {job?.mlflow_run_id && (
            <Link to={`/projects/${projectId}/runs`}>Open experiments</Link>
          )}
          {job?.status === "succeeded" && job.mlflow_run_id && (
            <button className="btn" type="button" onClick={register} data-testid="register-model">
              Register model
            </button>
          )}
        </div>
        {job?.error_message && <div className="error">{job.error_message}</div>}
        <h2>Metrics</h2>
        <pre className="mono">{JSON.stringify(job?.metrics || {}, null, 2)}</pre>
        <h2>Logs</h2>
        <div className="logs" data-testid="job-logs">{job?.logs || "Waiting for worker…"}</div>
      </div>
    </div>
  );
}
