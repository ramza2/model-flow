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
  baseline_not_set: "Baseline required",
  baseline_model_mismatch: "Baseline belongs to a different model version",
  baseline_metric_missing: "Baseline is missing a required metric",
  minimum_matched_samples: "Not enough matched ground truth",
  minimum_match_rate: "Ground-truth coverage is below policy minimum",
  consecutive_breaches_not_met: "Waiting for more consecutive critical evaluations",
  cooldown_active: "Retraining is in cooldown",
  no_new_dataset_version: "No newer compatible DatasetVersion exists",
  retrain_validation_failed:
    "New DatasetVersion is not compatible with the training configuration",
  auto_retrain_disabled: "Automatic retraining is disabled",
  insufficient_data: "Insufficient evaluation data",
  quality_status_ok: "Quality is within policy thresholds",
  quality_status_warning: "Quality warning threshold breached",
  quality_status_critical: "Quality critical threshold breached",
  retrain_triggered: "Full retraining was triggered",
  critical_degradation: "Critical quality degradation triggered retraining",
  retrain_already_triggered: "Retraining was already triggered for this quality run",
  candidate_registration_failed: "Candidate ModelVersion registration failed",
};

const TRIGGER_DECISION_LABELS: Record<string, string> = {
  consecutive_breaches_not_met: "Waiting for more consecutive critical evaluations",
  cooldown_active: "Retraining suppressed by cooldown",
  no_new_dataset_version: "No newer compatible DatasetVersion exists",
  retrain_validation_failed: "Retrain validation failed for the newer DatasetVersion",
  retrain_triggered: "Full retraining was triggered",
  auto_retrain_disabled: "Automatic retraining is disabled",
  quality_status_ok: "Quality status is OK — no retrain",
  quality_status_warning: "Warning only — no automatic retrain",
  retrain_already_triggered: "Retrain already triggered for this quality run",
};

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return "No additional detail";
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
      label: "Set a baseline in Quality Policies",
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
      label: "Review feedback",
      to: `/projects/${projectId}/feedback${endpointQuery}`,
    });
  }
  if (detail.target_dataset_version_id != null) {
    links.push({
      id: "dataset",
      label: `DatasetVersion #${detail.target_dataset_version_id}`,
      to: `/projects/${projectId}/datasets`,
    });
  } else if (code === "retrain_blocked_no_new_data" || code === "retrain_validation_failed") {
    links.push({
      id: "datasets",
      label: "Open datasets",
      to: `/projects/${projectId}/datasets`,
    });
  }
  if (detail.training_job_id != null) {
    links.push({
      id: "training",
      label: `Training Job #${detail.training_job_id}`,
      to: `/projects/${projectId}/training`,
    });
  }
  if (detail.candidate_model_version_id != null) {
    links.push({
      id: "candidate",
      label:
        code === "candidate_ready" || code === "awaiting_human_review"
          ? "Review candidate"
          : `ModelVersion #${detail.candidate_model_version_id}`,
      to: `/projects/${projectId}/registry?modelVersionId=${detail.candidate_model_version_id}`,
    });
  }
  if (code === "degraded_warning" || code === "degraded_critical" || code === "retraining_failed") {
    links.push({
      id: "alerts",
      label: "Open alerts",
      to: `/projects/${projectId}/alerts`,
    });
  }
  if (card?.policy_id != null) {
    links.push({
      id: "policy",
      label: "Quality Policies",
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
