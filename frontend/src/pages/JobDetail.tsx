import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Job, type ModelVersion } from "../api";
import { effectiveTargetColumns, isMultiOutputJob } from "../jobHelpers";
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
import { userCanProject, useProject } from "../ProjectContext";
import JobRetrainDialog from "./JobRetrainDialog";

export default function JobDetail() {
  const { projectId, jobId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState("");
  const [showRetrain, setShowRetrain] = useState(false);
  const canTrain = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");
  const canRegister = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Job>(`/projects/${projectId}/jobs/${jobId}`)
        .then((j) => alive && setJob(j))
        .catch((reason) => alive && setError(reason instanceof Error ? reason.message : "Training job could not be loaded."));
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobId, projectId]);

  async function register() {
    if (!job) return;
    setBusy("register");
    setSuccess("");
    try {
      const model = await api<ModelVersion>(`/projects/${projectId}/models/register`, {
        method: "POST",
        body: JSON.stringify({
          training_job_id: job.id,
          name: "classifier",
        }),
      });
      setSuccess(`Registered ${model.name} v${model.version}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Model could not be registered.");
    } finally {
      setBusy("");
    }
  }

  async function action(name: "cancel" | "retry") {
    if (!job) return;
    if (name === "cancel" && !confirmAction(`Cancel training job “${job.name}”?`)) return;
    setBusy(name);
    setError("");
    try {
      const next = await api<Job>(`/projects/${projectId}/jobs/${job.id}/${name}`, {
        method: "POST",
      });
      if (name === "cancel") {
        setJob(next);
        setSuccess("Cancellation requested.");
      } else {
        navigate(`/projects/${projectId}/jobs/${next.id}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Job could not be ${name}d.`);
    } finally {
      setBusy("");
    }
  }

  const active = job && ["pending", "queued", "running", "cancel_requested"].includes(job.status);

  return (
    <div>
      <PageHeader
        title={job?.name ?? "Training job"}
        description="Live status, metrics, configuration, and execution logs."
        actions={job && <StatusBadge status={job.status} />}
      />
      <ErrorNotice message={error || job?.error_message || ""} />
      <SuccessNotice message={success} />
      {!job ? <Loading label="Loading training job" /> : (
        <>
          <div className="row-actions toolbar-actions">
            {canTrain && active && <button className="btn danger" disabled={busy === "cancel"} onClick={() => action("cancel")}>Stop job</button>}
            {canTrain && job.status === "succeeded" && (
              <button
                type="button"
                className="btn"
                data-testid="job-retrain"
                onClick={() => setShowRetrain(true)}
              >
                Retrain
              </button>
            )}
            {canTrain && ["failed", "cancelled"].includes(job.status) && (
              <div className="retry-group">
                <button className="btn" disabled={busy === "retry"} onClick={() => action("retry")} data-testid="job-retry">Retry</button>
                <p className="form-hint" data-testid="retry-hint">
                  Retry reruns this job with the same configuration.
                  Use Clone configuration to modify settings.
                </p>
              </div>
            )}
            {canTrain && (
              <Link
                className="btn secondary"
                to={`/projects/${projectId}/jobs/new?cloneFrom=${job.id}`}
                data-testid="job-clone"
              >
                Clone configuration
              </Link>
            )}
            {job.mlflow_run_id && <Link className="btn secondary" to={`/projects/${projectId}/experiments?run=${job.mlflow_run_id}`}>Open experiment</Link>}
            {canRegister && job.status === "succeeded" && job.model_uri && (
              <button className="btn" type="button" disabled={busy === "register"} onClick={register} data-testid="register-model">
                {busy === "register" ? "Registering…" : "Register model"}
              </button>
            )}
          </div>
          <div className="grid stats-grid">
            {Object.entries(job.metrics).slice(0, 4).map(([name, value]) => <div className="stat" key={name}><div className="label">{name.replaceAll("_", " ")}</div><div className="value metric-value">{Number(value).toFixed(3)}</div></div>)}
            {Object.keys(job.metrics).length === 0 && <div className="stat"><div className="label">Metrics</div><div className="value metric-value">—</div><small>Available after training</small></div>}
          </div>
          <div className="two-column">
            <section className="panel">
              <span className="eyebrow">Configuration</span><h2>Training setup</h2>
              {job.is_retrain && job.retrain_source_job_id && (
                <p data-testid="job-retrain-lineage">
                  Retrained from{" "}
                  <Link to={`/projects/${projectId}/jobs/${job.retrain_source_job_id}`}>
                    Job #{job.retrain_source_job_id}
                  </Link>
                </p>
              )}
              <dl className="key-values">
                <div><dt>Algorithm</dt><dd>{job.algorithm.replaceAll("_", " ")}</dd></div>
                <div><dt>Problem type</dt><dd>{job.problem_type}</dd></div>
                <div data-testid="job-target-columns">
                  <dt>{isMultiOutputJob(job) ? "Target columns" : "Target column"}</dt>
                  <dd className="mono">{effectiveTargetColumns(job).join(", ")}</dd>
                </div>
                <div><dt>Dataset</dt><dd><Link to={`/projects/${projectId}/datasets/${job.dataset_id}`}>Dataset #{job.dataset_id}</Link></dd></div>
                <div data-testid="job-data-split">
                  <dt>Data split</dt>
                  <dd>
                    {job.split_id ? (
                      <>
                        <div>Saved split #{job.split_id}</div>
                        <small>
                          {job.ratios
                            ? `${Math.round(job.ratios.train * 100)}% train · ${Math.round(job.ratios.validation * 100)}% validation · ${Math.round(job.ratios.test * 100)}% test`
                            : "—"}
                          {typeof job.random_seed === "number" ? ` · seed ${job.random_seed}` : ""}
                        </small>
                      </>
                    ) : (
                      <>
                        <div>Runtime split</div>
                        <small>
                          {job.ratios
                            ? `${Math.round(job.ratios.train * 100)}/${Math.round(job.ratios.validation * 100)}/${Math.round(job.ratios.test * 100)}`
                            : "70/15/15"}
                          {typeof job.random_seed === "number" ? ` · seed ${job.random_seed}` : " · seed 42"}
                        </small>
                      </>
                    )}
                  </dd>
                </div>
                <div><dt>Created</dt><dd>{formatDate(job.created_at)}</dd></div>
                <div><dt>Finished</dt><dd data-testid="job-finished-at">{formatDate(job.finished_at)}</dd></div>
              </dl>
            </section>
            <section className="panel">
              <span className="eyebrow">Parameters</span><h2>Hyperparameters</h2>
              <pre className="json-view">{JSON.stringify(job.hyperparameters, null, 2)}</pre>
            </section>
          </div>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">Execution</span><h2>Logs</h2></div>{active && <span className="live-indicator"><span /> Live</span>}</div>
            <div className="logs" data-testid="job-logs">{job.logs || "Waiting for training to start…"}</div>
          </section>
          {showRetrain && (
            <JobRetrainDialog
              projectId={projectId!}
              sourceJob={job}
              onClose={() => setShowRetrain(false)}
              onCreated={(created) => {
                setShowRetrain(false);
                navigate(`/projects/${projectId}/jobs/${created.id}`);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
