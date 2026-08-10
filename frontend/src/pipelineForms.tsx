import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Dataset, type DatasetVersion, type QualityRule } from "./api";
import { validateSplitRatios } from "./pipelineHelpers";
import {
  algorithmsForProblemType,
  defaultAlgorithmId,
  formatHyperparameters,
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

  useEffect(() => {
    if (!upstreamDatasetId) {
      setRules([]);
      setHint("Connect a Dataset Load step upstream to choose dataset rules.");
      return;
    }
    let cancelled = false;
    setHint("");
    api<QualityRule[]>(
      `/projects/${projectId}/quality-rules?dataset_id=${upstreamDatasetId}&include_inactive=false&include_unassigned=false`,
    )
      .then((rows) => {
        if (!cancelled) setRules(rows.filter((row) => row.dataset_id != null && row.is_active));
      })
      .catch((reason) => {
        if (!cancelled) {
          setRules([]);
          setHint(reason instanceof Error ? reason.message : "Quality rules could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, upstreamDatasetId]);

  return (
    <div className="node-config-form" data-testid="node-config-quality-check">
      {hint && <p className="form-hint">{hint}</p>}
      <label>
        Quality rule
        <select
          data-testid="node-config-quality-rule"
          value={config.quality_rule_id != null ? String(config.quality_rule_id) : ""}
          disabled={!upstreamDatasetId}
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
}: Pick<NodeConfigFormProps, "config" | "onChange">) {
  const train = asNumber(config.train_ratio, 0.7);
  const val = asNumber(config.val_ratio, 0.15);
  const test = asNumber(config.test_ratio, 0.15);
  const seed = asNumber(config.random_seed, 42);
  const localError = validateSplitRatios(train, val, test, seed);

  function patch(partial: Record<string, unknown>) {
    onChange({ ...config, ...partial });
  }

  return (
    <div className="node-config-form" data-testid="node-config-split">
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
  const problemType = asString(config.problem_type, "auto");
  const algorithm = asString(config.algorithm, "random_forest");
  const target = asString(config.target_column, "target");
  const features = Array.isArray(config.feature_columns)
    ? (config.feature_columns as string[])
    : [];
  const visibleAlgorithms = useMemo(
    () => algorithmsForProblemType(catalog, problemType),
    [catalog, problemType],
  );
  const selectedAlgorithm = catalog.find((item) => item.id === algorithm);
  const featureChoices = datasetColumns.filter((column) => column !== target);

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

  function setProblem(next: string) {
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

  return (
    <div className="node-config-form" data-testid="node-config-training">
      <label>
        Target column
        {datasetColumns.length > 0 ? (
          <select
            data-testid="node-config-target"
            value={target}
            onChange={(event) => {
              const nextTarget = event.target.value;
              onChange({
                ...config,
                target_column: nextTarget,
                feature_columns: features.filter((column) => column !== nextTarget),
              });
            }}
          >
            {datasetColumns.map((column) => (
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
          onChange={(event) => setProblem(event.target.value)}
        >
          <option value="auto">Auto</option>
          <option value="classification">Classification</option>
          <option value="regression">Regression</option>
        </select>
      </label>
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
  const left = asString(config.left ?? config.metric, "accuracy");
  const operator = asString(config.operator, ">=");
  const right = config.right ?? config.value ?? 0.8;
  return (
    <div className="node-config-form" data-testid="node-config-condition">
      <label>
        Left / metric
        <input
          data-testid="node-config-left"
          value={left}
          onChange={(event) => onChange({ ...config, left: event.target.value, metric: event.target.value })}
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
        Right
        <input
          data-testid="node-config-right"
          value={String(right)}
          onChange={(event) => {
            const raw = event.target.value;
            const asNum = Number(raw);
            onChange({
              ...config,
              right: raw === "" || Number.isNaN(asNum) ? raw : asNum,
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
      body = <SplitForm config={config} onChange={onChange} />;
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
