/** Shared helpers for Pipeline Builder UX (forms, canvas summaries, warnings). */

export const PIPELINE_NODE_TYPES = [
  "dataset_load",
  "quality_check",
  "split",
  "preprocessing",
  "training",
  "evaluation",
  "condition",
  "model_registration",
  "approval_request",
  "endpoint_deployment",
  "batch_prediction",
  "notification",
] as const;

export type PipelineNodeType = (typeof PIPELINE_NODE_TYPES)[number];

export type PipelineLifecycleStageId =
  | "source_transform"
  | "quality"
  | "train"
  | "registry"
  | "deploy"
  | "predict"
  | "monitor";

export const PIPELINE_LIFECYCLE_STAGES: {
  id: PipelineLifecycleStageId;
  label: string;
  description: string;
  nodeTypes: PipelineNodeType[];
}[] = [
  {
    id: "source_transform",
    label: "Source & Transform",
    description: "Load an exact DatasetVersion and prepare it for downstream model work.",
    nodeTypes: ["dataset_load", "preprocessing", "split"],
  },
  {
    id: "quality",
    label: "Quality",
    description: "Evaluate data quality before model execution.",
    nodeTypes: ["quality_check"],
  },
  {
    id: "train",
    label: "Train",
    description: "Train and evaluate model results.",
    nodeTypes: ["training", "evaluation"],
  },
  {
    id: "registry",
    label: "Registry & Governance",
    description: "Branch on gates, register model versions, and request approval.",
    nodeTypes: ["condition", "model_registration", "approval_request"],
  },
  {
    id: "deploy",
    label: "Deploy",
    description: "Publish an approved model to an online endpoint.",
    nodeTypes: ["endpoint_deployment"],
  },
  {
    id: "predict",
    label: "Predict",
    description: "Run batch prediction from a model and exact dataset version.",
    nodeTypes: ["batch_prediction"],
  },
  {
    id: "monitor",
    label: "Monitor",
    description: "Surface lifecycle and operational outcomes as notifications or alerts.",
    nodeTypes: ["notification"],
  },
];

export function lifecycleStageForNodeType(
  nodeType: string,
): (typeof PIPELINE_LIFECYCLE_STAGES)[number] | null {
  return (
    PIPELINE_LIFECYCLE_STAGES.find((stage) =>
      stage.nodeTypes.includes(nodeType as PipelineNodeType),
    ) || null
  );
}

export function lifecycleCoverage(nodeTypes: Iterable<string>): Record<PipelineLifecycleStageId, number> {
  const coverage = Object.fromEntries(
    PIPELINE_LIFECYCLE_STAGES.map((stage) => [stage.id, 0]),
  ) as Record<PipelineLifecycleStageId, number>;
  for (const nodeType of nodeTypes) {
    const stage = lifecycleStageForNodeType(nodeType);
    if (stage) coverage[stage.id] += 1;
  }
  return coverage;
}

export const PIPELINE_NODE_LIBRARY: {
  category: string;
  items: { type: PipelineNodeType; description: string; icon: string }[];
}[] = [
  {
    category: "1. Source & Transform",
    items: [
      {
        type: "dataset_load",
        description:
          "Load an exact DatasetVersion, including a materialized Dataset Preparation output.",
        icon: "▤",
      },
      {
        type: "preprocessing",
        description: "Transform or preprocess data before training.",
        icon: "⚙",
      },
      { type: "split", description: "Create deterministic train / validation / test splits.", icon: "⧉" },
    ],
  },
  {
    category: "2. Quality",
    items: [{ type: "quality_check", description: "Run dataset quality rules.", icon: "✓" }],
  },
  {
    category: "3. Train",
    items: [
      { type: "training", description: "Train a model estimator.", icon: "▶" },
      { type: "evaluation", description: "Evaluate metrics and gates.", icon: "◉" },
    ],
  },
  {
    category: "4. Registry & Governance",
    items: [
      { type: "condition", description: "Branch on TRUE / FALSE / ALWAYS.", icon: "◇" },
      { type: "model_registration", description: "Register a trained model version.", icon: "◆" },
      { type: "approval_request", description: "Request model approval.", icon: "✎" },
    ],
  },
  {
    category: "5. Deploy",
    items: [
      { type: "endpoint_deployment", description: "Deploy an online endpoint.", icon: "↗" },
    ],
  },
  {
    category: "6. Predict",
    items: [
      { type: "batch_prediction", description: "Run batch inference.", icon: "⇩" },
    ],
  },
  {
    category: "7. Monitor",
    items: [
      {
        type: "notification",
        description: "Surface a lifecycle or operational result as an alert or notification.",
        icon: "⚑",
      },
    ],
  },
];

