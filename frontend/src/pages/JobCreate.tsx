import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type Dataset, type DatasetSplit, type DatasetVersion, type Job } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../components";
import {
  algorithmsForProblemType,
  defaultAlgorithmId,
  formatHyperparameters,
  validateHyperparametersText,
  type AlgorithmSpec,
} from "../trainingConfig";

type CatalogResponse = { algorithms: AlgorithmSpec[] };
type ResolveResponse = {
  requested_problem_type: string;
  resolved_problem_type: string;
  target_column: string;
  dataset_id: number;
  dataset_version_id: number | null;
};

function titleCaseProblemType(value: string): string {
  if (value === "classification") return "Classification";
  if (value === "regression") return "Regression";
  return value;
}

export default function JobCreate() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const requestedDatasetId = params.get("datasetId") || "";
  const cloneFrom = params.get("cloneFrom") || "";

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [catalog, setCatalog] = useState<AlgorithmSpec[]>([]);
  const [datasetId, setDatasetId] = useState(requestedDatasetId);
  const [datasetVersionId, setDatasetVersionId] = useState<number | null>(null);
  const [name, setName] = useState("baseline-training");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("target");
  const [problemType, setProblemType] = useState("auto");
  const [detectedType, setDetectedType] = useState<string | null>(null);
  const [resolvingProblemType, setResolvingProblemType] = useState(false);
  const [problemTypeDetectionError, setProblemTypeDetectionError] = useState<string | null>(null);
  const [algorithm, setAlgorithm] = useState("random_forest");
  const [hyperparameters, setHyperparameters] = useState("{}");
  const [featureColumns, setFeatureColumns] = useState<string[]>([]);
  const [trainRatio, setTrainRatio] = useState(0.7);
  const [valRatio, setValRatio] = useState(0.15);
  const [testRatio, setTestRatio] = useState(0.15);
  const [randomSeed, setRandomSeed] = useState(42);
  const [maxRetries, setMaxRetries] = useState(1);
  const [savedSplits, setSavedSplits] = useState<DatasetSplit[]>([]);
  const [splitId, setSplitId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cloneLoaded, setCloneLoaded] = useState(!cloneFrom);

  const selected = datasets.find((d) => String(d.id) === datasetId);
  const effectiveProblemType = problemType === "auto" ? detectedType || "auto" : problemType;
  const visibleAlgorithms = useMemo(
    () => algorithmsForProblemType(catalog, effectiveProblemType === "auto" ? "" : effectiveProblemType),
    [catalog, effectiveProblemType],
  );
  const selectedAlgorithm = catalog.find((item) => item.id === algorithm);
  const availableFeatures = (selected?.columns || []).filter((column) => column !== target);

  useEffect(() => {
    Promise.all([
      api<Dataset[]>(`/projects/${projectId}/datasets`),
      api<CatalogResponse>(`/projects/${projectId}/training/algorithms`),
    ])
      .then(([datasetRows, catalogRows]) => {
        setDatasets(datasetRows);
        setCatalog(catalogRows.algorithms);
        const nextDatasetId = requestedDatasetId || String(datasetRows[0]?.id || "");
        setDatasetId((current) => current || nextDatasetId);
        const selectedDataset = datasetRows.find((x) => String(x.id) === nextDatasetId);
        if (selectedDataset?.columns.includes("target")) setTarget("target");
        else if (selectedDataset?.columns.length) {
          setTarget(selectedDataset.columns[selectedDataset.columns.length - 1]);
        }
        const defaults = catalogRows.algorithms.find((item) => item.id === "random_forest");
        if (defaults) setHyperparameters(formatHyperparameters(defaults.default_hyperparameters));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Datasets could not be loaded."))
      .finally(() => setLoading(false));
  }, [projectId, requestedDatasetId]);

  useEffect(() => {
    if (!cloneFrom || !projectId || !catalog.length) return;
    let cancelled = false;
    api<Job>(`/projects/${projectId}/jobs/${cloneFrom}`)
      .then((job) => {
        if (cancelled) return;
        setName(`${job.name} (clone)`);
        setDescription(job.description || "");
        setDatasetId(String(job.dataset_id));
        setDatasetVersionId(job.dataset_version_id);
        setSplitId(typeof job.split_id === "number" ? job.split_id : null);
        setTarget(job.target_column);
        setProblemType(job.problem_type || "auto");
        setAlgorithm(job.algorithm);
        setHyperparameters(formatHyperparameters(job.hyperparameters || {}));
        setFeatureColumns(job.feature_columns || []);
        if (job.ratios) {
          setTrainRatio(job.ratios.train);
          setValRatio(job.ratios.validation);
          setTestRatio(job.ratios.test);
        }
        if (typeof job.random_seed === "number") setRandomSeed(job.random_seed);
        if (typeof job.max_retries === "number") setMaxRetries(job.max_retries);
        setCloneLoaded(true);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Clone source job could not be loaded.");
          setCloneLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalog.length, cloneFrom, projectId]);

  useEffect(() => {
    if (!selected || !projectId) return;
    let cancelled = false;
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${selected.id}/versions`)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        setDatasetVersionId((current) => {
          if (current && rows.some((row) => row.id === current)) return current;
          const preferred =
            rows.find((row) => row.version === selected.latest_version) || rows[0];
          return preferred?.id ?? null;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setVersions([]);
          setDatasetVersionId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected]);

  useEffect(() => {
    if (!projectId || !datasetVersionId) {
      setSavedSplits([]);
      return;
    }
    let cancelled = false;
    api<DatasetSplit[]>(`/projects/${projectId}/dataset-versions/${datasetVersionId}/splits`)
      .then((rows) => {
        if (cancelled) return;
        setSavedSplits(rows);
        setSplitId((current) => {
          if (current != null && rows.some((row) => row.id === current)) return current;
          return null;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSavedSplits([]);
          setSplitId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [datasetVersionId, projectId]);

  useEffect(() => {
    if (!selected) return;
    if (cloneFrom && !cloneLoaded) return;
    if (!selected.columns.includes(target)) {
      if (selected.columns.includes("target") && !cloneFrom) setTarget("target");
      else setTarget(selected.columns[selected.columns.length - 1] || "");
    }
  }, [cloneFrom, cloneLoaded, selected, target]);

  useEffect(() => {
    if (!selected || !target) return;
    if (cloneFrom && !cloneLoaded) return;
    setFeatureColumns((current) => {
      const available = selected.columns.filter((column) => column !== target);
      const kept = current.filter(
        (column) => column !== target && selected.columns.includes(column),
      );
      const datasetMismatch = current.some(
        (column) => !selected.columns.includes(column) && column !== target,
      );
      if (!current.length || datasetMismatch) return available;
      return kept;
    });
  }, [cloneFrom, cloneLoaded, selected, target]);

  useEffect(() => {
    if (!projectId || !datasetId || !target || problemType !== "auto") {
      if (problemType !== "auto") {
        setDetectedType(problemType);
        setProblemTypeDetectionError(null);
      }
      setResolvingProblemType(false);
      return;
    }
    let cancelled = false;
    setDetectedType(null);
    setProblemTypeDetectionError(null);
    setResolvingProblemType(true);
    api<ResolveResponse>(`/projects/${projectId}/training/resolve-problem-type`, {
      method: "POST",
      body: JSON.stringify({
        dataset_id: Number(datasetId),
        dataset_version_id: datasetVersionId,
        target_column: target,
        problem_type: "auto",
      }),
    })
      .then((result) => {
        if (cancelled) return;
        setDetectedType(result.resolved_problem_type);
        setProblemTypeDetectionError(null);
        setResolvingProblemType(false);
      })
      .catch((reason) => {
        if (cancelled) return;
        setDetectedType(null);
        setResolvingProblemType(false);
        setProblemTypeDetectionError(
          reason instanceof Error ? reason.message : "Problem type detection failed.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, datasetVersionId, problemType, projectId, target]);

  useEffect(() => {
    if (!catalog.length) return;
    const filterType = problemType === "auto" ? detectedType : problemType;
    if (!filterType || filterType === "auto") return;
    const allowed = algorithmsForProblemType(catalog, filterType);
    if (!allowed.some((item) => item.id === algorithm)) {
      const nextId = defaultAlgorithmId(catalog, filterType);
      const next = catalog.find((item) => item.id === nextId);
      setAlgorithm(nextId);
      if (next) setHyperparameters(formatHyperparameters(next.default_hyperparameters));
    }
  }, [algorithm, catalog, detectedType, problemType]);

  function onAlgorithmChange(nextId: string) {
    setSubmitError("");
    setAlgorithm(nextId);
    const next = catalog.find((item) => item.id === nextId);
    if (next) setHyperparameters(formatHyperparameters(next.default_hyperparameters));
  }

  function toggleFeature(column: string) {
    setSubmitError("");
    setFeatureColumns((current) => (
      current.includes(column)
        ? current.filter((item) => item !== column)
        : [...current, column]
    ));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSubmitError("");
    try {
      if (featureColumns.length === 0) {
        throw new Error("Select at least one feature column.");
      }
      if (problemType === "auto" && (resolvingProblemType || !detectedType)) {
        throw new Error("Wait for problem type detection to finish before starting training.");
      }
      const filterType = problemType === "auto" ? detectedType : problemType;
      if (filterType && selectedAlgorithm && !selectedAlgorithm.problem_types.includes(filterType)) {
        throw new Error(`${selectedAlgorithm.display_name} is not supported for ${filterType}.`);
      }
      const parsed = validateHyperparametersText(hyperparameters, selectedAlgorithm);
      if (!parsed.ok) throw new Error(parsed.message);
      const job = await api<Job>(`/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          dataset_id: Number(datasetId),
          dataset_version_id: datasetVersionId,
          split_id: splitId,
          target_column: target,
          problem_type: problemType,
          algorithm,
          hyperparameters: parsed.value,
          feature_columns: featureColumns,
          random_seed: randomSeed,
          train_ratio: trainRatio,
          val_ratio: valRatio,
          test_ratio: testRatio,
          max_retries: maxRetries,
        }),
      });
      nav(`/projects/${projectId}/jobs/${job.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Training job could not be created.");
    } finally {
      setBusy(false);
    }
  }

  const formReady = !loading && cloneLoaded;
  const waitingForDetection = problemType === "auto" && (resolvingProblemType || !detectedType);

  return (
    <div>
      <PageHeader title="Create training job" description="Configure a reproducible run from a versioned dataset." />
      <ErrorNotice message={error} />
      {!formReady ? <Loading label="Loading datasets" /> : datasets.length === 0 ? (
        <EmptyState title="A dataset is required" description="Upload and profile data before creating a training job." />
      ) : (
        <form className="panel form form-wide" onSubmit={onSubmit}>
          <div className="form-section">
            <span className="eyebrow">Job details</span>
            <div className="form-grid">
              <label>Job name<input value={name} onChange={(event) => setName(event.target.value)} required data-testid="job-name" /></label>
              <label>Problem type
                <select
                  value={problemType}
                  onChange={(event) => {
                    setSubmitError("");
                    setProblemType(event.target.value);
                  }}
                  data-testid="job-problem-type"
                >
                  <option value="auto">Detect automatically</option>
                  <option value="classification">Classification</option>
                  <option value="regression">Regression</option>
                </select>
              </label>
            </div>
            {problemType === "auto" && resolvingProblemType && (
              <p className="form-hint" data-testid="detecting-problem-type">
                Detecting problem type…
              </p>
            )}
            {problemType === "auto" && !resolvingProblemType && detectedType && (
              <p className="form-hint" data-testid="detected-problem-type">
                Detected problem type: {titleCaseProblemType(detectedType)}
              </p>
            )}
            {problemType === "auto" && !resolvingProblemType && problemTypeDetectionError && (
              <p className="form-hint" data-testid="problem-type-detection-error">
                Problem type could not be detected. Retry by changing the target or select Classification/Regression manually.
              </p>
            )}
            <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Purpose or hypothesis" /></label>
          </div>
          <div className="form-section">
            <span className="eyebrow">Training data</span>
            <div className="form-grid">
              <label>Dataset
                <select
                  value={datasetId}
                  onChange={(event) => {
                    setSubmitError("");
                    setDatasetId(event.target.value);
                    setDatasetVersionId(null);
                    setSplitId(null);
                    setSavedSplits([]);
                    setFeatureColumns([]);
                  }}
                  required
                  data-testid="job-dataset"
                >
                  {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · v{dataset.latest_version}</option>)}
                </select>
              </label>
              <label>Target column
                <select
                  value={target}
                  onChange={(event) => {
                    setSubmitError("");
                    setTarget(event.target.value);
                  }}
                  required
                  data-testid="job-target"
                >
                  {selected?.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
              </label>
            </div>
            {versions.length > 1 && (
              <label>Dataset version
                <select
                  value={datasetVersionId ?? ""}
                  onChange={(event) => {
                    setSubmitError("");
                    setSplitId(null);
                    setDatasetVersionId(Number(event.target.value));
                  }}
                  data-testid="job-dataset-version"
                >
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>v{version.version} · {version.original_filename}</option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="feature-columns" data-testid="feature-columns">
              <legend>Feature columns · {featureColumns.length} selected</legend>
              <div className="feature-column-list">
                {availableFeatures.map((column) => (
                  <label key={column} className="feature-column-option">
                    <input
                      type="checkbox"
                      checked={featureColumns.includes(column)}
                      onChange={() => toggleFeature(column)}
                      data-testid={`feature-${column}`}
                    />
                    <span>{column}</span>
                  </label>
                ))}
              </div>
              {featureColumns.length === 0 && <p className="form-hint">Select at least one feature column.</p>}
            </fieldset>
            <label>
              Data split
              <select
                value={splitId ?? ""}
                onChange={(event) => {
                  setSubmitError("");
                  const value = event.target.value;
                  if (!value) {
                    setSplitId(null);
                    setTrainRatio(0.7);
                    setValRatio(0.15);
                    setTestRatio(0.15);
                    setRandomSeed(42);
                    return;
                  }
                  const nextId = Number(value);
                  setSplitId(nextId);
                  const selectedSplit = savedSplits.find((row) => row.id === nextId);
                  if (selectedSplit) {
                    setTrainRatio(selectedSplit.train_ratio);
                    setValRatio(selectedSplit.val_ratio);
                    setTestRatio(selectedSplit.test_ratio);
                    setRandomSeed(selectedSplit.random_seed);
                  }
                }}
                data-testid="job-data-split"
              >
                <option value="">
                  Default runtime split · {Math.round(trainRatio * 100)}/{Math.round(valRatio * 100)}/{Math.round(testRatio * 100)} · seed {randomSeed}
                </option>
                {savedSplits.map((split) => (
                  <option key={split.id} value={split.id}>
                    {split.name} · {Math.round(split.train_ratio * 100)}/{Math.round(split.val_ratio * 100)}/{Math.round(split.test_ratio * 100)} · seed {split.random_seed}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-hint">
              {splitId
                ? `Using saved split #${splitId}: ${(trainRatio * 100).toFixed(0)}% training, ${(valRatio * 100).toFixed(0)}% validation, ${(testRatio * 100).toFixed(0)}% test · seed ${randomSeed}`
                : `Default runtime split: ${(trainRatio * 100).toFixed(0)}% training, ${(valRatio * 100).toFixed(0)}% validation, ${(testRatio * 100).toFixed(0)}% test · seed ${randomSeed}`}
            </p>
          </div>
          <div className="form-section">
            <span className="eyebrow">Estimator</span>
            <label>Algorithm
              <select
                value={algorithm}
                onChange={(event) => onAlgorithmChange(event.target.value)}
                disabled={resolvingProblemType}
                data-testid="job-algorithm"
              >
                {visibleAlgorithms.map((item) => (
                  <option key={item.id} value={item.id}>{item.display_name}</option>
                ))}
              </select>
            </label>
            <label>Hyperparameters
              <textarea
                className="code-input"
                value={hyperparameters}
                onChange={(event) => {
                  setSubmitError("");
                  setHyperparameters(event.target.value);
                }}
                spellCheck={false}
                data-testid="job-hyperparameters"
              />
            </label>
          </div>
          <div className="training-submit-footer" data-testid="training-submit-actions">
            {submitError ? (
              <div className="error training-submit-error" role="alert" data-testid="training-submit-error">
                {submitError}
              </div>
            ) : null}
            <div className="row-actions form-actions">
              <button
                className="btn"
                type="submit"
                disabled={busy || !datasetId || featureColumns.length === 0 || waitingForDetection}
                data-testid="job-submit"
              >
                {busy ? "Queuing…" : "Start training"}
              </button>
              <button className="btn secondary" type="button" onClick={() => nav(`/projects/${projectId}/jobs`)}>Cancel</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
