import { formatMetricLabel, selectPrimaryMetric } from "./metricHelpers";

/** Screen-only Korean copy. Persisted lifecycle values and metric keys stay unchanged. */
const LIFECYCLE_KO: Record<string, string> = {
  CANDIDATE: "후보 모델",
  VALIDATING: "검증 중",
  PENDING_APPROVAL: "승인 대기",
  APPROVED: "승인 완료",
  PRODUCTION: "운영 중",
  REJECTED: "반려됨",
  ARCHIVED: "보관됨",
};

export function modelLifecycleLabelKo(value: string | null | undefined): string {
  if (!value) return "알 수 없음";
  return LIFECYCLE_KO[value.toUpperCase()] ?? value.replaceAll("_", " ");
}

export function modelGateStatusKo(passed: boolean): string {
  return passed ? "통과" : "확인 필요";
}

export function modelProblemTypeKo(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const labels: Record<string, string> = {
    regression: "회귀(수치 예측)",
    classification: "분류",
    forecasting: "시계열 예측",
    auto: "자동 판별",
  };
  return labels[value.toLowerCase()] ?? value.replaceAll("_", " ");
}

const METRICS_KO: Record<string, string> = {
  rmse: "RMSE",
  mae: "MAE",
  r2: "R²",
  accuracy: "정확도",
  f1: "F1 점수",
  f1_weighted: "가중 F1 점수",
  precision: "정밀도",
  recall: "재현율",
};

/** Parse a forecasting target name without changing the stored column. */
export function parseModelForecastTargetKo(target: string): { step: number; targetName: string } | undefined {
  const match = target.match(/^(.+?)_+t_plus_(\d+)$/i);
  if (!match) return undefined;
  const step = Number(match[2]);
  if (!Number.isSafeInteger(step) || step < 1) return undefined;
  return { step, targetName: match[1] };
}

export function modelMetricDisplayKo(key: string, targetColumns: string[] = []): {
  scope: string;
  target: string;
  metric: string;
  forecast?: { step: number; targetName: string };
} {
  let rest = key;
  let scope = "";
  if (rest.startsWith("val_")) {
    scope = "검증";
    rest = rest.slice(4);
  } else if (rest.startsWith("test_")) {
    scope = "테스트";
    rest = rest.slice(5);
  }

  let target = "";
  const perTarget = rest.match(/^target_(\d+)_(.+)$/);
  if (perTarget) {
    target = targetColumns[Number(perTarget[1])] ?? `대상 ${perTarget[1]}`;
    rest = perTarget[2];
  }

  const future = rest.match(/^(.+)_t_plus_(\d+)_(rmse|mae|r2)$/i);
  if (future) {
    target = `${future[1]}_t_plus_${future[2]}`;
    rest = future[3];
  }
  // Indexed metrics (val_target_0_rmse) store their horizon in target_columns.
  const forecast = parseModelForecastTargetKo(target);
  if (forecast) {
    target = `${forecast.targetName} (${forecast.step}단계 후)`;
  }

  const metric = METRICS_KO[rest.toLowerCase()] ?? formatMetricLabel(rest);
  return { scope, target, metric, ...(forecast ? { forecast } : {}) };
}

export function formatModelMetricLabelKo(key: string, targetColumns: string[] = []): string {
  const { scope, target, metric } = modelMetricDisplayKo(key, targetColumns);
  return [scope, target, metric].filter(Boolean).join(" · ");
}

export function formatModelPrimaryMetricKo(
  metrics: Record<string, number>,
  options: { problemType?: string; targetColumns?: string[] } = {},
): string {
  const metric = selectPrimaryMetric(metrics, { problemType: options.problemType, preferAggregate: true });
  if (!metric) return "—";
  return `${formatModelMetricLabelKo(metric.key, options.targetColumns)}: ${Number(metric.value).toFixed(3)}`;
}

export const GATE_LABELS_KO: Record<string, { name: string; help: string }> = {
  mlflow_project: { name: "실험 프로젝트 일치", help: "모델 학습 기록이 현재 프로젝트에 속하는지 확인합니다." },
  artifact_exists: { name: "모델 파일 존재", help: "학습 후 저장된 모델 파일을 찾을 수 있는지 확인합니다." },
  load_model: { name: "모델 로딩", help: "저장된 모델을 예측 서비스에서 읽을 수 있는지 확인합니다." },
  schema_present: { name: "입력 데이터 구조", help: "모델에 필요한 입력 컬럼과 자료형이 정의되어 있는지 확인합니다." },
  test_inference: { name: "단건 예측", help: "테스트 데이터 한 건으로 실제 예측이 가능한지 확인합니다." },
  inference_latency: { name: "예측 응답시간", help: "단건 예측 시간이 설정한 허용 한도 이내인지 확인합니다." },
  metric_threshold: { name: "성능 기준", help: "설정된 모델 성능 지표 기준을 충족하는지 확인합니다. 검증 통과가 운영 적합성을 보장하지는 않습니다." },
};

export function gateLabelKo(type: string): { name: string; help: string } {
  return GATE_LABELS_KO[type] ?? {
    name: type.replaceAll("_", " "),
    help: "프로젝트에 설정된 추가 검증 항목입니다.",
  };
}