export type ConditionBranch = "true" | "false" | "always";

export function labelForType(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Display-only Korean node type label. Does not change saved data.label defaults. */
export function pipelineNodeTypeLabel(value: string): string {
  switch (value) {
    case "dataset_load":
      return "데이터셋 불러오기 (Dataset Load)";
    case "preprocessing":
      return "데이터 전처리 (Preprocessing)";
    case "split":
      return "데이터 분할 (Split)";
    case "quality_check":
      return "품질 검사 (Quality Check)";
    case "training":
      return "모델 학습 (Training)";
    case "evaluation":
      return "모델 평가 (Evaluation)";
    case "condition":
      return "조건 분기 (Condition)";
    case "model_registration":
      return "모델 등록 (Model Registration)";
    case "approval_request":
      return "승인 요청 (Approval Request)";
    case "endpoint_deployment":
      return "엔드포인트 배포 (Endpoint Deployment)";
    case "batch_prediction":
      return "일괄 예측 (Batch Prediction)";
    case "notification":
      return "알림 (Notification)";
    default:
      return labelForType(value);
  }
}

/** Display-only Korean library category. Raw PIPELINE_NODE_LIBRARY.category stays English. */
export function pipelineNodeLibraryCategoryLabel(category: string): string {
  switch (category) {
    case "1. Source & Transform":
      return "1. 데이터 입력·변환";
    case "2. Quality":
      return "2. 데이터 품질";
    case "3. Train":
      return "3. 모델 학습·평가";
    case "4. Registry & Governance":
      return "4. 모델 등록·승인";
    case "5. Deploy":
      return "5. 모델 배포";
    case "6. Predict":
      return "6. 예측 실행";
    case "7. Monitor":
      return "7. 모니터링";
    default:
      return category;
  }
}

/** Display-only Korean node description for library tooltips. */
export function pipelineNodeTypeDescription(value: string): string {
  switch (value) {
    case "dataset_load":
      return "정확한 데이터 버전(DatasetVersion)을 불러옵니다. 데이터 가공 결과 버전도 선택할 수 있습니다.";
    case "preprocessing":
      return "학습 전에 데이터를 변환하거나 전처리합니다.";
    case "split":
      return "학습·검증·테스트 데이터 비율을 정해 분할합니다.";
    case "quality_check":
      return "데이터셋 품질 규칙을 실행해 문제를 확인합니다.";
    case "training":
      return "선택한 알고리즘으로 모델을 학습합니다.";
    case "evaluation":
      return "학습 결과 지표를 확인하고 통과 기준과 비교합니다.";
    case "condition":
      return "TRUE / FALSE / ALWAYS 조건에 따라 다음 단계를 분기합니다.";
    case "model_registration":
      return "학습된 모델을 레지스트리에 등록합니다.";
    case "approval_request":
      return "등록된 모델에 대한 승인을 요청합니다.";
    case "endpoint_deployment":
      return "승인된 모델을 온라인 엔드포인트로 배포합니다.";
    case "batch_prediction":
      return "모델과 데이터 버전으로 일괄 예측을 실행합니다.";
    case "notification":
      return "파이프라인 결과나 운영 상태를 알림으로 남깁니다.";
    default:
      return "";
  }
}

/** Allocate a readable node id that never collides with existing graph ids (reload-safe). */
export function nextPipelineNodeId(nodeType: string, existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  const prefix = `${nodeType}-`;
  let max = 0;
  for (const id of used) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (/^\d+$/.test(rest)) {
      const value = Number(rest);
      if (value > max) max = value;
    }
  }
  let next = max + 1;
  let candidate = `${prefix}${next}`;
  while (used.has(candidate)) {
    next += 1;
    candidate = `${prefix}${next}`;
  }
  return candidate;
}

