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

export const PIPELINE_NODE_LIBRARY: {
  category: string;
  items: { type: PipelineNodeType; description: string; icon: string }[];
}[] = [
  {
    category: "Data",
    items: [
      { type: "dataset_load", description: "Load a dataset version into the graph.", icon: "▤" },
      { type: "quality_check", description: "Run dataset quality rules.", icon: "✓" },
      { type: "split", description: "Train / validation / test split.", icon: "⧉" },
      { type: "preprocessing", description: "Advanced preprocessing step.", icon: "⚙" },
    ],
  },
  {
    category: "Train",
    items: [
      { type: "training", description: "Train a model estimator.", icon: "▶" },
      { type: "evaluation", description: "Evaluate metrics and gates.", icon: "◉" },
    ],
  },
  {
    category: "Logic",
    items: [
      { type: "condition", description: "Branch on TRUE / FALSE / ALWAYS.", icon: "◇" },
    ],
  },
  {
    category: "Model Lifecycle",
    items: [
      { type: "model_registration", description: "Register a trained model.", icon: "◆" },
      { type: "approval_request", description: "Request model approval.", icon: "✎" },
    ],
  },
  {
    category: "Serving",
    items: [
      { type: "endpoint_deployment", description: "Deploy an online endpoint.", icon: "↗" },
      { type: "batch_prediction", description: "Run batch inference.", icon: "⇩" },
    ],
  },
  {
    category: "Operations",
    items: [
      { type: "notification", description: "Send an alert or notification.", icon: "⚑" },
    ],
  },
];

export type ConditionBranch = "true" | "false" | "always";

export function labelForType(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
      return { train_ratio: 0.7, val_ratio: 0.15, test_ratio: 0.15, random_seed: 42 };
    case "training":
      return {
        target_column: "target",
        problem_type: "auto",
        algorithm: "random_forest",
        feature_columns: [],
        hyperparameters: {},
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
      lines.push(`seed ${config.random_seed ?? 42}`);
      break;
    case "training": {
      const targets = Array.isArray(config.target_columns)
        ? (config.target_columns as unknown[]).map(String).filter(Boolean)
        : config.target_column
          ? [String(config.target_column)]
          : [];
      if (targets.length > 1) lines.push(`${targets.length} targets`);
      else if (targets.length === 1) lines.push(`target: ${targets[0]}`);
      if (config.algorithm) lines.push(String(config.algorithm).replaceAll("_", " "));
      if (config.problem_type && config.problem_type !== "auto") {
        lines.push(String(config.problem_type));
      }
      break;
    }
    case "evaluation":
      lines.push(`${String(config.metric ?? "metric")} ≥ ${config.minimum ?? config.min ?? "?"}`);
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
      const hasTargets =
        (typeof config.target_column === "string" && config.target_column.trim() !== "")
        || (Array.isArray(config.target_columns) && config.target_columns.length > 0);
      if (!hasTargets) warnings.push("Target column required");
      if (!config.algorithm) warnings.push("Algorithm required");
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
      break;
    }
    case "evaluation":
      if (!config.metric) warnings.push("Metric required");
      if (config.minimum === undefined && config.min === undefined) {
        warnings.push("Minimum value required");
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
