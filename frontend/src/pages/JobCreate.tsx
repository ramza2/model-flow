import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, Dataset, Job } from "../api";

export default function JobCreate() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState(params.get("datasetId") || "");
  const [name, setName] = useState("rf-train");
  const [target, setTarget] = useState("target");
  const [nEstimators, setNEstimators] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Dataset[]>(`/api/projects/${projectId}/datasets`).then((d) => {
      setDatasets(d);
      if (!datasetId && d[0]) setDatasetId(String(d[0].id));
      const selected = d.find((x) => String(x.id) === (datasetId || String(d[0]?.id)));
      if (selected?.columns.includes("target")) setTarget("target");
      else if (selected?.columns.length) setTarget(selected.columns[selected.columns.length - 1]);
    }).catch((e) => setError(String(e.message || e)));
  }, [projectId]);

  const selected = datasets.find((d) => String(d.id) === datasetId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const job = await api<Job>(`/api/projects/${projectId}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          dataset_id: Number(datasetId),
          target_column: target,
          algorithm: "random_forest",
          hyperparameters: { n_estimators: nEstimators, max_depth: 5 },
        }),
      });
      nav(`/projects/${projectId}/jobs/${job.id}`);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Create training job</h1>
      <p className="lead">Queue a scikit-learn Random Forest run. The worker picks it up automatically.</p>
      {error && <div className="error">{error}</div>}
      <form className="panel form" onSubmit={onSubmit}>
        <label>
          Job name
          <input value={name} onChange={(e) => setName(e.target.value)} required data-testid="job-name" />
        </label>
        <label>
          Dataset
          <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} required data-testid="job-dataset">
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label>
          Target column
          <select value={target} onChange={(e) => setTarget(e.target.value)} required data-testid="job-target">
            {(selected?.columns || []).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Trees (n_estimators)
          <input type="number" min={10} max={500} value={nEstimators} onChange={(e) => setNEstimators(Number(e.target.value))} />
        </label>
        <button className="btn" type="submit" disabled={busy || !datasetId} data-testid="job-submit">
          {busy ? "Queuing…" : "Start training"}
        </button>
      </form>
    </div>
  );
}
