import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Dataset, type DatasetVersion, type QualityRule } from "./api";
import { validateSplitRatios } from "./pipelineHelpers";
import {
  algorithmsForTrainingTask,
  defaultAlgorithmId,
  formatHyperparameters,
  parseForecastHorizonsText,
  validateHyperparametersText,
  type AlgorithmSpec,
} from "./trainingConfig";

export type NodeConfigFormProps = {
  projectId: string;
  nodeType: string;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  upstreamDatasetId?: number | null;
  datasetColumns?: string[];
  formError?: string;
};

type GatePolicyOption = {
  id: number;
  name: string;
  version?: number;
  is_active?: boolean;
};

type CatalogResponse = { algorithms: AlgorithmSpec[] };

function asNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return value == null ? fallback : String(value);
}

function DatasetLoadForm({
  projectId,
  config,
  onChange,
}: Pick<NodeConfigFormProps, "projectId" | "config" | "onChange">) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [loadError, setLoadError] = useState("");
  const datasetId = config.dataset_id != null ? Number(config.dataset_id) : null;
  const versionId = config.dataset_version_id != null ? Number(config.dataset_version_id) : null;

  useEffect(() => {
    let cancelled = false;
    api<Dataset[]>(`/projects/${projectId}/datasets`)
      .then((rows) => {
        if (!cancelled) setDatasets(rows);
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Datasets could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!datasetId) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${datasetId}/versions`)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, projectId]);

  return (
    <div className="node-config-form" data-testid="node-config-dataset-load">
      {loadError && <p className="error">{loadError}</p>}
      <label>
        Dataset
        <select
          data-testid="node-config-dataset"
          value={datasetId ?? ""}
          onChange={(event) => {
            const nextId = event.target.value ? Number(event.target.value) : null;
            onChange({
              ...config,
              dataset_id: nextId,
              dataset_version_id: null,
            });
          }}
        >
          <option value="">Select dataset…</option>
          {datasets.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Version
        <select
          data-testid="node-config-version"
          value={versionId ?? ""}
          disabled={!datasetId}
          onChange={(event) => {
            const nextId = event.target.value ? Number(event.target.value) : null;
            onChange({
              ...config,
              dataset_id: datasetId,
              dataset_version_id: nextId,
            });
          }}
        >
          <option value="">Select version…</option>
          {versions.map((row) => (
            <option key={row.id} value={row.id}>
              v{row.version} · {row.original_filename}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function QualityCheckForm({
  projectId,
  config,
  onChange,
  upstreamDatasetId,
}: Pick<NodeConfigFormProps, "projectId" | "config" | "onChange" | "upstreamDatasetId">) {
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [hint, setHint] = useState("");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ok" | "error">("idle");

  useEffect(() => {
    if (!upstreamDatasetId) {
      setRules([]);
      setLoadState("idle");
      setHint("Connect a Dataset Load step upstream to choose dataset rules.");
      return;
    }
    let cancelled = false;
    setLoadState("loading");
    setHint("");
    api<QualityRule[]>(
      `/projects/${projectId}/quality-rules?dataset_id=${upstreamDatasetId}&include_inactive=false&include_unassigned=false`,
    )
      .then((rows) => {
        if (cancelled) return;
        setRules(rows.filter((row) => row.dataset_id != null && row.is_active));
        setLoadState("ok");
      })
      .catch((reason) => {
        if (cancelled) return;
        setRules([]);
        setLoadState("error");
        setHint(reason instanceof Error ? reason.message : "Quality rules could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, upstreamDatasetId]);

  useEffect(() => {
    if (loadState !== "ok") return;
    const selected = config.quality_rule_id;
    if (selected == null || selected === "") return;
    if (!rules.some((row) => row.id === Number(selected))) {
      const { quality_rule_id: _stale, ...rest } = config;
      onChange(rest);
    }
  }, [loadState, rules, config, onChange]);

  return (
    <div className="node-config-form" data-testid="node-config-quality-check">
      {hint && <p className="form-hint" data-testid="node-config-quality-hint">{hint}</p>}
      <label>
        Quality rule
        <select
          data-testid="node-config-quality-rule"
          value={config.quality_rule_id != null ? String(config.quality_rule_id) : ""}
          disabled={!upstreamDatasetId || loadState === "loading"}
          onChange={(event) => {
            onChange({
              ...config,
              quality_rule_id: event.target.value ? Number(event.target.value) : undefined,
            });
          }}
        >
          <option value="">Select rule…</option>
          {rules.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          data-testid="node-config-block-on-fail"
          checked={config.block_on_fail !== false}
          onChange={(event) => onChange({ ...config, block_on_fail: event.target.checked })}
        />
        Block on fail
      </label>
    </div>
  );
}

function SplitForm({
  config,
  onChange,
  datasetColumns = [],
}: Pick<NodeConfigFormProps, "config" | "onChange" | "datasetColumns">) {
  const train = asNumber(config.train_ratio, 0.7);
  const val = asNumber(config.val_ratio, 0.15);
  const test = asNumber(config.test_ratio, 0.15);
  const seed = asNumber(config.random_seed, 42);
  const splitStrategy = asString(config.split_strategy, "random") === "time" ? "time" : "random";
  const timeColumn = asString(config.time_column, "");
  const localError = validateSplitRatios(train, val, test, seed);

  function patch(partial: Record<string, unknown>) {
    onChange({ ...config, ...partial });
  }

  return (
    <div className="node-config-form" data-testid="node-config-split">
      <label>
        Split strategy
        <select
          data-testid="node-config-split-strategy"
          value={splitStrategy}
          onChange={(event) => {
            const next = event.target.value === "time" ? "time" : "random";
            patch({
              split_strategy: next,
              time_column: next === "time" ? timeColumn || null : null,
            });
          }}
        >
          <option value="random">Random</option>
          <option value="time">Time ordered</option>
        </select>
      </label>
      {splitStrategy === "time" ? (
        <>
          <label>
            Time column
            <select
              data-testid="node-config-time-column"
              value={timeColumn}
              onChange={(event) => patch({ split_strategy: "time", time_column: event.target.value || null })}
            >
              <option value="">Select time column…</option>
              {datasetColumns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
          </label>
          <p className="form-hint" data-testid="node-config-split-time-help">
            Rows are ordered chronologically before contiguous train / validation / test partitions are created.
          </p>
        </>
      ) : null}
      <label>
        Train ratio
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          data-testid="node-config-train-ratio"
          value={train}
          onChange={(event) => patch({ train_ratio: Number(event.target.value) })}
        />
      </label>
      <label>
        Validation ratio
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          data-testid="node-config-val-ratio"
          value={val}
          onChange={(event) => patch({ val_ratio: Number(event.target.value) })}
        />
      </label>
      <label>
        Test ratio
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          data-testid="node-config-test-ratio"
          value={test}
          onChange={(event) => patch({ test_ratio: Number(event.target.value) })}
        />
      </label>
      <label>
        Random seed
        <input
          type="number"
          step="1"
          data-testid="node-config-seed"
          value={seed}
          onChange={(event) => patch({ random_seed: Number(event.target.value) })}
        />
      </label>
      {splitStrategy === "time" ? (
        <p className="form-hint" data-testid="node-config-split-seed-hint">
          Random seed does not shuffle a time-ordered split.
        </p>
      ) : null}
      {localError && (
        <p className="error" data-testid="node-config-split-error">
          {localError}
        </p>
      )}
    </div>
  );
}

function TrainingForm({
  projectId,
  config,
  onChange,
  datasetColumns = [],
}: Pick<NodeConfigFormProps, "projectId" | "config" | "onChange" | "datasetColumns">) {
  const [catalog, setCatalog] = useState<AlgorithmSpec[]>([]);
  const [hyperText, setHyperText] = useState(() =>
    formatHyperparameters((config.hyperparameters as Record<string, unknown>) || {}),
  );
  const [hyperError, setHyperError] = useState("");
  const [horizonError, setHorizonError] = useState("");
  const trainingTask =
    asString(config.training_task, "tabular") === "forecasting" ? "forecasting" : "tabular";
  const isForecasting = trainingTask === "forecasting";
  const problemType = isForecasting ? "regression" : asString(config.problem_type, "auto");
  const algorithm = asString(config.algorithm, isForecasting ? "ridge" : "random_forest");
  const target = asString(config.target_column, "target");
  const features = Array.isArray(config.feature_columns)
    ? (config.feature_columns as string[])
    : [];
  const forecastHorizonsText = Array.isArray(config.forecast_horizons)
    ? (config.forecast_horizons as unknown[]).join(", ")
    : asString(config.forecast_horizons_text, "1, 2, 3");
  const [horizonsText, setHorizonsText] = useState(forecastHorizonsText || "1, 2, 3");
  const visibleAlgorithms = useMemo(
    () => algorithmsForTrainingTask(catalog, problemType, trainingTask),
    [catalog, problemType, trainingTask],
  );
  const selectedAlgorithm = catalog.find((item) => item.id === algorithm);
  const splitStrategy = isForecasting
    ? "time"
    : asString(config.split_strategy, "random") === "time"
      ? "time"
      : "random";
  const timeColumn = asString(config.time_column, "");
  const targetChoices = datasetColumns.filter(
    (column) => !(splitStrategy === "time" && timeColumn && column === timeColumn),
  );
  const featureChoices = datasetColumns.filter(
    (column) =>
      column !== target && !(splitStrategy === "time" && timeColumn && column === timeColumn),
  );

  function pickAlternateTarget(reserved: string, currentTarget: string): string {
    if (!reserved || reserved !== currentTarget) return currentTarget;
    const alternatives = datasetColumns.filter((column) => column !== reserved);
    if (alternatives.includes("target")) return "target";
    return alternatives[0] || "";
  }

  useEffect(() => {
    let cancelled = false;
    api<CatalogResponse>(`/projects/${projectId}/training/algorithms`)
      .then((rows) => {
        if (!cancelled) setCatalog(rows.algorithms || []);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    setHyperText(formatHyperparameters((config.hyperparameters as Record<string, unknown>) || {}));
  }, [config.hyperparameters, algorithm]);

  useEffect(() => {
    if (Array.isArray(config.forecast_horizons) && config.forecast_horizons.length) {
      setHorizonsText((config.forecast_horizons as unknown[]).join(", "));
    }
  }, [config.forecast_horizons]);

  useEffect(() => {
    if (!catalog.length || !problemType || problemType === "auto") return;
    if (visibleAlgorithms.some((item) => item.id === algorithm)) return;
    const chosen =
      visibleAlgorithms.find((item) => item.id === defaultAlgorithmId(catalog, problemType)) ||
      visibleAlgorithms[0];
    if (!chosen) return;
    onChange({
      ...config,
      algorithm: chosen.id,
      hyperparameters: chosen.default_hyperparameters || {},
    });
    setHyperText(formatHyperparameters(chosen.default_hyperparameters || {}));
    // Intentionally omit config/onChange from deps to avoid update loops when normalizing algorithm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [algorithm, catalog, problemType, trainingTask, visibleAlgorithms]);

  function setTrainingTask(next: "tabular" | "forecasting") {
    if (next === "forecasting") {
      const nextAlgorithm =
        visibleAlgorithms.find((item) => item.id === algorithm)?.id ||
        algorithmsForTrainingTask(catalog, "regression", "forecasting")[0]?.id ||
        "ridge";
      const spec = catalog.find((item) => item.id === nextAlgorithm);
      const parsed = parseForecastHorizonsText(horizonsText || "1, 2, 3");
      onChange({
        ...config,
        training_task: "forecasting",
        problem_type: "regression",
        split_strategy: "time",
        time_column: timeColumn || null,
        forecast_strategy: "direct_multioutput",
        forecast_horizons: parsed.ok ? parsed.value : [1, 2, 3],
        algorithm: nextAlgorithm,
        hyperparameters: spec?.default_hyperparameters || config.hyperparameters || {},
        feature_columns: features.filter(
          (column) => column !== target && !(timeColumn && column === timeColumn),
        ),
      });
      if (spec) setHyperText(formatHyperparameters(spec.default_hyperparameters));
      setHorizonError(parsed.ok ? "" : parsed.message);
      return;
    }
    onChange({
      ...config,
      training_task: "tabular",
      forecast_strategy: null,
      forecast_horizons: [],
    });
    setHorizonError("");
  }

  function setProblem(next: string) {
    if (isForecasting) return;
    const nextAlgorithm = defaultAlgorithmId(catalog, next);
    const spec = catalog.find((item) => item.id === nextAlgorithm);
    onChange({
      ...config,
      problem_type: next,
      algorithm: nextAlgorithm,
      hyperparameters: spec?.default_hyperparameters || {},
    });
    if (spec) setHyperText(formatHyperparameters(spec.default_hyperparameters));
  }

  function setAlgorithm(nextId: string) {
    const spec = catalog.find((item) => item.id === nextId);
    onChange({
      ...config,
      algorithm: nextId,
      hyperparameters: spec?.default_hyperparameters || {},
    });
    if (spec) setHyperText(formatHyperparameters(spec.default_hyperparameters));
  }

  function toggleFeature(column: string) {
    const next = features.includes(column)
      ? features.filter((item) => item !== column)
      : [...features, column];
    onChange({ ...config, feature_columns: next });
  }

  function applyHyperparameters(text: string) {
    setHyperText(text);
    const parsed = validateHyperparametersText(text, selectedAlgorithm);
    if (!parsed.ok) {
      setHyperError(parsed.message);
      return;
    }
    setHyperError("");
    onChange({ ...config, hyperparameters: parsed.value });
  }

  function applyHorizons(text: string) {
    setHorizonsText(text);
    const parsed = parseForecastHorizonsText(text);
    if (!parsed.ok) {
      setHorizonError(parsed.message);
      onChange({ ...config, forecast_horizons: [] });
      return;
    }
    setHorizonError("");
    onChange({
      ...config,
      training_task: "forecasting",
      forecast_strategy: "direct_multioutput",
      forecast_horizons: parsed.value,
    });
  }

  return (
    <div className="node-config-form" data-testid="node-config-training">
      <label>
        Training task
        <select
          data-testid="node-config-training-task"
          value={trainingTask}
          onChange={(event) =>
            setTrainingTask(event.target.value === "forecasting" ? "forecasting" : "tabular")
          }
        >
          <option value="tabular">Tabular</option>
          <option value="forecasting">Forecasting</option>
        </select>
      </label>
      {isForecasting ? (
        <p className="form-hint" data-testid="node-config-forecast-help">
          Use Lag / Rolling features from Dataset Preparation when historical target context is required.
        </p>
      ) : null}
      <label>
        {isForecasting ? "Forecast target" : "Target column"}
        {datasetColumns.length > 0 ? (
          <select
            data-testid="node-config-target"
            value={targetChoices.includes(target) ? target : ""}
            onChange={(event) => {
              const nextTarget = event.target.value;
              onChange({
                ...config,
                target_column: nextTarget,
                feature_columns: features.filter((column) => column !== nextTarget),
              });
            }}
          >
            {!targetChoices.includes(target) ? (
              <option value="">Select target column…</option>
            ) : null}
            {targetChoices.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        ) : (
          <input
            data-testid="node-config-target"
            value={target}
            onChange={(event) => onChange({ ...config, target_column: event.target.value })}
          />
        )}
      </label>
      <label>
        Problem type
        <select
          data-testid="node-config-problem-type"
          value={problemType}
          disabled={isForecasting}
          onChange={(event) => setProblem(event.target.value)}
        >
          <option value="auto" disabled={isForecasting}>Auto</option>
          <option value="classification" disabled={isForecasting}>Classification</option>
          <option value="regression">Regression</option>
        </select>
      </label>
      {isForecasting ? (
        <div data-testid="node-config-forecast-fields">
          <label>
            Forecast strategy
            <input value="Direct multi-output" disabled data-testid="node-config-forecast-strategy" />
          </label>
          <label>
            Forecast horizons
            <input
              data-testid="node-config-forecast-horizons"
              value={horizonsText}
              onChange={(event) => applyHorizons(event.target.value)}
              placeholder="1, 2, 3"
            />
          </label>
          <p className="form-hint" data-testid="node-config-forecast-horizons-help">
            Horizons are future observation steps after chronological ordering, not clock-time durations.
          </p>
          {horizonError ? (
            <p className="error" data-testid="node-config-forecast-horizon-error">
              {horizonError}
            </p>
          ) : null}
        </div>
      ) : null}
      <label>
        Algorithm
        <select
          data-testid="node-config-algorithm"
          value={algorithm}
          onChange={(event) => setAlgorithm(event.target.value)}
        >
          {visibleAlgorithms.map((item) => (
            <option key={item.id} value={item.id}>
              {item.display_name}
            </option>
          ))}
        </select>
      </label>
      {featureChoices.length > 0 && (
        <fieldset className="feature-checklist" data-testid="node-config-features">
          <legend>Features</legend>
          {featureChoices.map((column) => (
            <label key={column} className="checkbox-row">
              <input
                type="checkbox"
                checked={features.includes(column)}
                onChange={() => toggleFeature(column)}
              />
              {column}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        Split strategy
        <select
          data-testid="node-config-split-strategy"
          value={splitStrategy}
          disabled={isForecasting}
          onChange={(event) => {
            const next = event.target.value === "time" ? "time" : "random";
            const reserved = next === "time" ? timeColumn : "";
            const nextTarget = pickAlternateTarget(reserved, target);
            onChange({
              ...config,
              split_strategy: next,
              time_column: next === "time" ? timeColumn || null : null,
              target_column: nextTarget,
              feature_columns: features.filter(
                (column) =>
                  column !== nextTarget && !(reserved && column === reserved),
              ),
            });
          }}
        >
          <option value="random" disabled={isForecasting}>Random</option>
          <option value="time">Time ordered</option>
        </select>
      </label>
      {splitStrategy === "time" ? (
        <label>
          Time column
          <select
            data-testid="node-config-time-column"
            value={timeColumn}
            onChange={(event) => {
              const next = event.target.value;
              const nextTarget = pickAlternateTarget(next, target);
              onChange({
                ...config,
                split_strategy: "time",
                time_column: next || null,
                target_column: nextTarget,
                feature_columns: features.filter(
                  (column) => column !== next && column !== nextTarget,
                ),
              });
            }}
          >
            <option value="">Select time column…</option>
            {datasetColumns
              .filter((column) => column !== target)
              .map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <label>
        Hyperparameters
        <textarea
          className="code-input"
          data-testid="node-config-hyperparameters"
          value={hyperText}
          spellCheck={false}
          onChange={(event) => applyHyperparameters(event.target.value)}
        />
      </label>
      {hyperError && (
        <p className="error" data-testid="node-config-hyper-error">
          {hyperError}
        </p>
      )}
    </div>
  );
}

function EvaluationForm({
  config,
  onChange,
}: Pick<NodeConfigFormProps, "config" | "onChange">) {
  return (
    <div className="node-config-form" data-testid="node-config-evaluation">
      <label>
        Metric
        <input
          data-testid="node-config-metric"
          value={asString(config.metric, "accuracy")}
          onChange={(event) => onChange({ ...config, metric: event.target.value })}
        />
      </label>
      <label>
        Minimum
        <input
          type="number"
          step="any"
          data-testid="node-config-minimum"
          value={asNumber(config.minimum ?? config.min, 0.8)}
          onChange={(event) => onChange({ ...config, minimum: Number(event.target.value) })}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          data-testid="node-config-fail-on-gate"
          checked={config.fail_on_gate !== false}
          onChange={(event) => onChange({ ...config, fail_on_gate: event.target.checked })}
        />
        Fail on gate
      </label>
    </div>
  );
}

function ConditionForm({
  config,
  onChange,
}: Pick<NodeConfigFormProps, "config" | "onChange">) {
  const metric = asString(config.metric ?? config.left, "accuracy");
  const operator = asString(config.operator, ">=");
  const value = config.value ?? config.right ?? 0.8;
  return (
    <div className="node-config-form" data-testid="node-config-condition">
      <label>
        Metric / left
        <input
          data-testid="node-config-left"
          value={metric}
          onChange={(event) => {
            const { left: _left, ...rest } = config;
            onChange({ ...rest, metric: event.target.value });
          }}
        />
      </label>
      <label>
        Operator
        <select
          data-testid="node-config-operator"
          value={operator}
          onChange={(event) => onChange({ ...config, operator: event.target.value })}
        >
          {([">", ">=", "<", "<=", "==", "!="] as const).map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </label>
      <label>
        Value / right
        <input
          data-testid="node-config-right"
          value={String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            const asNum = Number(raw);
            const { right: _right, ...rest } = config;
            onChange({
              ...rest,
              value: raw === "" || Number.isNaN(asNum) ? raw : asNum,
            });
          }}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          data-testid="node-config-fail-on-false"
          checked={Boolean(config.fail_on_false)}
          onChange={(event) => onChange({ ...config, fail_on_false: event.target.checked })}
        />
        Fail on false
      </label>
    </div>
  );
}

function ApprovalRequestForm({
  projectId,
  config,
  onChange,
}: Pick<NodeConfigFormProps, "projectId" | "config" | "onChange">) {
  const [policies, setPolicies] = useState<GatePolicyOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<GatePolicyOption[]>(`/projects/${projectId}/gate-policies`)
      .then((rows) => {
        if (!cancelled) setPolicies(rows);
      })
      .catch(() => {
        if (!cancelled) setPolicies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="node-config-form" data-testid="node-config-approval">
      <label>
        Gate policy
        <select
          data-testid="node-config-gate-policy"
          value={config.gate_policy_id != null ? String(config.gate_policy_id) : ""}
          onChange={(event) => {
            onChange({
              ...config,
              gate_policy_id: event.target.value ? Number(event.target.value) : undefined,
            });
          }}
        >
          <option value="">Default active policy</option>
          {policies.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name} (#{row.id})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function BatchPredictionForm({
  projectId,
  config,
  onChange,
}: Pick<NodeConfigFormProps, "projectId" | "config" | "onChange">) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const versionId = config.dataset_version_id != null ? Number(config.dataset_version_id) : null;

  useEffect(() => {
    let cancelled = false;
    api<Dataset[]>(`/projects/${projectId}/datasets`)
      .then((rows) => {
        if (!cancelled) setDatasets(rows);
      })
      .catch(() => {
        if (!cancelled) setDatasets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!versionId || !datasets.length) return;
    let cancelled = false;
    (async () => {
      for (const dataset of datasets) {
        try {
          const rows = await api<DatasetVersion[]>(
            `/projects/${projectId}/datasets/${dataset.id}/versions`,
          );
          if (cancelled) return;
          if (rows.some((row) => row.id === versionId)) {
            setDatasetId(dataset.id);
            setVersions(rows);
            return;
          }
        } catch {
          /* continue */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [datasets, projectId, versionId]);

  useEffect(() => {
    if (!datasetId) {
      if (!versionId) setVersions([]);
      return;
    }
    let cancelled = false;
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${datasetId}/versions`)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, projectId, versionId]);

  return (
    <div className="node-config-form" data-testid="node-config-batch-prediction">
      <label>
        Dataset
        <select
          data-testid="node-config-batch-dataset"
          value={datasetId ?? ""}
          onChange={(event) => {
            const nextId = event.target.value ? Number(event.target.value) : null;
            setDatasetId(nextId);
            onChange({ ...config, dataset_version_id: null });
          }}
        >
          <option value="">Select dataset…</option>
          {datasets.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Dataset version
        <select
          data-testid="node-config-batch-version"
          value={versionId ?? ""}
          disabled={!datasetId}
          onChange={(event) => {
            onChange({
              ...config,
              dataset_version_id: event.target.value ? Number(event.target.value) : null,
            });
          }}
        >
          <option value="">Select version…</option>
          {versions.map((row) => (
            <option key={row.id} value={row.id}>
              v{row.version} · {row.original_filename}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target column
        <input
          data-testid="node-config-batch-target"
          value={asString(config.target_column)}
          onChange={(event) => onChange({ ...config, target_column: event.target.value })}
        />
      </label>
      <label>
        Prediction column
        <input
          data-testid="node-config-prediction-column"
          value={asString(config.prediction_column, "prediction")}
          onChange={(event) => onChange({ ...config, prediction_column: event.target.value })}
        />
      </label>
    </div>
  );
}

function NotificationForm({
  config,
  onChange,
}: Pick<NodeConfigFormProps, "config" | "onChange">) {
  return (
    <div className="node-config-form" data-testid="node-config-notification">
      <label>
        Alert type
        <input
          data-testid="node-config-alert-type"
          value={asString(config.alert_type, "pipeline")}
          onChange={(event) => onChange({ ...config, alert_type: event.target.value })}
        />
      </label>
      <label>
        Severity
        <select
          data-testid="node-config-severity"
          value={asString(config.severity, "info")}
          onChange={(event) => onChange({ ...config, severity: event.target.value })}
        >
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
          <option value="critical">critical</option>
        </select>
      </label>
      <label>
        Title
        <input
          data-testid="node-config-alert-title"
          value={asString(config.title)}
          onChange={(event) => onChange({ ...config, title: event.target.value })}
        />
      </label>
      <label>
        Message
        <textarea
          data-testid="node-config-alert-message"
          value={asString(config.message)}
          onChange={(event) => onChange({ ...config, message: event.target.value })}
        />
      </label>
    </div>
  );
}

export function NodeConfigForm({
  projectId,
  nodeType,
  config,
  onChange,
  upstreamDatasetId,
  datasetColumns,
  formError,
}: NodeConfigFormProps) {
  let body: ReactNode;
  switch (nodeType) {
    case "dataset_load":
      body = <DatasetLoadForm projectId={projectId} config={config} onChange={onChange} />;
      break;
    case "quality_check":
      body = (
        <QualityCheckForm
          projectId={projectId}
          config={config}
          onChange={onChange}
          upstreamDatasetId={upstreamDatasetId}
        />
      );
      break;
    case "split":
      body = (
        <SplitForm config={config} onChange={onChange} datasetColumns={datasetColumns} />
      );
      break;
    case "training":
      body = (
        <TrainingForm
          projectId={projectId}
          config={config}
          onChange={onChange}
          datasetColumns={datasetColumns}
        />
      );
      break;
    case "evaluation":
      body = <EvaluationForm config={config} onChange={onChange} />;
      break;
    case "condition":
      body = <ConditionForm config={config} onChange={onChange} />;
      break;
    case "model_registration":
      body = (
        <div className="node-config-form" data-testid="node-config-model-registration">
          <label>
            Model name
            <input
              data-testid="node-config-model-name"
              value={asString(config.model_name, "classifier")}
              onChange={(event) => onChange({ ...config, model_name: event.target.value })}
            />
          </label>
        </div>
      );
      break;
    case "approval_request":
      body = <ApprovalRequestForm projectId={projectId} config={config} onChange={onChange} />;
      break;
    case "endpoint_deployment":
      body = (
        <div className="node-config-form" data-testid="node-config-endpoint">
          <label>
            Endpoint name
            <input
              data-testid="node-config-endpoint-name"
              value={asString(config.name, "endpoint")}
              onChange={(event) => onChange({ ...config, name: event.target.value })}
            />
          </label>
        </div>
      );
      break;
    case "batch_prediction":
      body = <BatchPredictionForm projectId={projectId} config={config} onChange={onChange} />;
      break;
    case "notification":
      body = <NotificationForm config={config} onChange={onChange} />;
      break;
    case "preprocessing":
      body = (
        <div className="node-config-form" data-testid="node-config-preprocessing">
          <p className="form-hint">
            Preprocessing uses advanced JSON only. Configure transforms in the Advanced JSON panel.
          </p>
        </div>
      );
      break;
    default:
      body = (
        <p className="form-hint">No typed form for this step. Use Advanced JSON.</p>
      );
  }

  return (
    <div className="node-config-root">
      {body}
      {formError && <p className="error">{formError}</p>}
    </div>
  );
}
