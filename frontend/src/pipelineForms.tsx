import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Dataset, type DatasetVersion, type QualityRule } from "./api";
import { HelpTip, TermLabel } from "./components";
import { validateSplitRatios } from "./pipelineHelpers";
import {
  algorithmsForTrainingTask,
  defaultAlgorithmId,
  formatHyperparameters,
  parseForecastHorizonsText,
  validateHyperparametersText,
  type AlgorithmSpec,
} from "./trainingConfig";
import { UI_HELP } from "./uiTerminology";

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
      <p className="form-hint" data-testid="node-config-dataset-load-hint">
        학습이나 후속 처리에 사용할 데이터셋을 선택합니다.
        <HelpTip text={UI_HELP.pipelineDatasetLoad} />
      </p>
      <label>
        <TermLabel ko="데이터셋" en="Dataset" help={UI_HELP.pipelineDatasetLoad} />
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
          <option value="">데이터셋 선택…</option>
          {datasets.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <TermLabel ko="데이터 버전" en="Dataset version" help={UI_HELP.datasetVersionPin} />
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
          <option value="">버전 선택…</option>
          {versions.map((row) => (
            <option key={row.id} value={row.id}>
              v{row.version} · {row.original_filename}
            </option>
          ))}
        </select>
        <small>
          특정 데이터 버전을 선택하면 그 버전의 내용을 사용합니다. 이후 새 버전이 생기더라도
          자동으로 최신 버전으로 변경하지 않습니다.
        </small>
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
      <p className="form-hint" data-testid="node-config-split-hint">
        학습 0.7 / 검증 0.15 / 테스트 0.15처럼 합계가 1.0이 되도록 입력하세요. 0.7은 전체 데이터의
        70%를 의미합니다.
        <HelpTip text={UI_HELP.pipelineSplit} />
      </p>
      <label>
        <TermLabel ko="분할 방식" en="Split strategy" help={UI_HELP.pipelineSplit} />
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
          <option value="random">무작위 (Random)</option>
          <option value="time">시간 순서 (Time ordered)</option>
        </select>
      </label>
      {splitStrategy === "time" ? (
        <>
          <label>
            <TermLabel ko="정렬 기준 시간 컬럼" en="Time column" />
            <select
              data-testid="node-config-time-column"
              value={timeColumn}
              onChange={(event) =>
                patch({ split_strategy: "time", time_column: event.target.value || null })
              }
            >
              <option value="">시간 컬럼 선택…</option>
              {datasetColumns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
          </label>
          <p className="form-hint" data-testid="node-config-split-time-help">
            시간 컬럼 기준으로 정렬한 뒤 과거 데이터를 학습에, 이후 데이터를 검증·테스트에
            사용합니다.
          </p>
        </>
      ) : null}
      <label>
        <TermLabel ko="학습 데이터 비율" en="Train ratio" />
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
        <TermLabel ko="검증 데이터 비율" en="Validation ratio" />
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
        <TermLabel ko="테스트 데이터 비율" en="Test ratio" />
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
        <TermLabel ko="난수 시드" en="Random seed" />
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
          난수 시드는 시간순 분할에서 데이터를 섞지 않습니다.
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
      <p className="form-hint" data-testid="node-config-training-hint">
        예측 목표 컬럼은 모델이 맞혀야 하는 정답이고, 입력 특성은 예측에 쓸 입력입니다.
        <HelpTip text={UI_HELP.pipelineTraining} />
      </p>
      <label>
        <TermLabel ko="학습 유형" en="Training task" help={UI_HELP.trainingTask} />
        <select
          data-testid="node-config-training-task"
          value={trainingTask}
          onChange={(event) =>
            setTrainingTask(event.target.value === "forecasting" ? "forecasting" : "tabular")
          }
        >
          <option value="tabular">표 형식 데이터 (Tabular)</option>
          <option value="forecasting">시계열 예측 (Forecasting)</option>
        </select>
      </label>
      {isForecasting ? (
        <p className="form-hint" data-testid="node-config-forecast-help">
          과거 목표값 맥락이 필요하면 데이터 가공의 이전값(Lag)·이동창(Rolling) 특성을 사용하세요.
        </p>
      ) : null}
      <label>
        <TermLabel
          ko="예측 목표 컬럼"
          en={isForecasting ? "Forecast target" : "Target column"}
          help={UI_HELP.target}
        />
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
              <option value="">예측 목표 컬럼 선택…</option>
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
        <small>예: 열수요량 HTDND_AMNT</small>
      </label>
      <label>
        <TermLabel ko="예측 문제 유형" en="Problem type" help={UI_HELP.problemType} />
        <select
          data-testid="node-config-problem-type"
          value={problemType}
          disabled={isForecasting}
          onChange={(event) => setProblem(event.target.value)}
        >
          <option value="auto" disabled={isForecasting}>
            자동 판별 (Auto)
          </option>
          <option value="classification" disabled={isForecasting}>
            분류 (Classification)
          </option>
          <option value="regression">수치 예측·회귀 (Regression)</option>
        </select>
      </label>
      {isForecasting ? (
        <div data-testid="node-config-forecast-fields">
          <label>
            <TermLabel ko="예측 방식" en="Forecast strategy" />
            <input value="Direct multi-output" disabled data-testid="node-config-forecast-strategy" />
          </label>
          <label>
            <TermLabel
              ko="미래 예측 지점"
              en="Forecast horizons"
              help={UI_HELP.forecastHorizons}
            />
            <input
              data-testid="node-config-forecast-horizons"
              value={horizonsText}
              onChange={(event) => applyHorizons(event.target.value)}
              placeholder="1, 2, 3"
            />
          </label>
          <p className="form-hint" data-testid="node-config-forecast-horizons-help">
            1, 2, 3은 미래 1·2·3번째 관측값을 의미합니다. 시·분 같은 시간 단위가 아닙니다. 시간당
            1행이고 누락이 없을 때만 관측 간격이 시간과 같아질 수 있습니다.
          </p>
          {horizonError ? (
            <p className="error" data-testid="node-config-forecast-horizon-error">
              {horizonError}
            </p>
          ) : null}
        </div>
      ) : null}
      <label>
        <TermLabel ko="학습 알고리즘" en="Algorithm" help={UI_HELP.algorithm} />
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
          <legend>
            <TermLabel ko="입력 특성 컬럼" en="Features" help={UI_HELP.features} />
          </legend>
          <p className="form-hint">
            실제 예측 시점에 알 수 없는 미래 정보는 입력에 포함하지 마세요.
          </p>
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
        <TermLabel ko="데이터 분할 방식" en="Split strategy" help={UI_HELP.dataSplit} />
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
          <option value="random" disabled={isForecasting}>
            무작위 (Random)
          </option>
          <option value="time">시간 순서 (Time ordered)</option>
        </select>
        <small>
          Split 노드와 함께 쓰는 경우 Training의 분할 설정이 상위 Split과 일치하는지 확인하세요.
          자동으로 동기화되지 않습니다.
        </small>
      </label>
      {splitStrategy === "time" ? (
        <label>
          <TermLabel ko="시간 컬럼" en="Time column" help={UI_HELP.timeOrderedSplit} />
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
            <option value="">시간 컬럼 선택…</option>
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
        <TermLabel ko="학습 세부 설정" en="Hyperparameters" help={UI_HELP.hyperparameters} />
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
      <p className="form-hint" data-testid="node-config-evaluation-hint">
        현재 평가 기준은 측정값이 최소값 이상(&gt;=)일 때 통과합니다. Accuracy나 R²처럼 값이
        높을수록 좋은 지표에 적합합니다.
        <HelpTip text={UI_HELP.pipelineEvaluation} />
      </p>
      <p className="form-hint" data-testid="node-config-evaluation-rmse-hint">
        RMSE나 MAE는 낮을수록 좋으므로 현재 최소 기준 비교를 그대로 적용하면 의도한 평가가 되지
        않을 수 있습니다.
      </p>
      <label>
        <TermLabel ko="평가 지표" en="Metric" help={UI_HELP.pipelineEvaluation} />
        <input
          data-testid="node-config-metric"
          value={asString(config.metric, "accuracy")}
          onChange={(event) => onChange({ ...config, metric: event.target.value })}
          placeholder="예: accuracy"
        />
        <small>없는 지표명을 입력하면 평가가 실패할 수 있습니다.</small>
      </label>
      <label>
        <TermLabel ko="최소 통과 기준값" en="Minimum" />
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
        <TermLabel
          ko="기준 미달 시 실행 실패 처리"
          en="Fail on gate"
          help={UI_HELP.pipelineEvaluationGate}
        />
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
