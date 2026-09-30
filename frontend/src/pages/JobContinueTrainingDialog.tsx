import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, type DatasetSplit, type DatasetVersion, type Job } from "../api";
import { effectiveTargetColumns, isMultiOutputJob } from "../jobHelpers";
import { ErrorNotice } from "../components";
import type { AlgorithmSpec } from "../trainingConfig";

type Props = {
  projectId: string;
  sourceJob: Job;
  onClose: () => void;
  onCreated: (job: Job) => void;
};

export default function JobContinueTrainingDialog({
  projectId,
  sourceJob,
  onClose,
  onCreated,
}: Props) {
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [catalog, setCatalog] = useState<AlgorithmSpec[]>([]);
  const [datasetVersionId, setDatasetVersionId] = useState<number | "">("");
  const [splitId, setSplitId] = useState<number | "">("");
  const [name, setName] = useState(`${sourceJob.name} (continued)`);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const algorithmSpec = useMemo(
    () => catalog.find((item) => item.id === sourceJob.algorithm),
    [catalog, sourceJob.algorithm],
  );
  const supportsContinued = Boolean(algorithmSpec?.supports_continued_training);
  const strategy = algorithmSpec?.continued_training_strategy ?? "unsupported";

  const sourceVersion = useMemo(
    () => versions.find((row) => row.id === sourceJob.dataset_version_id) ?? null,
    [versions, sourceJob.dataset_version_id],
  );

  const newerVersions = useMemo(() => {
    if (!sourceVersion) return [];
    return versions.filter((row) => row.version > sourceVersion.version);
  }, [versions, sourceVersion]);

  useEffect(() => {
    Promise.all([
      api<DatasetVersion[]>(`/projects/${projectId}/datasets/${sourceJob.dataset_id}/versions`),
      api<{ algorithms: AlgorithmSpec[] }>(`/projects/${projectId}/training/algorithms`),
    ])
      .then(([rows, algoPayload]) => {
        setVersions(rows);
        setCatalog(algoPayload.algorithms ?? []);
        const source = rows.find((row) => row.id === sourceJob.dataset_version_id);
        const newer = source
          ? rows.filter((row) => row.version > source.version)
          : [];
        setDatasetVersionId(newer[0]?.id ?? "");
      })
      .catch((reason) => {
        setError(
          reason instanceof Error
            ? reason.message
            : "Continued training options could not be loaded.",
        );
      })
      .finally(() => setLoading(false));
  }, [projectId, sourceJob.dataset_id, sourceJob.dataset_version_id]);

  useEffect(() => {
    if (!datasetVersionId) {
      setSplits([]);
      setSplitId("");
      return;
    }
    api<DatasetSplit[]>(`/projects/${projectId}/dataset-versions/${datasetVersionId}/splits`)
      .then((rows) => {
        setSplits(rows);
        setSplitId("");
      })
      .catch(() => setSplits([]));
  }, [datasetVersionId, projectId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supportsContinued) {
      setError(
        "This algorithm does not support continued training. Use Full Retrain instead.",
      );
      return;
    }
    if (!datasetVersionId) {
      setError("Select a newer DatasetVersion of the same Dataset.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const job = await api<Job>(`/projects/${projectId}/jobs/${sourceJob.id}/continue`, {
        method: "POST",
        body: JSON.stringify({
          dataset_version_id: Number(datasetVersionId),
          split_id: splitId === "" ? null : Number(splitId),
          name: name.trim(),
        }),
      });
      onCreated(job);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Continued training could not be started.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="job-continue-dialog">
      <div className="panel-header row-actions">
        <div>
          <span className="eyebrow">Continued training</span>
          <h2>Continue from Job #{sourceJob.id}</h2>
          <p className="form-hint">
            Continue from the fitted model state using a newer compatible DatasetVersion.
            The existing preprocessing is reused and only supported estimators are updated.
          </p>
          <p className="form-hint" data-testid="continue-batch-hint">
            The selected DatasetVersion is treated as the update batch. ModelFlow does not
            infer row-level delta between dataset snapshots. Preprocessing remains frozen.
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
            <dl className="key-values" data-testid="continue-source-summary">
              <div>
                <dt>{isMultiOutputJob(sourceJob) ? "Targets" : "Target"}</dt>
                <dd className="mono" data-testid="continue-targets">
                  {effectiveTargetColumns(sourceJob).join(", ")}
                </dd>
              </div>
              <div>
                <dt>Algorithm</dt>
                <dd data-testid="continue-algorithm">
                  {sourceJob.algorithm.replaceAll("_", " ")}
                </dd>
              </div>
              <div>
                <dt>Strategy</dt>
                <dd data-testid="continue-strategy">{strategy}</dd>
              </div>
              <div>
                <dt>Source DatasetVersion</dt>
                <dd data-testid="continue-source-version">
                  {sourceVersion
                    ? `v${sourceVersion.version} · #${sourceVersion.id}`
                    : sourceJob.dataset_version_id
                      ? `#${sourceJob.dataset_version_id}`
                      : "—"}
                </dd>
              </div>
            </dl>
            {!supportsContinued && (
              <p className="form-hint" data-testid="continue-unsupported-reason">
                Continued training unavailable for this algorithm. Use Full Retrain to train a
                fresh model and preprocessing pipeline from scratch.
              </p>
            )}
          </section>
          <label>
            Newer DatasetVersion (update batch)
            <select
              value={datasetVersionId}
              onChange={(event) =>
                setDatasetVersionId(
                  event.target.value === "" ? "" : Number(event.target.value),
                )
              }
              required
              disabled={!supportsContinued || newerVersions.length === 0}
              data-testid="continue-dataset-version"
            >
              <option value="" disabled>
                {newerVersions.length === 0
                  ? "No newer DatasetVersion available"
                  : "Select newer version…"}
              </option>
              {newerVersions.map((version) => (
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
              disabled={!supportsContinued}
              data-testid="continue-split"
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
              disabled={!supportsContinued}
              data-testid="continue-name"
            />
          </label>
          <div className="form-actions row-actions">
            <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn"
              disabled={busy || !supportsContinued || !datasetVersionId}
              data-testid="continue-submit"
            >
              {busy ? "Starting…" : "Start continued training"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
