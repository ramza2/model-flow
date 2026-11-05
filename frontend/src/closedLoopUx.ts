/** Phase 5-D closed-loop reason / recovery copy for Monitoring and related UX. */

export type ClosedLoopDetail = {
  code: string;
  label: string;
  reason?: string | null;
  reason_label?: string | null;
  next_action?: string | null;
  quality_run_id?: number | null;
  retrain_trigger_id?: number | null;
  training_job_id?: number | null;
  candidate_model_version_id?: number | null;
  target_dataset_version_id?: number | null;
  policy_id?: number | null;
};

const REASON_LABELS: Record<string, string> = {
  baseline_not_set: "기준 평가 설정이 필요합니다",
  baseline_model_mismatch: "기준 평가의 모델 버전이 현재 모델과 다릅니다",
  baseline_metric_missing: "기준 평가에 필요한 지표가 없습니다",
  minimum_matched_samples: "연결된 실제 정답 수가 부족합니다",
  minimum_match_rate: "실제 정답 연결률이 정책 기준보다 낮습니다",
  policy_metric_incompatible_with_model: "정책 지표가 현재 모델과 호환되지 않습니다",
  metric_missing: "설정된 지표를 확인할 수 없습니다",
  target_missing: "설정된 예측 대상을 확인할 수 없습니다",
  invalid_target_for_model: "예측 대상이 현재 모델에 유효하지 않습니다",
  consecutive_breaches_not_met: "연속 심각 평가 횟수가 부족합니다",
  cooldown_active: "재학습 대기시간이 적용 중입니다",
  no_new_dataset_version: "호환되는 새 데이터셋 버전이 없습니다",
  retrain_validation_failed: "새 데이터셋 버전이 학습 설정과 호환되지 않습니다",
  auto_retrain_disabled: "자동 재학습이 비활성화되어 있습니다",
  insufficient_data: "평가 데이터가 부족합니다",
  quality_status_ok: "품질이 정책 기준을 충족합니다",
  quality_status_warning: "품질 경고 기준을 초과했습니다",
  quality_status_critical: "품질 심각 기준을 초과했습니다",
  endpoint_model_not_production: "배포 모델이 운영(PRODUCTION) 상태가 아닙니다",
  endpoint_model_missing: "배포 엔드포인트에 현재 모델이 없습니다",
  source_training_job_missing: "원본 학습 작업을 찾을 수 없습니다",
  source_training_job_not_succeeded: "원본 학습 작업이 성공하지 않았습니다",
  source_dataset_version_missing: "원본 데이터셋 버전을 찾을 수 없습니다",
  retrain_triggered: "전체 재학습이 시작되었습니다",
  critical_degradation: "심각한 품질 저하로 재학습이 시작되었습니다",
  retrain_already_triggered: "해당 품질 평가에 대한 재학습이 이미 시작되었습니다",
  candidate_registration_failed: "후보 모델 버전 등록에 실패했습니다",
};

const TRIGGER_DECISION_LABELS: Record<string, string> = {
  consecutive_breaches_not_met: "연속 심각 평가 횟수가 부족하여 대기 중",
  cooldown_active: "재학습 대기시간으로 자동 재학습 보류",
  no_new_dataset_version: "호환되는 새 데이터셋 버전이 없음",
  retrain_validation_failed: "새 데이터셋 버전의 재학습 검증 실패",
  retrain_triggered: "전체 재학습 시작",
  auto_retrain_disabled: "자동 재학습 비활성화",
  quality_status_ok: "품질이 정상 범위이므로 재학습 불필요",
  quality_status_warning: "경고 단계이므로 자동 재학습하지 않음",
  retrain_already_triggered: "해당 품질 평가에 대한 재학습이 이미 시작됨",
};

/** Backend copy is an API contract. Translate known presentation strings only. */
const STATE_LABELS: Record<string, string> = {
  Healthy: "정상",
  "Needs baseline": "기준 평가 필요",
  "Insufficient data": "평가 데이터 부족",
  Degraded: "품질 저하",
  "Waiting for consecutive breaches": "연속 기준 위반 대기",
  Cooldown: "재학습 대기시간 적용 중",
  "Retrain blocked: no new data": "새 학습 데이터가 없어 재학습 보류",
  "Retrain validation failed": "재학습 검증 실패",
  "Retraining queued": "재학습 대기 중",
  "Retraining running": "재학습 진행 중",
  "Retraining failed": "재학습 실패",
  "Candidate registration failed": "후보 모델 등록 실패",
  "Candidate ready": "후보 모델 검토 가능",
  "Awaiting human review": "담당자 승인 대기 중",
};

