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
    "직접 분할은 학습 생성 시 비율을 적용하고, 저장된 분할은 이전에 저장한 동일 구성을 재사용합니다. 시간 순서는 과거로 학습·이후로 평가하고, 무작위는 데이터를 임의로 나눕니다.",
  timeOrderedSplit:
    "과거 데이터로 학습하고 그보다 이후 시점으로 검증·테스트합니다. 실제 미래 예측과 유사한 평가 방식입니다.",
  algorithm:
    "데이터에서 규칙을 학습하는 모델 방식입니다. 문제 유형과 데이터 크기에 따라 적합한 알고리즘이 달라집니다.",
  hyperparameters:
    "알고리즘의 학습 동작을 조정하는 세부 설정입니다. 잘 모르는 경우 기본값으로 시작한 뒤 실험 비교로 조정하는 것이 좋습니다.",
  savedSplit:
    "미리 저장한 학습/검증/테스트 행 구성을 재사용합니다. 동일한 데이터 분할로 여러 모델을 비교할 때 사용합니다.",
  forecastHorizons:
    "미래의 몇 번째 데이터까지 예측할지 지정합니다. 예를 들어 1, 2, 3은 현재 이후 첫 번째·두 번째·세 번째 관측값을 예측한다는 의미입니다. 숫자는 시간(시·분)이 아니라 데이터 간격을 나타냅니다.",
  preparationJoin:
    "두 입력을 같은 키 값으로 맞춰 가로로 연결합니다. LEFT·RIGHT 포트에 각각 한 개의 입력을 연결하세요.",
  preparationUnion:
    "여러 입력의 행을 세로로 이어 붙입니다. strict는 컬럼 이름·순서가 같아야 하고, align_by_name은 이름 기준으로 맞춥니다.",
  preparationCast:
    "선택한 컬럼의 자료형(정수·실수·문자열·불리언·날짜시간)을 변환합니다. 변환할 수 없는 값은 Preview/Run에서 실패할 수 있습니다.",
  preparationDerived:
    "새 컬럼을 만들어 결과에 추가합니다. ‘새 컬럼 이름’은 결과로 붙일 이름이고, operand의 Column은 기존 입력 데이터에 있는 컬럼명을 정확히 적어야 합니다. 없거나 오타인 컬럼명은 Preview/Run 실패 원인이 됩니다. Literal은 컬럼이 아니라 직접 지정한 고정값입니다.",
  preparationGroupBy:
    "같은 그룹 키를 가진 행을 묶고, 합계·평균·최소·최대·개수 같은 집계 값을 계산합니다.",
  preparationUnpivot:
    "여러 컬럼을 ‘변수 이름 / 값’ 형태의 긴 행으로 펼칩니다. 식별자 컬럼은 그대로 두고, 펼칠 컬럼만 지정합니다.",
  preparationPivot:
    "행에 있던 값을 가로 컬럼으로 펼치고 집계합니다. 설정한 pivot 값만 출력 컬럼이 됩니다.",
  preparationLag:
    "시간 순으로 정렬한 뒤, 이전 행의 값을 새 컬럼으로 만듭니다. 이력이 부족한 앞쪽 행은 비어 있을 수 있습니다.",
  preparationRollingWindow:
    "과거 구간만 사용해 이동 평균·합계 등 집계 피처를 만듭니다. 현재 행은 포함하지 않으며, 창이 부족한 행은 비어 있을 수 있습니다.",
  dataQuality:
    "데이터가 학습에 사용하기 적절한지 규칙으로 검사합니다. 필수값 누락, 중복, 허용 범위 등을 확인할 수 있으며 검사 결과는 선택한 데이터셋 버전에 기록됩니다.",
  qualityBlocking:
    "이 옵션을 켠 규칙이 실패하면 해당 데이터로 학습을 시작하지 못하도록 차단합니다. 중요한 데이터 오류를 발견했을 때 잘못된 모델 학습을 방지하는 용도입니다.",
  qualitySeverity:
    "실패(Fail)는 품질 문제로 판정하고, 경고(Warning)는 문제를 기록하되 경고 수준으로 처리합니다.",
  primaryMetric:
    "모델이 얼마나 잘 예측했는지 나타내는 대표 수치입니다. val은 검증 데이터를 뜻합니다. RMSE·MAE는 예측 오차이므로 낮을수록 좋고, Accuracy(정확도)·F1은 일반적으로 높을수록 좋습니다.",
} as const;

/** Display-only training job status labels. Raw status values stay English for API/tone. */
export function jobStatusLabel(value?: string | null): string {
  switch (String(value || "").toLowerCase()) {
    case "pending":
      return "대기 중";
    case "queued":
      return "대기열";
    case "running":
      return "학습 중";
    case "succeeded":
      return "완료";
    case "failed":
      return "실패";
    case "cancelled":
      return "취소됨";
    case "cancel_requested":
      return "취소 요청 중";
    default:
      return value ? String(value).replaceAll("_", " ") : "—";
  }
}

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

/** Display-only labels for derived_column operations. Persisted values stay English. */
export function derivedOperationLabel(value?: string | null): string {
  switch (String(value || "")) {
    case "add":
      return "더하기 (add)";
    case "subtract":
      return "빼기 (subtract)";
    case "multiply":
      return "곱하기 (multiply)";
    case "divide":
      return "나누기 (divide)";
    case "concat":
      return "문자열 이어붙이기 (concat)";
    case "regex_extract":
      return "정규식 추출 (regex_extract)";
    case "datetime_parse":
      return "날짜시간 파싱 (datetime_parse)";
    case "datetime_add_hours":
      return "시간 더하기 (datetime_add_hours)";
    case "datetime_format":
      return "날짜시간 포맷 (datetime_format)";
    default:
      return value || "—";
  }
}
