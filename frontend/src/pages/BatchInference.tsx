import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  type BatchJob,
  type Dataset,
  type DatasetVersion,
  type Endpoint,
  type ModelVersion,
} from "../api";
import { useAuth } from "../AuthContext";
import { hasActiveBatchJobs } from "../batchInferencePolling";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";
import { userCanProject, useProject } from "../ProjectContext";

export default function BatchInference() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [targetType, setTargetType] = useState<"endpoint" | "model">("endpoint");
  const [targetId, setTargetId] = useState("");
  const [format, setFormat] = useState("csv");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canDeploy = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");
  const pollTimeoutRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const shouldPollRef = useRef(false);
  const pollJobsRef = useRef<(() => Promise<void>) | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback((delayMs = 2500) => {
    if (!projectId || !shouldPollRef.current) {
      return;
    }
    if (pollTimeoutRef.current !== null) {
      return;
    }
    pollTimeoutRef.current = window.setTimeout(() => {
      pollTimeoutRef.current = null;
      void pollJobsRef.current?.();
    }, delayMs);
  }, [projectId]);

  const pollJobs = useCallback(async () => {
    if (!projectId || !shouldPollRef.current || pollInFlightRef.current) {
      return;
    }
    pollInFlightRef.current = true;
    try {
      const jobRows = await api<BatchJob[]>(`/projects/${projectId}/batch-jobs`);
      setJobs(jobRows);
      if (!hasActiveBatchJobs(jobRows)) {
        stopPolling();
        return;
      }
      schedulePoll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Batch inference data could not be loaded.");
      if (shouldPollRef.current) {
        schedulePoll();
      }
    } finally {
      pollInFlightRef.current = false;
    }
  }, [projectId, schedulePoll, stopPolling]);

  useEffect(() => {
    pollJobsRef.current = pollJobs;
  }, [pollJobs]);

  const load = useCallback(async () => {
    try {
      const [jobRows, datasetRows, endpointRows, modelRows] = await Promise.all([
        api<BatchJob[]>(`/projects/${projectId}/batch-jobs`),
        api<Dataset[]>(`/projects/${projectId}/datasets`),
        api<Endpoint[]>(`/projects/${projectId}/endpoints`),
        api<ModelVersion[]>(`/projects/${projectId}/models`),
      ]);
      setJobs(jobRows);
      setDatasets(datasetRows);
      setEndpoints(endpointRows);
      setModels(modelRows.filter((model) => ["APPROVED", "PRODUCTION"].includes(model.lifecycle)));
      setDatasetId((current) => current || String(datasetRows[0]?.id || ""));
      setTargetId((current) => current || String(endpointRows[0]?.id || ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Batch inference data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const shouldPoll = hasActiveBatchJobs(jobs);

  useEffect(() => {
    shouldPollRef.current = shouldPoll;
  }, [shouldPoll]);

  useEffect(() => {
    if (!projectId || !shouldPoll) {
      stopPolling();
      return;
    }
    schedulePoll();
    return stopPolling;
  }, [projectId, shouldPoll, schedulePoll, stopPolling]);

  useEffect(() => {
    if (!datasetId) {
      setVersions([]);
      return;
    }
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${datasetId}/versions`)
      .then((rows) => {
        setVersions(rows);
        setVersionId(String(rows[0]?.id || ""));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Dataset versions could not be loaded."));
  }, [datasetId, projectId]);

  useEffect(() => {
    const rows = targetType === "endpoint" ? endpoints : models;
    setTargetId(String(rows[0]?.id || ""));
  }, [endpoints, models, targetType]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/batch-jobs`, {
        method: "POST",
        body: JSON.stringify({
          dataset_version_id: Number(versionId),
          endpoint_id: targetType === "endpoint" ? Number(targetId) : null,
          model_version_id: targetType === "model" ? Number(targetId) : null,
          result_format: format,
        }),
      });
      setSuccess("Batch inference queued.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Batch inference could not be queued.");
    } finally {
      setBusy(false);
    }
  }

  async function download(job: BatchJob) {
    try {
      const result = await api<{ download_url: string }>(`/projects/${projectId}/batch-jobs/${job.id}/download`);
      window.open(result.download_url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Result download could not be prepared.");
    }
  }

  return <div>
    <PageHeader title="Batch inference" description="Score a complete dataset version with a deployment or approved model." />
    <ErrorNotice message={error} /><SuccessNotice message={success} />
    {loading ? <Loading label="Loading batch inference" /> : <>
      {canDeploy && <form className="panel form form-wide" onSubmit={create}>
        <div className="form-grid">
          <label>Dataset<select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} required><option value="">Select dataset</option>{datasets.map((dataset) => <option value={dataset.id} key={dataset.id}>{dataset.name}</option>)}</select></label>
          <label>Version<select value={versionId} onChange={(event) => setVersionId(event.target.value)} required>{versions.map((version) => <option value={version.id} key={version.id}>v{version.version} · {version.row_count.toLocaleString()} rows</option>)}</select></label>
          <label>Prediction target<select value={targetType} onChange={(event) => setTargetType(event.target.value as "endpoint" | "model")}><option value="endpoint">Deployment</option><option value="model">Approved model</option></select></label>
          <label>{targetType === "endpoint" ? "Deployment" : "Model"}<select value={targetId} onChange={(event) => setTargetId(event.target.value)} required>{(targetType === "endpoint" ? endpoints : models).map((target) => <option value={target.id} key={target.id}>{target.name}{targetType === "model" && "version" in target ? ` · v${target.version}` : ""}</option>)}</select></label>
          <label>Result format<select value={format} onChange={(event) => setFormat(event.target.value)}><option value="csv">CSV</option><option value="json">JSON</option><option value="parquet">Parquet</option></select></label>
        </div>
        <button className="btn" disabled={busy || !versionId || !targetId}>{busy ? "Queuing…" : "Run batch inference"}</button>
      </form>}
      <section className="panel">
        <div className="panel-title"><div><span className="eyebrow">History</span><h2>Batch jobs</h2></div></div>
        {jobs.length === 0 ? <EmptyState title="No batch jobs" description="Configure a dataset and prediction target to score records in bulk." /> : <div className="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Rows</th><th>Format</th><th>Created</th><th /></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>Batch #{job.id}</td><td><StatusBadge status={job.status} /></td><td>{job.row_count?.toLocaleString() || "—"}</td><td>{job.result_format.toUpperCase()}</td><td>{formatDate(job.created_at)}</td><td>{job.status === "succeeded" && <button className="btn link" onClick={() => download(job)}>Download</button>}</td></tr>)}</tbody></table></div>}
      </section>
    </>}
  </div>;
}
