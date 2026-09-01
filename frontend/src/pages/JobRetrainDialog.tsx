import { type FormEvent, useEffect, useState } from "react";
import { api, type DatasetSplit, type DatasetVersion, type Job } from "../api";
import { effectiveTargetColumns, isMultiOutputJob } from "../jobHelpers";
import { ErrorNotice } from "../components";

type Props = {
  projectId: string;
  sourceJob: Job;
  onClose: () => void;
  onCreated: (job: Job) => void;
};

export default function JobRetrainDialog({ projectId, sourceJob, onClose, onCreated }: Props) {
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [datasetVersionId, setDatasetVersionId] = useState<number | "">("");
  const [splitId, setSplitId] = useState<number | "">("");
  const [name, setName] = useState(`${sourceJob.name} (retrain)`);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${sourceJob.dataset_id}/versions`)
      .then((rows) => {
        setVersions(rows);
        const preferred =
          rows.find((row) => row.id === sourceJob.dataset_version_id)?.id ?? rows[0]?.id ?? "";
        setDatasetVersionId(preferred);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : "Dataset versions could not be loaded.");
      })
      .finally(() => setLoading(false));
  }, [projectId, sourceJob.dataset_id, sourceJob.dataset_version_id]);

  useEffect(() => {
    if (!datasetVersionId) {
      setSplits([]);
      setSplitId("");
      return;
    }
    api<DatasetSplit[]>(
      `/projects/${projectId}/dataset-versions/${datasetVersionId}/splits`,
    )
      .then((rows) => {
        setSplits(rows);
        setSplitId("");
      })
      .catch(() => setSplits([]));
  }, [datasetVersionId, projectId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!datasetVersionId) {
      setError("Select a dataset version.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const job = await api<Job>(
        `/projects/${projectId}/jobs/${sourceJob.id}/retrain`,
        {
          method: "POST",
          body: JSON.stringify({
            dataset_version_id: Number(datasetVersionId),
            split_id: splitId === "" ? null : Number(splitId),
            name: name.trim(),
          }),
        },
      );
      onCreated(job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Retrain could not be started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="job-retrain-dialog">
      <div className="panel-header row-actions">
        <div>
          <span className="eyebrow">Full retrain</span>
          <h2>Retrain from Job #{sourceJob.id}</h2>
          <p className="form-hint">
            Creates a new training job with the same configuration and trains a fresh model on the
            selected dataset version. This is not incremental learning.
          </p>
        </div>
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {loading ? (
        <p>Loading dataset versions…</p>
      ) : (
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <section className="form-section">
            <span className="eyebrow">Source configuration</span>
            <dl className="key-values" data-testid="retrain-source-summary">
              <div>
                <dt>{isMultiOutputJob(sourceJob) ? "Targets" : "Target"}</dt>
                <dd className="mono" data-testid="retrain-targets">{effectiveTargetColumns(sourceJob).join(", ")}</dd>
              </div>
              <div><dt>Problem type</dt><dd>{sourceJob.problem_type}</dd></div>
              <div><dt>Algorithm</dt><dd>{sourceJob.algorithm.replaceAll("_", " ")}</dd></div>
              <div><dt>Features</dt><dd>{sourceJob.feature_columns.join(", ") || "—"}</dd></div>
              <div><dt>Dataset</dt><dd>#{sourceJob.dataset_id}</dd></div>
            </dl>
            <pre className="json-view">{JSON.stringify(sourceJob.hyperparameters, null, 2)}</pre>
          </section>
          <label>
            Dataset version
            <select
              value={datasetVersionId}
              onChange={(event) => setDatasetVersionId(Number(event.target.value))}
              required
              data-testid="retrain-dataset-version"
            >
              <option value="" disabled>Select version…</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version} · {version.original_filename}
                </option>
              ))}
            </select>
          </label>
          <label>
            Saved split (optional)
            <select
              value={splitId}
              onChange={(event) =>
                setSplitId(event.target.value === "" ? "" : Number(event.target.value))
              }
              data-testid="retrain-split"
            >
              <option value="">Runtime split (source ratios & seed)</option>
              {splits.map((split) => (
                <option key={split.id} value={split.id}>
                  {split.name} · {Math.round(split.train_ratio * 100)}/
                  {Math.round(split.val_ratio * 100)}/
                  {Math.round(split.test_ratio * 100)}
                </option>
              ))}
            </select>
          </label>
          <label>
            New job name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              data-testid="retrain-name"
            />
          </label>
          <div className="form-actions row-actions">
            <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy} data-testid="retrain-submit">
              {busy ? "Starting…" : "Start retraining"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