const NEXT_ACTION_LABELS: Record<string, string> = {
  "No closed-loop action required.": "현재 추가 조치가 필요하지 않습니다.",
  "Review the candidate ModelVersion before requesting approval.": "승인을 요청하기 전에 후보 모델 버전을 검토하세요.",
  "Complete human approval for PRODUCTION promotion.": "운영 모델 전환을 위한 담당자 승인을 완료하세요.",
  "Wait for the closed-loop TrainingJob to start.": "자동 재학습 작업이 시작될 때까지 기다리세요.",
  "Wait for the closed-loop TrainingJob to finish.": "자동 재학습 작업이 완료될 때까지 기다리세요.",
  "Inspect the failed TrainingJob logs, then resolve data/config issues.": "실패한 학습 작업 로그를 확인하고 데이터 또는 설정 문제를 해결하세요.",
  "Inspect alerts for candidate registration failure, then retry registration if needed.": "후보 모델 등록 실패 알림을 확인하고 필요하면 등록을 다시 시도하세요.",
  "Set a baseline in Quality Policies using an eligible OK quality run.": "품질 정책에서 정상 평가 결과를 기준 평가로 지정하세요.",
  "Pin a new baseline for the current Production model.": "현재 운영 모델에 맞는 새 기준 평가를 지정하세요.",
  "Collect more matched ground truth or fix baseline/policy configuration.": "실제 정답 연결 데이터를 더 수집하거나 기준 평가·정책 설정을 확인하세요.",
  "Wait for cooldown to expire, or review recent closed-loop retrains.": "재학습 대기시간이 끝날 때까지 기다리거나 최근 재학습 이력을 확인하세요.",
  "Wait for additional consecutive critical evaluations.": "심각 평가가 연속으로 추가 발생하는지 확인하세요.",
  "Review feedback and materialize a newer DatasetVersion.": "피드백을 검토하여 새 데이터셋 버전을 생성하세요.",
  "Choose a compatible DatasetVersion or adjust the training configuration.": "호환되는 데이터셋 버전을 선택하거나 학습 설정을 수정하세요.",
  "Enable auto-retrain or trigger a manual retrain after reviewing quality evidence.": "품질 평가 근거를 검토한 뒤 자동 재학습을 켜거나 수동 재학습을 실행하세요.",
  "Review quality evidence and ensure newer training data is available.": "품질 평가 근거를 검토하고 새 학습 데이터가 준비되어 있는지 확인하세요.",
  "Monitor the next evaluations and review recent predictions/feedback.": "다음 평가를 확인하고 최근 예측과 피드백을 검토하세요.",
};

export function closedLoopStateDisplayLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return STATE_LABELS[value] || value;
}

export function closedLoopNextActionDisplayLabel(value: string): string {
  return NEXT_ACTION_LABELS[value] || value;
}

export function closedLoopReasonDisplayLabel(code: string, rawLabel?: string | null): string {
  if (REASON_LABELS[code] || code.startsWith("retrain_validation_failed") || code.startsWith("incompatible_dataset_version")) {
    return reasonLabel(code);
  }
  return rawLabel || reasonLabel(code);
}

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return "추가 평가 사유 없음";
  if (REASON_LABELS[code]) return REASON_LABELS[code];
  if (code.startsWith("retrain_validation_failed")) {
    return REASON_LABELS.retrain_validation_failed;
  }
  if (code.startsWith("incompatible_dataset_version")) {
    return REASON_LABELS.retrain_validation_failed;
  }
  return code.replace(/_/g, " ");
}

export function triggerDecisionLabel(code: string | null | undefined): string {
  if (!code) return "—";
  if (TRIGGER_DECISION_LABELS[code]) return TRIGGER_DECISION_LABELS[code];
  if (code.startsWith("retrain_validation_failed")) {
    return TRIGGER_DECISION_LABELS.retrain_validation_failed;
  }
  return reasonLabel(code);
}

export type ClosedLoopLink = {
  id: string;
  label: string;
  to: string;
};

export function closedLoopRecoveryLinks(
  projectId: string,
  detail: ClosedLoopDetail | null | undefined,
  card?: {
    endpoint_id?: number;
    policy_id?: number;
    baseline_required?: boolean;
  },
): ClosedLoopLink[] {
  if (!detail) return [];
  const links: ClosedLoopLink[] = [];
  const code = detail.code;

  if (code === "needs_baseline" || card?.baseline_required) {
    links.push({
      id: "policies",
      label: "품질 정책에서 기준 평가 설정",
      to: `/projects/${projectId}/model-quality/policies`,
    });
  }
  if (
    code === "retrain_blocked_no_new_data" ||
    code === "insufficient_data" ||
    detail.reason === "minimum_matched_samples" ||
    detail.reason === "minimum_match_rate"
  ) {
    const endpointQuery =
      card?.endpoint_id != null ? `?endpoint_id=${card.endpoint_id}` : "";
    links.push({
      id: "feedback",
      label: "피드백 검토",
      to: `/projects/${projectId}/feedback${endpointQuery}`,
    });
  }
  if (detail.target_dataset_version_id != null) {
    links.push({
      id: "dataset",
      label: `데이터셋 버전 #${detail.target_dataset_version_id}`,
      to: `/projects/${projectId}/datasets`,
    });
  } else if (code === "retrain_blocked_no_new_data" || code === "retrain_validation_failed") {
    links.push({
      id: "datasets",
      label: "데이터셋 열기",
      to: `/projects/${projectId}/datasets`,
    });
  }
  if (detail.training_job_id != null) {
    links.push({
      id: "training",
      label: `학습 작업 #${detail.training_job_id}`,
      to: `/projects/${projectId}/training`,
    });
  }
  if (detail.candidate_model_version_id != null) {
    links.push({
      id: "candidate",
      label:
        code === "candidate_ready" || code === "awaiting_human_review"
          ? "후보 모델 검토"
          : `모델 버전 #${detail.candidate_model_version_id}`,
      to: `/projects/${projectId}/registry?modelVersionId=${detail.candidate_model_version_id}`,
    });
  }
  if (code === "degraded_warning" || code === "degraded_critical" || code === "retraining_failed") {
    links.push({
      id: "alerts",
      label: "알림 열기",
      to: `/projects/${projectId}/alerts`,
    });
  }
  if (card?.policy_id != null) {
    links.push({
      id: "policy",
      label: "품질 정책",
      to: `/projects/${projectId}/model-quality/policies`,
    });
  }
  // Deduplicate by id while preserving order.
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.id)) return false;
    seen.add(link.id);
    return true;
  });
}

export function formatMatchedSamples(
  matched: number,
  minimum: number | null | undefined,
): string {
  if (minimum == null || minimum <= 0) return `${matched} matched ground-truth samples`;
  return `${matched} / ${minimum} matched ground-truth samples`;
}
