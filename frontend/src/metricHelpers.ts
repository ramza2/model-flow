const PER_TARGET_METRIC_PATTERN = /^(val_|test_)?target_(\d+)_(.+)$/;

const REGRESSION_PRIMARY_METRICS = [
  "val_rmse",
  "rmse",
  "val_r2",
  "r2",
  "val_mae",
  "mae",
] as const;

const CLASSIFICATION_PRIMARY_METRICS = [
  "val_accuracy",
  "accuracy",
  "val_f1_weighted",
  "f1_weighted",
  "val_precision_weighted",
  "precision_weighted",
  "val_recall_weighted",
  "recall_weighted",
] as const;

export function formatMetricLabel(metricKey: string, targetColumns: string[] = []): string {
  const match = metricKey.match(PER_TARGET_METRIC_PATTERN);
  if (match) {
    const [, prefix = "", indexText, metricName] = match;
    const targetName = targetColumns[Number(indexText)] ?? `target ${indexText}`;
    const parts = [
      prefix ? prefix.replace(/_$/, "") : "",
      targetName.replaceAll("_", " "),
      metricName.replaceAll("_", " "),
    ].filter(Boolean);
    return parts.join(" ");
  }
  return metricKey.replaceAll("_", " ");
}

function hasPerTargetMetrics(metrics: Record<string, number>): boolean {
  return Object.keys(metrics).some((key) => PER_TARGET_METRIC_PATTERN.test(key));
}

function inferProblemType(metrics: Record<string, number>, problemType?: string): "classification" | "regression" {
  if (problemType === "classification" || problemType === "regression") {
    return problemType;
  }
  if (REGRESSION_PRIMARY_METRICS.some((key) => key in metrics)) {
    return "regression";
  }
  if (CLASSIFICATION_PRIMARY_METRICS.some((key) => key in metrics)) {
    return "classification";
  }
  return "regression";
}

export function selectPrimaryMetric(
  metrics: Record<string, number>,
  options: { problemType?: string; preferAggregate?: boolean } = {},
): { key: string; value: number } | null {
  const entries = Object.entries(metrics);
  if (entries.length === 0) {
    return null;
  }

  const preferAggregate = options.preferAggregate ?? hasPerTargetMetrics(metrics);
  const problemType = inferProblemType(metrics, options.problemType);
  const preferences = problemType === "classification"
    ? CLASSIFICATION_PRIMARY_METRICS
    : REGRESSION_PRIMARY_METRICS;

  for (const key of preferences) {
    if (key in metrics) {
      return { key, value: metrics[key] };
    }
  }

  if (preferAggregate) {
    const aggregate = entries.find(([key]) => !PER_TARGET_METRIC_PATTERN.test(key));
    if (aggregate) {
      return { key: aggregate[0], value: aggregate[1] };
    }
  }

  const [key, value] = entries[0];
  return { key, value };
}

export function formatPrimaryMetric(
  metrics: Record<string, number>,
  options: { problemType?: string; targetColumns?: string[] } = {},
): string {
  const selected = selectPrimaryMetric(metrics, {
    problemType: options.problemType,
    preferAggregate: true,
  });
  if (!selected) {
    return "—";
  }
  const label = formatMetricLabel(selected.key, options.targetColumns ?? []);
  return `${label}: ${Number(selected.value).toFixed(3)}`;
}