/** Client-side Node Library filter across category, type, label, and description. */
export function filterNodeLibrary(
  library: typeof PIPELINE_NODE_LIBRARY,
  query: string,
): typeof PIPELINE_NODE_LIBRARY {
  const needle = query.trim().toLowerCase();
  if (!needle) return library;
  return library
    .map((group) => ({
      category: group.category,
      items: group.items.filter((item) => {
        const haystack = [
          group.category,
          pipelineNodeLibraryCategoryLabel(group.category),
          item.type,
          item.description,
          pipelineNodeTypeDescription(item.type),
          labelForType(item.type),
          pipelineNodeTypeLabel(item.type),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      }),
    }))
    .filter((group) => group.items.length > 0);
}

export function edgeBranch(edge: {
  sourceHandle?: string | null;
  branch?: string;
  label?: unknown;
  data?: { branch?: string };
}): ConditionBranch {
  const fromHandle = edge.sourceHandle;
  if (fromHandle === "true" || fromHandle === "false" || fromHandle === "always") {
    return fromHandle;
  }
  const raw = edge.data?.branch || edge.branch || edge.label;
  if (raw === "true" || raw === "false" || raw === "always") {
    return raw;
  }
  return "always";
}

export function defaultConfigFor(type: PipelineNodeType): Record<string, unknown> {
  switch (type) {
    case "split":
      return {
        train_ratio: 0.7,
        val_ratio: 0.15,
        test_ratio: 0.15,
        random_seed: 42,
        split_strategy: "random",
        time_column: null,
      };
    case "training":
      return {
        target_column: "target",
        problem_type: "auto",
        algorithm: "random_forest",
        feature_columns: [],
        hyperparameters: {},
        split_strategy: "random",
        time_column: null,
        training_task: "tabular",
        forecast_strategy: null,
        forecast_horizons: [],
      };
    case "evaluation":
      return { metric: "accuracy", minimum: 0.8, fail_on_gate: true };
    case "condition":
      return { metric: "accuracy", operator: ">=", value: 0.8, fail_on_false: false };
    case "quality_check":
      return { block_on_fail: true };
    case "notification":
      return { alert_type: "pipeline", severity: "info", title: "", message: "" };
    case "model_registration":
      return { model_name: "classifier" };
    case "endpoint_deployment":
      return { name: "endpoint" };
    default:
      return {};
  }
}

export function configSummary(
  nodeType: string,
  config: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  switch (nodeType) {
    case "dataset_load":
      if (config.dataset_id) lines.push(`Dataset #${config.dataset_id}`);
      if (config.dataset_version_id) lines.push(`Version id ${config.dataset_version_id}`);
      if (!lines.length) lines.push("Dataset not selected");
      break;
    case "quality_check":
      if (config.quality_rule_id) lines.push(`Rule #${config.quality_rule_id}`);
      lines.push(config.block_on_fail === false ? "Non-blocking" : "Block on fail");
      break;
    case "split":
      lines.push(
        `${Math.round(Number(config.train_ratio ?? 0.7) * 100)}/${Math.round(Number(config.val_ratio ?? 0.15) * 100)}/${Math.round(Number(config.test_ratio ?? 0.15) * 100)}`,
      );
      if (config.split_strategy === "time") {
        lines.push(
          config.time_column
            ? `time ordered · ${String(config.time_column)}`
            : "time ordered",
        );
      } else {
        lines.push(`seed ${config.random_seed ?? 42}`);
      }
      break;
    case "training": {
      const isForecasting = config.training_task === "forecasting";
      const targets = Array.isArray(config.target_columns)
        ? (config.target_columns as unknown[]).map(String).filter(Boolean)
        : config.target_column
          ? [String(config.target_column)]
          : [];
      if (isForecasting) {
        const horizons = Array.isArray(config.forecast_horizons)
          ? (config.forecast_horizons as unknown[])
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value) && value > 0)
          : [];
        lines.push(
          horizons.length
            ? `Forecasting · ${horizons.map((h) => `t+${h}`).join(", ")}`
            : "Forecasting",
        );
        if (config.algorithm) lines.push(String(config.algorithm).replaceAll("_", " "));
        lines.push(
          config.time_column
            ? `time ordered · ${String(config.time_column)}`
            : "time ordered",
        );
      } else {
        if (targets.length > 1) lines.push(`${targets.length} targets`);
        else if (targets.length === 1) lines.push(`target: ${targets[0]}`);
        if (config.algorithm) lines.push(String(config.algorithm).replaceAll("_", " "));
        if (config.problem_type && config.problem_type !== "auto") {
          lines.push(String(config.problem_type));
        }
        if (config.split_strategy === "time") {
          lines.push(
            config.time_column
              ? `time ordered · ${String(config.time_column)}`
              : "time ordered",
          );
        }
      }
      break;
    }
    case "evaluation":
      lines.push(`${String(config.metric ?? "metric")} ${config.operator === "<=" ? "≤" : "≥"} ${config.minimum ?? config.min ?? "?"}`);
      break;
    case "condition": {
      const left = config.metric ?? config.left ?? "?";
      const op = config.operator ?? ">=";
      const right = config.value ?? config.right ?? "?";
      lines.push(`${left} ${op} ${right}`);
      break;
    }
    case "model_registration":
      lines.push(String(config.model_name || "model name required"));
      break;
    case "approval_request":
      if (config.gate_policy_id) lines.push(`Policy #${config.gate_policy_id}`);
      else lines.push("Default gate policy");
      break;
    case "endpoint_deployment":
      lines.push(String(config.name || "endpoint name required"));
      break;
    case "batch_prediction":
      if (config.dataset_version_id) lines.push(`Version #${config.dataset_version_id}`);
      if (config.prediction_column) lines.push(`→ ${String(config.prediction_column)}`);
      break;
    case "notification":
      lines.push(String(config.severity || "info"));
      if (config.title) lines.push(String(config.title));
      break;
    case "preprocessing":
      lines.push("Advanced config");
      break;
    default:
      break;
  }
  return lines.slice(0, 3);
}

