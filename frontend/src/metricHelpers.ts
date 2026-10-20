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

/**
 * Display-only problem type for Job Detail / Register Model.
 * Does not mutate stored job.problem_type. Keeps "auto" when metrics cannot decide.
 */
export function resolveDisplayProblemType(
  problemType: string | null | undefined,
  metrics: Record<string, number> | null | undefined,
): string {
  const normalized = String(problemType ?? "").trim().toLowerCase();
  if (normalized === "classification" || normalized === "regression") {
    return normalized;
  }
  if (normalized !== "auto") {
    return problemType ? String(problemType) : "auto";
  }
  const metricMap = metrics ?? {};
  if (REGRESSION_PRIMARY_METRICS.some((key) => key in metricMap)) {
    return "regression";
  }
  if (CLASSIFICATION_PRIMARY_METRICS.some((key) => key in metricMap)) {
    return "classification";
  }
  return "auto";
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

const METRIC_FAMILY_HELP: Record<string, string> = {
  rmse: "제곱 오차의 평균에 제곱근을 적용한 지표입니다. 큰 오차에 더 민감하며, 값이 낮을수록 좋습니다.",
  mae: "실제값과 예측값의 차이를 절댓값으로 계산한 평균입니다. 값이 낮을수록 좋습니다.",
  r2: "모델이 데이터 변동을 얼마나 설명하는지 나타내는 지표입니다. 1에 가까울수록 좋으며, 0보다 작을 수도 있습니다.",
  accuracy: "전체 예측 중 정답인 비율입니다. 값이 높을수록 좋습니다.",
  precision: "양성이라고 예측한 항목 중 실제 양성인 비율입니다. 값이 높을수록 좋습니다.",
  recall: "실제 양성 항목 중 모델이 찾아낸 비율입니다. 값이 높을수록 좋습니다.",
  f1: "Precision과 Recall의 조화평균입니다. 값이 높을수록 좋습니다.",
};

const UNKNOWN_METRIC_HELP =
  "이 학습 결과에서 기록된 평가 지표입니다. 지표의 의미는 사용 중인 알고리즘과 문제 유형에 따라 달라질 수 있습니다.";

const WEIGHTED_HELP =
  "클래스별 지표를 각 클래스의 표본 수에 따라 가중 평균합니다.";

/**
 * Display-only beginner help for a metric key. Does not rename keys or invent
 * higher/lower guidance for unrecognized metric families.
 */
export function metricHelpText(metricKey: string): string {
  const key = String(metricKey || "").trim().toLowerCase();
  if (!key) return UNKNOWN_METRIC_HELP;

  let rest = key;
  let splitPrefix = "";
  if (rest.startsWith("val_")) {
    splitPrefix = "검증 데이터 기준입니다. ";
    rest = rest.slice(4);
  } else if (rest.startsWith("test_")) {
    splitPrefix = "테스트 데이터 기준입니다. ";
    rest = rest.slice(5);
  }

  const perTarget = rest.match(/^target_\d+_(.+)$/);
  if (perTarget) {
    rest = perTarget[1];
  }

  const weighted = rest.endsWith("_weighted");
  const family = weighted ? rest.slice(0, -"_weighted".length) : rest;
  const familyHelp = METRIC_FAMILY_HELP[family];
  if (!familyHelp) {
    return UNKNOWN_METRIC_HELP;
  }

  const weightedNote = weighted ? ` ${WEIGHTED_HELP}` : "";
  return `${splitPrefix}${familyHelp}${weightedNote}`;
}
