export const UI_HELP = {
  trainingTask:
    "학습할 데이터의 성격을 선택합니다. 표 형식 데이터는 일반적인 행/열 데이터를, 시계열 예측은 시간 순서가 있는 미래값 예측을 의미합니다.",
  problemType:
    "모델이 무엇을 예측하는지 선택합니다. 수치 예측(회귀)은 열수요량·가격처럼 연속적인 숫자를, 분류는 정상/불량처럼 범주를 예측합니다.",
  trainingMode:
    "신규 학습은 모델을 처음부터 새로 학습합니다. 이어서 학습은 지원되는 알고리즘에서 기존 모델을 바탕으로 추가 학습합니다.",
  target:
    "모델이 최종적으로 맞혀야 하는 값입니다. 예: 열수요량 HTDND_AMNT.",
  features:
    "예측에 사용할 입력 항목입니다. 실제 예측 시점에 알 수 있는 컬럼만 선택해야 데이터 누수를 피할 수 있습니다.",
  dataSplit:
    "학습/검증/테스트 데이터를 나누는 방법입니다. 같은 저장된 분할을 여러 모델에서 사용하면 성능을 공정하게 비교할 수 있습니다.",
  timeOrderedSplit:
    "과거 데이터로 학습하고 그보다 이후 시점으로 검증·테스트합니다. 실제 미래 예측과 유사한 평가 방식입니다.",
  algorithm:
    "데이터에서 규칙을 학습하는 모델 방식입니다. 문제 유형과 데이터 크기에 따라 적합한 알고리즘이 달라집니다.",
  hyperparameters:
    "알고리즘의 학습 동작을 조정하는 세부 설정입니다. 잘 모르는 경우 기본값으로 시작한 뒤 실험 비교로 조정하는 것이 좋습니다.",
  savedSplit:
    "미리 저장한 학습/검증/테스트 행 구성을 재사용합니다. 동일한 데이터 분할로 여러 모델을 비교할 때 사용합니다.",
} as const;

export function trainingTaskLabel(value?: string | null): string {
  return String(value || "").toLowerCase() === "forecasting"
    ? "시계열 예측 (Forecasting)"
    : "표 형식 데이터 (Tabular)";
}

export function problemTypeLabel(value?: string | null): string {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "regression") return "수치 예측·회귀 (Regression)";
  if (normalized === "classification") return "분류 (Classification)";
  if (normalized === "auto") return "자동 판별 (Auto)";
  return value || "—";
}

export function trainingModeLabel(value?: string | null): string {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "fresh") return "신규 학습 (Fresh)";
  if (normalized === "continued") return "이어서 학습 (Continued)";
  if (normalized === "full_retrain") return "전체 재학습 (Full retrain)";
  return value ? value.replaceAll("_", " ") : "—";
}

export function splitStrategyLabel(value?: string | null): string {
  return String(value || "random").toLowerCase() === "time"
    ? "시간 순서 (Time ordered)"
    : "무작위 (Random)";
}