export function nodeConfigWarnings(
  nodeType: string,
  config: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  switch (nodeType) {
    case "dataset_load":
      if (!config.dataset_id) warnings.push("Dataset required");
      if (!config.dataset_version_id) warnings.push("Dataset version required");
      break;
    case "training": {
      const isForecasting = config.training_task === "forecasting";
      const targets = Array.isArray(config.target_columns)
        ? (config.target_columns as unknown[]).map(String).filter(Boolean)
        : typeof config.target_column === "string" && config.target_column.trim() !== ""
          ? [String(config.target_column)]
          : [];
      if (isForecasting) {
        if (targets.length !== 1) warnings.push("Exactly one forecast target required");
        if (config.split_strategy !== "time" || !String(config.time_column || "").trim()) {
          warnings.push("Time column required");
        }
        const horizons = Array.isArray(config.forecast_horizons)
          ? config.forecast_horizons
          : [];
        if (horizons.length === 0) warnings.push("Forecast horizons required");
        if (!config.algorithm) warnings.push("Forecasting algorithm required/supported");
      } else {
        if (targets.length === 0) warnings.push("Target column required");
        if (!config.algorithm) warnings.push("Algorithm required");
      }
      if (!Array.isArray(config.feature_columns) || config.feature_columns.length === 0) {
        warnings.push("Select at least one feature");
      }
      break;
    }
    case "split": {
      const train = Number(config.train_ratio);
      const val = Number(config.val_ratio);
      const test = Number(config.test_ratio);
      if (!(train > 0 && train < 1 && val > 0 && val < 1 && test > 0 && test < 1)) {
        warnings.push("Each ratio must be between 0 and 1");
      } else if (Math.abs(train + val + test - 1) > 1e-6) {
        warnings.push("Ratios must sum to 1.0");
      }
      if (!Number.isInteger(Number(config.random_seed))) {
        warnings.push("Seed must be an integer");
      }
      if (config.split_strategy === "time" && !String(config.time_column || "").trim()) {
        warnings.push("Time column required");
      }
      break;
    }
    case "evaluation":
      if (!config.metric) warnings.push("Metric required");
      if (config.minimum === undefined && config.min === undefined) {
        warnings.push("Threshold required");
      }
      if (config.operator && config.operator !== ">=" && config.operator !== "<=") {
        warnings.push("Evaluation operator must be >= or <=");
      }
      break;
    case "condition":
      if (config.left === undefined && config.metric === undefined) {
        warnings.push("Left value / metric required");
      }
      if (config.value === undefined && config.right === undefined) {
        warnings.push("Value / right required");
      }
      if (!config.operator) warnings.push("Operator required");
      break;
    case "model_registration":
      if (!config.model_name) warnings.push("Model name required");
      break;
    case "endpoint_deployment":
      if (!config.name) warnings.push("Endpoint name required");
      break;
    default:
      break;
  }
  return warnings;
}

export function parseValidationIssue(error: string, nodeIds: string[]): {
  message: string;
  nodeId: string | null;
} {
  for (const id of nodeIds) {
    if (error.includes(`'${id}'`) || error.includes(`"${id}"`) || error.includes(id)) {
      return { message: error, nodeId: id };
    }
  }
  return { message: error, nodeId: null };
}

export function validateSplitRatios(
  train: number,
  val: number,
  test: number,
  seed: number,
): string | null {
  if (![train, val, test].every((value) => Number.isFinite(value))) {
    return "Enter numeric train, validation, and test ratios.";
  }
  if (!(train > 0 && train < 1 && val > 0 && val < 1 && test > 0 && test < 1)) {
    return "Each ratio must be greater than 0 and less than 1.";
  }
  if (Math.abs(train + val + test - 1) > 1e-6) {
    return "Train + validation + test ratios must equal 1.0.";
  }
  if (!Number.isInteger(seed)) {
    return "Random seed must be an integer.";
  }
  return null;
}
