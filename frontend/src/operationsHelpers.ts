import type { Alert, Job } from "./api";

export type HomeStats = {
  datasets: number;
  jobs: number;
  running: number;
  failed: number;
  endpoints: number;
  unreadAlerts: number;
  /** Unread+unresolved alerts that require attention (warning/error/critical). */
  attentionAlerts: number;
};

export type NextAction = {
  id: string;
  title: string;
  description: string;
  to: string;
  attention?: boolean;
};

const ACTIVE_JOB_STATUSES = new Set(["pending", "queued", "running", "dispatched"]);
const ATTENTION_ALERT_SEVERITIES = new Set(["warning", "error", "critical"]);

export function countActiveJobs(jobs: Job[]): number {
  return jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;
}

export function countFailedJobs(jobs: Job[]): number {
  return jobs.filter((job) => job.status === "failed").length;
}

export function countAttentionAlerts(alerts: Array<Pick<Alert, "severity">>): number {
  return alerts.filter((alert) => ATTENTION_ALERT_SEVERITIES.has(alert.severity)).length;
}

export function cronPresetLabel(expression: string): string {
  if (expression === "0 * * * *") return "매시간";
  if (expression === "0 9 * * *") return "매일 오전 9시";
  if (expression === "0 9 * * 1-5") return "평일 오전 9시";
  if (/^0 9 \* \* 1$/.test(expression)) return "매주 월요일 오전 9시";
  return "사용자 지정(Cron)";
}

export function targetTypeLabel(targetType: string): string {
  if (targetType === "data_import") return "데이터 가져오기";
  if (targetType === "batch_inference") return "일괄 예측";
  if (targetType === "pipeline_run") return "파이프라인 실행";
  return targetType.replaceAll("_", " ");
}

export function buildHomeNextActions(
  projectId: number,
  stats: HomeStats,
): NextAction[] {
  const actions: NextAction[] = [];
  if (stats.failed > 0) {
    actions.push({
      id: "failed-jobs",
      title: "실패한 모델 학습 확인",
      description: `확인이 필요한 실패한 학습 작업 ${stats.failed}건`,
      to: `/projects/${projectId}/jobs`,
      attention: true,
    });
  }
  if (stats.attentionAlerts > 0) {
    actions.push({
      id: "alerts",
      title: "주의가 필요한 알림 확인",
      description: `경고·오류·심각 알림 ${stats.attentionAlerts}건을 확인하세요.`,
      to: `/projects/${projectId}/alerts`,
      attention: true,
    });
  }
  if (stats.datasets === 0) {
    actions.push({
      id: "add-dataset",
      title: "데이터셋 추가",
      description: "CSV·JSON·Parquet 파일을 업로드하여 학습을 시작하세요.",
      to: `/projects/${projectId}/datasets`,
    });
  } else if (stats.jobs === 0) {
    actions.push({
      id: "train",
      title: "모델 학습 시작",
      description: "데이터·예측 목표·알고리즘을 선택하세요.",
      to: `/projects/${projectId}/jobs/new`,
    });
  } else if (stats.endpoints === 0) {
    actions.push({
      id: "registry",
      title: "모델 등록 또는 배포",
      description: "실험 결과를 모델로 등록하고 실제 예측 서비스로 연결하세요.",
      to: `/projects/${projectId}/registry`,
    });
  }
  if (actions.length < 3) {
    actions.push({
      id: "overview",
      title: "프로젝트 개요 보기",
      description: "데이터·학습·모델·배포·알림을 한눈에 확인하세요.",
      to: `/projects/${projectId}`,
    });
  }
  if (actions.length < 3) {
    actions.push({
      id: "monitoring",
      title: "운영 상태 확인",
      description: "서비스·데이터·모델 상태를 확인하세요.",
      to: `/projects/${projectId}/monitoring`,
    });
  }
  return actions.slice(0, 3);
}

export type OverviewSignals = {
  datasetCount: number;
  failedQualityChecks: number;
  latestQualityStatus: string | null;
  jobCount: number;
  activeJobs: number;
  failedJobs: number;
  modelVersionCount: number;
  productionModels: number;
  lifecycleCounts: Record<string, number>;
  endpointCount: number;
  readyEndpoints: number;
  openAlerts: number;
};

export function factualSignalLines(signals: OverviewSignals): string[] {
  const lines: string[] = [];
  if (signals.failedQualityChecks > 0) {
    lines.push(`실패한 데이터 품질 검사 ${signals.failedQualityChecks}건`);
  } else if (signals.datasetCount > 0) {
    lines.push("실패한 데이터 품질 검사 없음");
  }
  if (signals.activeJobs > 0) {
    lines.push(`진행 중인 모델 학습 ${signals.activeJobs}건`);
  }
  if (signals.failedJobs > 0) {
    lines.push(`실패한 모델 학습 ${signals.failedJobs}건`);
  }
  lines.push(
    `운영 중인 모델 ${signals.productionModels}개`,
  );
  if (signals.endpointCount > 0) {
    lines.push(`배포 준비 완료 ${signals.readyEndpoints} / ${signals.endpointCount}개`);
  } else {
    lines.push("등록된 배포 없음");
  }
  lines.push(`미해결 알림 ${signals.openAlerts}건`);
  return lines;
}

export type MonitoringAttentionItem = {
  id: string;
  label: string;
  to?: string;
};

export function buildMonitoringAttention(input: {
  projectId: string;
  serviceErrors: number;
  failedQualityChecks: number;
  readyEndpoints: number;
  endpointCount: number;
  driftStatus: string | null;
  openAlertHint?: boolean;
}): MonitoringAttentionItem[] {
  const items: MonitoringAttentionItem[] = [];
  if (input.serviceErrors > 0) {
    items.push({
      id: "service-errors",
      label: `${input.serviceErrors} prediction error${input.serviceErrors === 1 ? "" : "s"} in the selected window`,
      to: `/projects/${input.projectId}/deployments`,
    });
  }
  if (input.failedQualityChecks > 0) {
    items.push({
      id: "quality",
      label: `${input.failedQualityChecks} failed quality check${input.failedQualityChecks === 1 ? "" : "s"}`,
      to: `/projects/${input.projectId}/datasets`,
    });
  }
  if (input.endpointCount > 0 && input.readyEndpoints < input.endpointCount) {
    items.push({
      id: "ready",
      label: `${input.readyEndpoints} / ${input.endpointCount} deployments ready`,
      to: `/projects/${input.projectId}/deployments`,
    });
  }
  if (input.driftStatus && /fail|alert|drift/i.test(input.driftStatus)) {
    items.push({
      id: "drift",
      label: `Latest drift status: ${input.driftStatus.replaceAll("_", " ")}`,
      to: `/projects/${input.projectId}/alerts`,
    });
  }
  return items;
}
