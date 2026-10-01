import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type Dataset, type DatasetSplit, type DatasetVersion, type Job } from "../api";
import { effectiveTargetColumns } from "../jobHelpers";
import { EmptyState, ErrorNotice, Loading, PageHeader } from "../components";
import {
  algorithmsForProblemType,
  algorithmsForTrainingTask,
  defaultAlgorithmId,
  formatHyperparameters,
  parseForecastHorizonsText,
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

const EMPTY_COLUMNS: string[] = [];

export default function JobCreate() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const requestedDatasetId = params.get("datasetId") || "";
  const cloneFrom = params.get("cloneFrom") || "";
  // Presence of datasetVersionId must be tracked separately from parse validity so
  // malformed values (abc, 0, empty) never silently fall back to latest.
  const hasExplicitDatasetVersionParam = params.has("datasetVersionId");
  const rawDatasetVersionIdParam = hasExplicitDatasetVersionParam
    ? (params.get("datasetVersionId") ?? "")
    : null;
  const parsedDatasetVersionId = (() => {
    if (rawDatasetVersionIdParam == null) return null;
    // Positive integer ids only — reject "", "abc", "0", "-1", "1.5", "01".
    if (!/^[1-9]\d*$/.test(rawDatasetVersionIdParam)) return null;
    const parsed = Number(rawDatasetVersionIdParam);
    return Number.isSafeInteger(parsed) ? parsed : null;
  })();
  // cloneFrom wins over query-string dataset/version preselection
  const shouldHonorExplicitVersion = !cloneFrom && hasExplicitDatasetVersionParam;
  const handoffVersionId = shouldHonorExplicitVersion ? parsedDatasetVersionId : null;
  const malformedExplicitVersion =
    shouldHonorExplicitVersion && parsedDatasetVersionId == null;
  const malformedVersionError = malformedExplicitVersion
    ? `Dataset version "${rawDatasetVersionIdParam}" is invalid. Select a valid version to continue.`
    : null;

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [catalog, setCatalog] = useState<AlgorithmSpec[]>([]);
  const [datasetId, setDatasetId] = useState(requestedDatasetId);
  const [datasetVersionId, setDatasetVersionId] = useState<number | null>(null);
  const [name, setName] = useState("baseline-training");
  const [description, setDescription] = useState("");
  const [targets, setTargets] = useState<string[]>(["target"]);
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
  const [splitStrategy, setSplitStrategy] = useState<"random" | "time">("random");
  const [timeColumn, setTimeColumn] = useState("");
  const [trainingTask, setTrainingTask] = useState<"tabular" | "forecasting">("tabular");
  const [forecastHorizonsText, setForecastHorizonsText] = useState("1, 2, 3");
  const [maxRetries, setMaxRetries] = useState(1);
  const [savedSplits, setSavedSplits] = useState<DatasetSplit[]>([]);
  const [splitId, setSplitId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cloneLoaded, setCloneLoaded] = useState(!cloneFrom);
  const [versionError, setVersionError] = useState<string | null>(malformedVersionError);
  const [honorHandoffVersion, setHonorHandoffVersion] = useState(shouldHonorExplicitVersion);
  const [versionsResolved, setVersionsResolved] = useState(false);

  const selected = datasets.find((d) => String(d.id) === datasetId);
  const selectedVersion = versions.find((version) => version.id === datasetVersionId) ?? null;
  const schemaColumns = useMemo(() => {
    if (selectedVersion == null) return EMPTY_COLUMNS;
    if (selectedVersion.columns.length > 0) return selectedVersion.columns;
    return selected?.columns || EMPTY_COLUMNS;
  }, [selected?.columns, selectedVersion]);
  const primaryTarget = targets[0] ?? "";
  const isForecasting = trainingTask === "forecasting";
  const isMultiTarget = !isForecasting && targets.length > 1;
  const effectiveProblemType = isForecasting || isMultiTarget
    ? "regression"
    : problemType === "auto"
      ? detectedType || "auto"
      : problemType;
  const visibleAlgorithms = useMemo(
    () =>
      algorithmsForTrainingTask(
        catalog,
        effectiveProblemType === "auto" ? "" : effectiveProblemType,
        trainingTask,
      ),
    [catalog, effectiveProblemType, trainingTask],
  );
  const selectedAlgorithm = catalog.find((item) => item.id === algorithm);
  const effectiveSplitStrategy =
    splitId != null
      ? ((savedSplits.find((row) => row.id === splitId)?.split_strategy || "random") === "time"
          ? "time"
          : "random")
      : splitStrategy;
  const effectiveTimeColumn =
    splitId != null
      ? (savedSplits.find((row) => row.id === splitId)?.time_column || "")
      : timeColumn;
  const reservedTimeColumn =
    effectiveSplitStrategy === "time" && effectiveTimeColumn ? effectiveTimeColumn : "";
  const availableFeatures = schemaColumns.filter(
    (column) => !targets.includes(column) && column !== reservedTimeColumn,
  );
  const availableTargets = schemaColumns.filter((column) => column !== reservedTimeColumn);
  const selectableSavedSplits = useMemo(
    () =>
      isForecasting
        ? savedSplits.filter((row) => (row.split_strategy || "random") === "time")
        : savedSplits,
    [isForecasting, savedSplits],
  );
  const selectedSavedSplit = splitId != null ? savedSplits.find((row) => row.id === splitId) : null;

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
        // When an explicit datasetVersionId handoff is present (valid or malformed),
        // wait for version resolution before choosing targets to avoid a latest-schema flicker.
        if (!shouldHonorExplicitVersion) {
          if (selectedDataset?.columns.includes("target")) setTargets(["target"]);
          else if (selectedDataset?.columns.length) {
            setTargets([selectedDataset.columns[selectedDataset.columns.length - 1]]);
          }
        }
        const defaults = catalogRows.algorithms.find((item) => item.id === "random_forest");
        if (defaults) setHyperparameters(formatHyperparameters(defaults.default_hyperparameters));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Datasets could not be loaded."))
      .finally(() => setLoading(false));
  }, [projectId, requestedDatasetId, shouldHonorExplicitVersion]);

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
        setTargets(effectiveTargetColumns(job));
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
        setSplitStrategy(job.split_strategy === "time" ? "time" : "random");
        setTimeColumn(job.time_column || "");
        setTrainingTask(job.training_task === "forecasting" ? "forecasting" : "tabular");
        if (job.training_task === "forecasting") {
          const horizons = Array.isArray(job.forecast_horizons) ? job.forecast_horizons : [];
          setForecastHorizonsText(horizons.length ? horizons.join(", ") : "1, 2, 3");
          setProblemType("regression");
          setSplitStrategy("time");
        }
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
    setVersionsResolved(false);
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${selected.id}/versions`)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);

        setDatasetVersionId((current) => {
          if (current && rows.some((row) => row.id === current)) return current;
          if (honorHandoffVersion) {
            // Explicit query handoff: never silently fall back to latest,
            // including when the param is malformed (handoffVersionId == null).
            if (handoffVersionId == null) return null;
            const exact = rows.find((row) => row.id === handoffVersionId);
            return exact ? exact.id : null;
          }
          const preferred =
            rows.find((row) => row.version === selected.latest_version) || rows[0];
          return preferred?.id ?? null;
        });

        if (honorHandoffVersion) {
          if (handoffVersionId == null) {
            setVersionError(
              malformedVersionError
                ?? "Dataset version query value is invalid. Select a valid version to continue.",
            );
          } else {
            const exact = rows.find((row) => row.id === handoffVersionId);
            if (exact) setVersionError(null);
            else {
              setVersionError(
                `Dataset version #${handoffVersionId} was not found for this dataset. Select a valid version to continue.`,
              );
            }
          }
        } else {
          setVersionError(null);
        }
        setVersionsResolved(true);
      })
      .catch(() => {
        if (!cancelled) {
          setVersions([]);
          setDatasetVersionId(null);
          setVersionsResolved(true);
          if (honorHandoffVersion) {
            setVersionError(
              handoffVersionId == null
                ? (malformedVersionError
                  ?? "Dataset version query value is invalid. Select a valid version to continue.")
                : `Dataset version #${handoffVersionId} could not be loaded. Select a valid version to continue.`,
            );
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [handoffVersionId, honorHandoffVersion, malformedVersionError, projectId, selected]);

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
    if (!versionsResolved || versionError) return;
    if (schemaColumns.length === 0) return;
    if (cloneFrom && !cloneLoaded) return;
    const validTargets = targets.filter(
      (column) => schemaColumns.includes(column) && column !== reservedTimeColumn,
    );
    if (validTargets.length === 0) {
      const fallbackPool = schemaColumns.filter((column) => column !== reservedTimeColumn);
      if (fallbackPool.includes("target") && !cloneFrom) setTargets(["target"]);
      else setTargets([fallbackPool[fallbackPool.length - 1] || ""]);
    } else if (validTargets.length !== targets.length) {
      setTargets(validTargets);
    }
  }, [
    cloneFrom,
    cloneLoaded,
    reservedTimeColumn,
    schemaColumns,
    targets,
    versionError,
    versionsResolved,
  ]);

  useEffect(() => {
    if (!versionsResolved || versionError) return;
    if (schemaColumns.length === 0 || targets.length === 0) return;
    if (cloneFrom && !cloneLoaded) return;
    setFeatureColumns((current) => {
      const available = schemaColumns.filter(
        (column) => !targets.includes(column) && column !== reservedTimeColumn,
      );
      const kept = current.filter(
        (column) =>
          !targets.includes(column) &&
          schemaColumns.includes(column) &&
          column !== reservedTimeColumn,
      );
      const schemaMismatch = current.some(
        (column) => !schemaColumns.includes(column) && !targets.includes(column),
      );
      if (!current.length || schemaMismatch) return available;
      return kept;
    });
  }, [
    cloneFrom,
    cloneLoaded,
    reservedTimeColumn,
    schemaColumns,
    targets,
    versionError,
    versionsResolved,
  ]);

  useEffect(() => {
    if (!projectId || !datasetId || targets.length === 0 || isMultiTarget) {
      if (isMultiTarget) {
        setDetectedType("regression");
        setProblemTypeDetectionError(null);
        setResolvingProblemType(false);
      } else if (problemType !== "auto") {
        setDetectedType(problemType);
        setProblemTypeDetectionError(null);
      }
      if (!isMultiTarget && problemType !== "auto") {
        setResolvingProblemType(false);
      }
      return;
    }
    if (!versionsResolved || versionError || datasetVersionId == null) {
      setDetectedType(null);
      setProblemTypeDetectionError(null);
      setResolvingProblemType(false);
      return;
    }
    let cancelled = false;
    setDetectedType(null);
    setProblemTypeDetectionError(null);
    setResolvingProblemType(true);
    const resolveBody = targets.length > 1
      ? { dataset_id: Number(datasetId), dataset_version_id: datasetVersionId, target_columns: targets, problem_type: "auto" }
      : { dataset_id: Number(datasetId), dataset_version_id: datasetVersionId, target_column: primaryTarget, problem_type: "auto" };
    api<ResolveResponse>(`/projects/${projectId}/training/resolve-problem-type`, {
      method: "POST",
      body: JSON.stringify(resolveBody),
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
  }, [datasetId, datasetVersionId, isMultiTarget, primaryTarget, problemType, projectId, targets, versionError, versionsResolved]);

  useEffect(() => {
    if (isForecasting) {
      if (targets.length > 1) setTargets((current) => current.slice(0, 1));
      if (problemType !== "regression") setProblemType("regression");
      if (splitId == null && splitStrategy !== "time") setSplitStrategy("time");
      if (
        splitId != null &&
        selectedSavedSplit &&
        (selectedSavedSplit.split_strategy || "random") !== "time"
      ) {
        setSplitId(null);
        setSplitStrategy("time");
      }
    }
  }, [isForecasting, problemType, selectedSavedSplit, splitId, splitStrategy, targets.length]);

  useEffect(() => {
    if (!catalog.length) return;
    const filterType = effectiveProblemType;
    if (!filterType || filterType === "auto") return;
    const allowed = algorithmsForTrainingTask(catalog, filterType, trainingTask);
    if (!allowed.some((item) => item.id === algorithm)) {
      const nextId = defaultAlgorithmId(catalog, filterType);
      const next = catalog.find((item) => item.id === nextId);
      setAlgorithm(nextId);
      if (next) setHyperparameters(formatHyperparameters(next.default_hyperparameters));
    }
  }, [algorithm, catalog, effectiveProblemType, trainingTask]);

  function onAlgorithmChange(nextId: string) {
    setSubmitError("");
    setAlgorithm(nextId);
    const next = catalog.find((item) => item.id === nextId);
    if (next) setHyperparameters(formatHyperparameters(next.default_hyperparameters));
  }

  function toggleTarget(column: string) {
    setSubmitError("");
    setTargets((current) => {
      if (isForecasting) {
        return [column];
      }
      if (current.includes(column)) {
        if (current.length === 1) return current;
        return current.filter((item) => item !== column);
      }
      return [...current, column];
    });
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
      if (versionError || datasetVersionId == null) {
        throw new Error(versionError || "Select a dataset version.");
      }
      if (targets.length === 0) {
        throw new Error("Select at least one target column.");
      }
      if (featureColumns.length === 0) {
        throw new Error("Select at least one feature column.");
      }
      if (isForecasting && targets.length !== 1) {
        throw new Error("Forecasting requires exactly one target column.");
      }
      const submitSplitStrategy = isForecasting ? "time" : splitStrategy;
      if (splitId == null && submitSplitStrategy === "time" && !timeColumn.trim()) {
        throw new Error("Select a time column for a time-ordered split.");
      }
      if (
        isForecasting &&
        splitId != null &&
        selectedSavedSplit &&
        (selectedSavedSplit.split_strategy || "random") !== "time"
      ) {
        throw new Error("Forecasting requires a time-ordered saved split.");
      }
      let forecastHorizons: number[] = [];
      if (isForecasting) {
        const parsedHorizons = parseForecastHorizonsText(forecastHorizonsText);
        if (!parsedHorizons.ok) throw new Error(parsedHorizons.message);
        forecastHorizons = parsedHorizons.value;
      }
      if (!isForecasting && !isMultiTarget && problemType === "auto" && (resolvingProblemType || !detectedType)) {
        throw new Error("Wait for problem type detection to finish before starting training.");
      }
      const filterType = effectiveProblemType;
      if (filterType && selectedAlgorithm && !selectedAlgorithm.problem_types.includes(filterType)) {
        throw new Error(`${selectedAlgorithm.display_name} is not supported for ${filterType}.`);
      }
      if (isForecasting && selectedAlgorithm && !selectedAlgorithm.supports_forecasting) {
        throw new Error(`${selectedAlgorithm.display_name} does not support forecasting.`);
      }
      const parsed = validateHyperparametersText(hyperparameters, selectedAlgorithm);
      if (!parsed.ok) throw new Error(parsed.message);
      const submitProblemType = isForecasting || isMultiTarget ? "regression" : problemType;
      const job = await api<Job>(`/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          dataset_id: Number(datasetId),
          dataset_version_id: datasetVersionId,
          split_id: splitId,
          target_columns: targets,
          problem_type: submitProblemType,
          algorithm,
          hyperparameters: parsed.value,
          feature_columns: featureColumns,
          random_seed: randomSeed,
          train_ratio: trainRatio,
          val_ratio: valRatio,
          test_ratio: testRatio,
          split_strategy: splitId != null ? undefined : submitSplitStrategy,
          time_column:
            splitId != null
              ? undefined
              : submitSplitStrategy === "time"
                ? timeColumn.trim() || null
                : null,
          training_task: trainingTask,
          forecast_strategy: isForecasting ? "direct_multioutput" : null,
          forecast_horizons: isForecasting ? forecastHorizons : [],
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
  const waitingForDetection =
    !isForecasting && !isMultiTarget && problemType === "auto" && (resolvingProblemType || !detectedType);

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
              <label>Training task
                <select
                  value={trainingTask}
                  onChange={(event) => {
                    setSubmitError("");
                    const next = event.target.value === "forecasting" ? "forecasting" : "tabular";
                    setTrainingTask(next);
                    if (next === "forecasting") {
                      setProblemType("regression");
                      setSplitStrategy("time");
                      setTargets((current) => current.slice(0, 1));
                      if (
                        splitId != null &&
                        selectedSavedSplit &&
                        (selectedSavedSplit.split_strategy || "random") !== "time"
                      ) {
                        setSplitId(null);
                      }
                    }
                  }}
                  data-testid="job-training-task"
                >
                  <option value="tabular">Tabular</option>
                  <option value="forecasting">Forecasting</option>
                </select>
              </label>
              <label>Problem type
                <select
                  value={isForecasting || isMultiTarget ? "regression" : problemType}
                  onChange={(event) => {
                    setSubmitError("");
                    setProblemType(event.target.value);
                  }}
                  disabled={isForecasting || isMultiTarget}
                  data-testid="job-problem-type"
                >
                  <option value="auto" disabled={isForecasting}>Detect automatically</option>
                  <option value="classification" disabled={isForecasting || isMultiTarget}>Classification</option>
                  <option value="regression">Regression</option>
                </select>
              </label>
            </div>
            {isForecasting && (
              <p className="form-hint" data-testid="forecasting-task-hint">
                Forecasting trains direct multi-horizon regression on a single numeric target with a time-ordered split.
              </p>
            )}
            {isMultiTarget && (
              <p className="form-hint" data-testid="multi-target-hint">
                Multiple targets are trained as multi-output regression.
              </p>
            )}
            {!isForecasting && !isMultiTarget && problemType === "auto" && resolvingProblemType && (
              <p className="form-hint" data-testid="detecting-problem-type">
                Detecting problem type…
              </p>
            )}
            {!isForecasting && !isMultiTarget && problemType === "auto" && !resolvingProblemType && detectedType && (
              <p className="form-hint" data-testid="detected-problem-type">
                Detected problem type: {titleCaseProblemType(detectedType)}
              </p>
            )}
            {!isForecasting && !isMultiTarget && problemType === "auto" && !resolvingProblemType && problemTypeDetectionError && (
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
                    setHonorHandoffVersion(false);
                    setVersionError(null);
                    setVersionsResolved(false);
                    setDatasetId(event.target.value);
                    setDatasetVersionId(null);
                    setSplitId(null);
                    setSavedSplits([]);
                    setFeatureColumns([]);
                    setTargets([]);
                  }}
                  required
                  data-testid="job-dataset"
                >
                  {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · v{dataset.latest_version}</option>)}
                </select>
              </label>
            </div>
            <fieldset className="feature-columns" data-testid="job-targets">
              <legend>
                {isForecasting ? "Forecast target" : "Target columns"} · {targets.length} selected
              </legend>
              <div className="feature-column-list">
                {availableTargets.map((column) => (
                  <label key={column} className="feature-column-option">
                    <input
                      type={isForecasting ? "radio" : "checkbox"}
                      name={isForecasting ? "forecast-target" : undefined}
                      checked={targets.includes(column)}
                      onChange={() => toggleTarget(column)}
                      data-testid={`target-${column}`}
                    />
                    <span>{column}</span>
                  </label>
                ))}
              </div>
              {targets.length === 0 && (
                <p className="form-hint">
                  {isForecasting ? "Select exactly one forecast target." : "Select at least one target column."}
                </p>
              )}
              {isForecasting && (
                <p className="form-hint" data-testid="forecast-target-hint">
                  Forecasting supports a single numeric target. Use lag/rolling features prepared in Phase 6-B when historical target context is needed.
                </p>
              )}
            </fieldset>
            {isForecasting ? (
              <div className="form-grid" data-testid="job-forecast-config">
                <label>
                  Forecast strategy
                  <input value="Direct multi-output" disabled data-testid="job-forecast-strategy" />
                </label>
                <label>
                  Forecast horizons
                  <input
                    value={forecastHorizonsText}
                    onChange={(event) => {
                      setSubmitError("");
                      setForecastHorizonsText(event.target.value);
                    }}
                    placeholder="1, 2, 3"
                    data-testid="job-forecast-horizons"
                    required
                  />
                </label>
                <p className="form-hint" data-testid="job-forecast-horizons-help">
                  Horizons are future observation steps after chronological ordering, not clock-time durations.
                </p>
              </div>
            ) : null}
            {versionError ? (
              <p className="form-hint" role="alert" data-testid="job-dataset-version-error">
                {versionError}
              </p>
            ) : null}
            {versions.length > 0 && (
              <label>Dataset version
                <select
                  value={datasetVersionId ?? ""}
                  onChange={(event) => {
                    setSubmitError("");
                    setHonorHandoffVersion(false);
                    setVersionError(null);
                    setSplitId(null);
                    setDatasetVersionId(Number(event.target.value));
                  }}
                  data-testid="job-dataset-version"
                >
                  {versionError ? <option value="">Select a dataset version</option> : null}
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
              Saved split
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
                    setSplitStrategy("random");
                    setTimeColumn("");
                    return;
                  }
                  const nextId = Number(value);
                  setSplitId(nextId);
                  const nextSplit = savedSplits.find((row) => row.id === nextId);
                  if (nextSplit) {
                    setTrainRatio(nextSplit.train_ratio);
                    setValRatio(nextSplit.val_ratio);
                    setTestRatio(nextSplit.test_ratio);
                    setRandomSeed(nextSplit.random_seed);
                    setSplitStrategy(nextSplit.split_strategy === "time" ? "time" : "random");
                    setTimeColumn(nextSplit.time_column || "");
                    const reserved =
                      nextSplit.split_strategy === "time" ? nextSplit.time_column || "" : "";
                    if (reserved) {
                      setTargets((current) => current.filter((column) => column !== reserved));
                      setFeatureColumns((current) => current.filter((column) => column !== reserved));
                    }
                  }
                }}
                data-testid="job-data-split"
              >
                <option value="">
                  Manual runtime split · {Math.round(trainRatio * 100)}/{Math.round(valRatio * 100)}/{Math.round(testRatio * 100)}
                </option>
                {selectableSavedSplits.map((split) => {
                  const label =
                    (split.split_strategy || "random") === "time"
                      ? `Time ordered · ${split.time_column || "—"}`
                      : "Random";
                  return (
                    <option key={split.id} value={split.id}>
                      {split.name} · {label} · {Math.round(split.train_ratio * 100)}/{Math.round(split.val_ratio * 100)}/{Math.round(split.test_ratio * 100)}
                    </option>
                  );
                })}
              </select>
            </label>
            {isForecasting ? (
              <p className="form-hint" data-testid="job-forecast-split-hint">
                Forecasting requires a time-ordered split. Random saved splits are hidden.
              </p>
            ) : null}
            {selectedSavedSplit ? (
              <p className="form-hint" data-testid="job-saved-split-summary">
                Using saved split #{selectedSavedSplit.id}:{" "}
                {(selectedSavedSplit.split_strategy || "random") === "time"
                  ? `Time ordered · ${selectedSavedSplit.time_column || "—"}`
                  : "Random"}
                {` · ${(trainRatio * 100).toFixed(0)}% training, ${(valRatio * 100).toFixed(0)}% validation, ${(testRatio * 100).toFixed(0)}% test`}
                {(selectedSavedSplit.split_strategy || "random") === "random"
                  ? ` · seed ${randomSeed}`
                  : ""}
              </p>
            ) : (
              <>
                <label>
                  Split strategy
                  <select
                    value={isForecasting ? "time" : splitStrategy}
                    onChange={(event) => {
                      setSubmitError("");
                      const next = event.target.value === "time" ? "time" : "random";
                      setSplitStrategy(next);
                      if (next === "random") {
                        setTimeColumn("");
                      } else if (timeColumn) {
                        setTargets((current) => current.filter((column) => column !== timeColumn));
                        setFeatureColumns((current) =>
                          current.filter((column) => column !== timeColumn),
                        );
                      }
                    }}
                    disabled={isForecasting}
                    data-testid="job-split-strategy"
                  >
                    <option value="random" disabled={isForecasting}>Random</option>
                    <option value="time">Time ordered</option>
                  </select>
                </label>
                {(isForecasting || splitStrategy === "time") ? (
                  <label>
                    Time column
                    <select
                      value={timeColumn}
                      onChange={(event) => {
                        setSubmitError("");
                        const next = event.target.value;
                        setTimeColumn(next);
                        if (next) {
                          setTargets((current) => current.filter((column) => column !== next));
                          setFeatureColumns((current) =>
                            current.filter((column) => column !== next),
                          );
                        }
                      }}
                      data-testid="job-time-column"
                      required
                    >
                      <option value="">Select time column…</option>
                      {schemaColumns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <p className="form-hint" data-testid="job-runtime-split-summary">
                  {isForecasting || splitStrategy === "time"
                    ? `Time-ordered runtime split${timeColumn ? ` on ${timeColumn}` : ""}: ${(trainRatio * 100).toFixed(0)}% training, ${(valRatio * 100).toFixed(0)}% validation, ${(testRatio * 100).toFixed(0)}% test.`
                    : `Random runtime split: ${(trainRatio * 100).toFixed(0)}% training, ${(valRatio * 100).toFixed(0)}% validation, ${(testRatio * 100).toFixed(0)}% test · seed ${randomSeed}`}
                </p>
                {isForecasting || splitStrategy === "time" ? (
                  <p className="form-hint" data-testid="job-time-seed-hint">
                    Random seed does not shuffle a time-ordered split; it may still affect model training.
                  </p>
                ) : null}
              </>
            )}
          </div>
          <div className="form-section">
            <span className="eyebrow">Estimator</span>
            <label>Algorithm
              <select
                value={algorithm}
                onChange={(event) => onAlgorithmChange(event.target.value)}
                disabled={resolvingProblemType && !isMultiTarget}
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
                disabled={busy || !datasetId || datasetVersionId == null || Boolean(versionError) || targets.length === 0 || featureColumns.length === 0 || waitingForDetection || !versionsResolved}
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
