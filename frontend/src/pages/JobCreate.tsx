import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type Dataset, type Job } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../components";

export default function JobCreate() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const requestedDatasetId = params.get("datasetId") || "";
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState(requestedDatasetId);
  const [name, setName] = useState("baseline-training");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("target");
  const [problemType, setProblemType] = useState("auto");
  const [algorithm, setAlgorithm] = useState("random_forest");
  const [hyperparameters, setHyperparameters] = useState('{\n  "n_estimators": 100,\n  "max_depth": 5\n}');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Dataset[]>(`/projects/${projectId}/datasets`).then((d) => {
      setDatasets(d);
      const nextDatasetId = requestedDatasetId || String(d[0]?.id || "");
      setDatasetId((current) => current || nextDatasetId);
      const selected = d.find((x) => String(x.id) === nextDatasetId);
      if (selected?.columns.includes("target")) setTarget("target");
      else if (selected?.columns.length) setTarget(selected.columns[selected.columns.length - 1]);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Datasets could not be loaded."))
      .finally(() => setLoading(false));
  }, [projectId, requestedDatasetId]);

  const selected = datasets.find((d) => String(d.id) === datasetId);

  useEffect(() => {
    if (!selected) return;
    if (selected.columns.includes("target")) setTarget("target");
    else if (!selected.columns.includes(target)) setTarget(selected.columns[selected.columns.length - 1] || "");
  }, [selected, target]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const parsed = JSON.parse(hyperparameters) as Record<string, unknown>;
      const job = await api<Job>(`/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          dataset_id: Number(datasetId),
          target_column: target,
          problem_type: problemType,
          algorithm,
          hyperparameters: parsed,
          feature_columns: selected?.columns.filter((column) => column !== target) || [],
          random_seed: 42,
          train_ratio: 0.7,
          val_ratio: 0.15,
          test_ratio: 0.15,
          max_retries: 1,
        }),
      });
      nav(`/projects/${projectId}/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof SyntaxError ? "Hyperparameters must be valid JSON." : err instanceof Error ? err.message : "Training job could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Create training job" description="Configure a reproducible run from a versioned dataset." />
      <ErrorNotice message={error} />
      {loading ? <Loading label="Loading datasets" /> : datasets.length === 0 ? (
        <EmptyState title="A dataset is required" description="Upload and profile data before creating a training job." />
      ) : (
        <form className="panel form form-wide" onSubmit={onSubmit}>
          <div className="form-section">
            <span className="eyebrow">Job details</span>
            <div className="form-grid">
              <label>Job name<input value={name} onChange={(event) => setName(event.target.value)} required data-testid="job-name" /></label>
              <label>Problem type<select value={problemType} onChange={(event) => setProblemType(event.target.value)}><option value="auto">Detect automatically</option><option value="classification">Classification</option><option value="regression">Regression</option></select></label>
            </div>
            <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Purpose or hypothesis" /></label>
          </div>
          <div className="form-section">
            <span className="eyebrow">Training data</span>
            <div className="form-grid">
              <label>Dataset<select value={datasetId} onChange={(event) => setDatasetId(event.target.value)} required data-testid="job-dataset">{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · v{dataset.latest_version}</option>)}</select></label>
              <label>Target column<select value={target} onChange={(event) => setTarget(event.target.value)} required data-testid="job-target">{selected?.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>
            </div>
            <p className="form-hint">Default split: 70% training, 15% validation, 15% test · seed 42</p>
          </div>
          <div className="form-section">
            <span className="eyebrow">Estimator</span>
            <label>Algorithm<select value={algorithm} onChange={(event) => setAlgorithm(event.target.value)}>
              <optgroup label="Classification"><option value="random_forest">Random forest</option><option value="logistic_regression">Logistic regression</option><option value="gradient_boosting">Gradient boosting</option></optgroup>
              <optgroup label="Regression"><option value="ridge">Ridge regression</option><option value="random_forest_regressor">Random forest regressor</option><option value="gradient_boosting_regressor">Gradient boosting regressor</option></optgroup>
            </select></label>
            <label>Hyperparameters<textarea className="code-input" value={hyperparameters} onChange={(event) => setHyperparameters(event.target.value)} spellCheck={false} /></label>
          </div>
          <div className="row-actions form-actions">
            <button className="btn" type="submit" disabled={busy || !datasetId} data-testid="job-submit">{busy ? "Queuing…" : "Start training"}</button>
            <button className="btn secondary" type="button" onClick={() => nav(`/projects/${projectId}/jobs`)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
