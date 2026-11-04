import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import {
  closedLoopRecoveryLinks,
  formatMatchedSamples,
  reasonLabel,
  triggerDecisionLabel,
  type ClosedLoopDetail,
} from "../closedLoopUx";
import {
  EmptyState,
  ErrorNotice,
  HelpTip,
  Loading,
  PageHeader,
  StatusBadge,
  TermLabel,
  metric,
} from "../components";
import { DetailSection } from "../lifecycleComponents";
import { modelLifecycleLabelKo } from "../modelRegistryLabels";
import { buildMonitoringAttention } from "../operationsHelpers";
import { UI_HELP } from "../uiTerminology";

type ServiceMetrics = {
  request_count: number;
  success_count: number;
  error_count: number;
  success_rate: number | null;
  average_latency_ms: number | null;
  p95_latency_ms: number | null;
  series: Array<{ timestamp: string; requests: number; successes: number; errors: number; average_latency_ms: number | null }>;
};
type DataMetrics = {
  dataset_count: number;
  dataset_version_count: number;
  quality_check_count: number;
  failed_quality_check_count: number;
  latest_quality_status: string | null;
};
type ModelMetrics = {
  model_version_count: number;
  lifecycle_counts: Record<string, number>;
  endpoint_count: number;
  ready_endpoint_count: number;
  total_requests: number;
  total_errors: number;
  latest_drift_status: string | null;
};
type QualitySummaryCard = {
  policy_id: number;
  policy_name: string;
  endpoint_id: number;
  endpoint_name: string | null;
  current_model_version_id: number | null;
  current_model_name: string | null;
  current_model_version: string | null;
  latest_quality_status: string | null;
  primary_metric: string;
  primary_metric_value: number | null;
  matched_ground_truth_count: number;
  prediction_count: number;
  match_rate: number | null;
  window_start: string | null;
  window_end: string | null;
  last_evaluated_at: string | null;
  closed_loop_state: string;
  closed_loop?: ClosedLoopDetail | null;
  latest_run_id: number | null;
  latest_trigger_decision?: Record<string, unknown> | null;
  revision?: number;
  mode?: "legacy" | "advanced" | string;
  rule_logic?: string;
  rule_count?: number;
  evaluation_delay_hours?: number;
  minimum_match_rate?: number | null;
  minimum_matched_samples?: number;
  baseline_quality_run_id?: number | null;
  baseline_model_version_id?: number | null;
  baseline_required?: boolean;
  latest_evaluation?: Record<string, unknown> | null;
  latest_policy_revision?: number | null;
};

type QualityRunRow = Record<string, unknown> & { id: number };

const HISTORY_PAGE_SIZE = 10;

/** Monitoring-only display copy. API values and status badge tones remain unchanged. */
function monitoringStatusLabel(value?: string | null): string {
  const status = String(value || "unknown").toLowerCase();
  const labels: Record<string, string> = {
    unknown: "미확인 (Unknown)",
    healthy: "정상",
    passed: "통과",
    pass: "통과",
    ok: "정상",
    succeeded: "성공",
    warning: "경고",
    failed: "실패",
    fail: "실패",
    critical: "심각",
    insufficient_data: "평가 데이터 부족",
  };
  return labels[status] || status.replaceAll("_", " ");
}

function prettyMetric(name: string): string {
  if (name === "f1_macro") return "F1";
  if (name === "precision_macro") return "Precision";
  if (name === "recall_macro") return "Recall";
  return name;
}

export function formatRuleEvidence(rule: Record<string, unknown>): string {
  const metricName = prettyMetric(String(rule.metric || "metric"));
  const status = String(rule.status || "unknown").toUpperCase();
  if (rule.comparison === "baseline_delta") {
    const delta = rule.degradation_delta;
    const deltaText =
      typeof delta === "number" ? metric(delta, 2) : delta == null ? "—" : String(delta);
    return `${metricName} baseline delta ${deltaText} → ${status}`;
  }
  const value = rule.current_value;
  const valueText =
    typeof value === "number" ? metric(value, 4) : value == null ? "—" : String(value);
  return `${metricName} ${valueText} → ${status}`;
}

function evaluationEvidence(evaluation: unknown): string {
  if (!evaluation || typeof evaluation !== "object") return "—";
  const rules = (evaluation as { rules?: unknown }).rules;
  if (!Array.isArray(rules) || rules.length === 0) return "—";
  return rules
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => formatRuleEvidence(row))
    .join("; ");
}

function breachedRuleCount(evaluation: unknown): number {
  if (!evaluation || typeof evaluation !== "object") return 0;
  const rules = (evaluation as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return 0;
  return rules.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const status = String((row as { status?: unknown }).status || "").toLowerCase();
    return status === "warning" || status === "critical";
  }).length;
}

function detailFromCard(card: QualitySummaryCard): ClosedLoopDetail {
  if (card.closed_loop && typeof card.closed_loop === "object") {
    return card.closed_loop;
  }
  return {
    code: "healthy",
    label: card.closed_loop_state || "Healthy",
    reason: null,
    next_action: null,
    quality_run_id: card.latest_run_id,
    policy_id: card.policy_id,
  };
}

export default function Monitoring() {
  const { projectId } = useParams();
  const [service, setService] = useState<ServiceMetrics | null>(null);
  const [data, setData] = useState<DataMetrics | null>(null);
  const [models, setModels] = useState<ModelMetrics | null>(null);
  const [qualityCards, setQualityCards] = useState<QualitySummaryCard[]>([]);
  const [qualityRuns, setQualityRuns] = useState<QualityRunRow[]>([]);
  const [qualityRunTotal, setQualityRunTotal] = useState(0);
  const [historyEndpointId, setHistoryEndpointId] = useState<string>("");
  const [historyPolicyId, setHistoryPolicyId] = useState<string>("");
  const [historySkip, setHistorySkip] = useState(0);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [hours, setHours] = useState("24");
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([
      api<ServiceMetrics>(`/projects/${projectId}/monitoring/service?hours=${hours}`),
      api<DataMetrics>(`/projects/${projectId}/monitoring/data`),
      api<ModelMetrics>(`/projects/${projectId}/monitoring/models`),
      api<{ items: QualitySummaryCard[] }>(`/projects/${projectId}/model-quality/summary`).catch(() => ({ items: [] })),
    ]).then(([serviceRows, dataRows, modelRows, qualitySummary]) => {
      setService(serviceRows);
      setData(dataRows);
      setModels(modelRows);
      setQualityCards(qualitySummary.items || []);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "모니터링 지표를 불러올 수 없습니다."))
      .finally(() => setLoading(false));
  }, [hours, projectId]);

  useEffect(() => {
    if (!projectId) return;
    setHistoryLoading(true);
    const params = new URLSearchParams({
      paged: "true",
      skip: String(historySkip),
      limit: String(HISTORY_PAGE_SIZE),
    });
    if (historyEndpointId) params.set("endpoint_id", historyEndpointId);
    if (historyPolicyId) params.set("policy_id", historyPolicyId);
    api<{ items: QualityRunRow[]; total: number }>(
      `/projects/${projectId}/model-quality/runs?${params.toString()}`,
    )
      .then((page) => {
        setQualityRuns(Array.isArray(page.items) ? page.items : []);
        setQualityRunTotal(Number(page.total || 0));
      })
      .catch(() => {
        setQualityRuns([]);
        setQualityRunTotal(0);
      })
      .finally(() => setHistoryLoading(false));
  }, [projectId, historyEndpointId, historyPolicyId, historySkip]);

  const maxRequests = Math.max(1, ...(service?.series.map((point) => point.requests) || [1]));
  const attention = useMemo(() => {
    if (!projectId || !service || !data || !models) return [];
    return buildMonitoringAttention({
      projectId,
      serviceErrors: service.error_count,
      failedQualityChecks: data.failed_quality_check_count,
      readyEndpoints: models.ready_endpoint_count,
      endpointCount: models.endpoint_count,
      driftStatus: models.latest_drift_status,
    });
  }, [projectId, service, data, models]);

  const historyEndpoints = useMemo(() => {
    const map = new Map<number, string>();
    for (const card of qualityCards) {
      map.set(card.endpoint_id, card.endpoint_name || `Endpoint #${card.endpoint_id}`);
    }
    return Array.from(map.entries());
  }, [qualityCards]);

  const historyPolicies = useMemo(() => {
    return qualityCards
      .filter((card) => !historyEndpointId || String(card.endpoint_id) === historyEndpointId)
      .map((card) => ({ id: card.policy_id, name: card.policy_name }));
  }, [qualityCards, historyEndpointId]);

  const openHistoryForCard = (card: QualitySummaryCard) => {
    setHistoryEndpointId(String(card.endpoint_id));
    setHistoryPolicyId(String(card.policy_id));
    setHistorySkip(0);
    setExpandedRunId(card.latest_run_id);
  };

  return (
    <div className="page-stack ops-page monitoring-page">
      <PageHeader
        title="모니터링 (Monitoring)"
        description="예측 서비스의 요청 현황과 데이터·모델 품질 신호를 한눈에 확인합니다."
        actions={(
          <label className="header-filter">
            조회 기간
            <select value={hours} onChange={(event) => setHours(event.target.value)} data-testid="monitoring-window">
              <option value="24">최근 24시간</option>
              <option value="168">최근 7일</option>
              <option value="720">최근 30일</option>
            </select>
          </label>
        )}
      />
      <ErrorNotice message={error} />
      {loading || !service || !data || !models ? (
        <Loading label="모니터링 지표를 불러오는 중" />
      ) : (
        <>
          <section
            className={`panel ops-attention-panel${attention.length > 0 ? " has-signals" : " is-clear"}`}
            data-testid="monitoring-attention"
          >
            <span className="eyebrow">확인 필요</span>
            {attention.length === 0 ? (
              <p className="muted">
                현재 수집된 지표에서 주의 신호가 없습니다.
                {" "}(예측 오류 {service.error_count}건, 품질 검사 실패 {data.failed_quality_check_count}건,
                {" "}배포 준비 완료 {models.ready_endpoint_count}/{models.endpoint_count}건)
              </p>
            ) : (
              <ul className="ops-signal-list">
                {attention.map((item) => (
                  <li key={item.id}>
                    {item.to ? (
                      <Link to={item.to}>
                        {item.id === "service-errors"
                          ? `선택 기간의 예측 오류 ${service.error_count}건`
                          : item.id === "quality"
                            ? `실패한 데이터 품질 검사 ${data.failed_quality_check_count}건`
                            : item.id === "ready"
                              ? `배포 준비 완료 ${models.ready_endpoint_count}/${models.endpoint_count}건`
                              : item.id === "drift"
                                ? `최근 데이터 분포 변화 상태: ${monitoringStatusLabel(models.latest_drift_status)}`
                                : item.label}
                      </Link>
                    ) : item.label}
                  </li>
                ))}
              </ul>
            )}
            <div className="row-actions">
              <Link to={`/projects/${projectId}/alerts`}>알림 확인</Link>
              <Link to={`/projects/${projectId}/deployments`}>배포 관리</Link>
              <Link to={`/projects/${projectId}/datasets`}>데이터셋</Link>
              <Link to={`/projects/${projectId}/registry`}>모델 등록소</Link>
            </div>
          </section>

          <DetailSection eyebrow="서비스" title="서비스 상태" testId="monitoring-service">
            <div className="grid stats-grid monitoring-metrics">
              <div className="stat metric-card">
                <div className="label">예측 요청</div>
                <div className="value tabular-num">{service.request_count.toLocaleString()}</div>
              </div>
              <div className="stat metric-card">
                <div className="label">성공</div>
                <div className="value tabular-num">{service.success_count.toLocaleString()}</div>
              </div>
              <div className={`stat metric-card${service.error_count > 0 ? " is-attention" : ""}`}>
                <div className="label">오류</div>
                <div className="value tabular-num">{service.error_count.toLocaleString()}</div>
              </div>
              <div className="stat metric-card">
                <div className="label">성공률</div>
                <div className="value tabular-num">
                  {service.success_rate === null ? "—" : `${metric(service.success_rate * 100, 1)}%`}
                </div>
              </div>
              <div className="stat metric-card">
                <div className="label"><TermLabel ko="평균 응답시간" en="Avg latency" help={UI_HELP.monitoringLatency} /></div>
                <div className="value metric-value tabular-num">{metric(service.average_latency_ms, 1)} ms</div>
              </div>
              <div className="stat metric-card">
                <div className="label"><TermLabel ko="p95 응답시간" help={UI_HELP.monitoringLatency} /></div>
                <div className="value metric-value tabular-num">{metric(service.p95_latency_ms, 1)} ms</div>
              </div>
            </div>
            <div className="panel nested-panel">
              {service.series.length === 0 ? (
                <EmptyState
                  title="예측 요청 이력이 없습니다"
                  description="배포된 모델에 예측 요청이 들어오면 시간별 요청 현황이 표시됩니다."
                />
              ) : (
                <div className="bar-chart" aria-label="시간별 예측 요청">
                  {service.series.map((point) => (
                    <div className="bar-column" key={point.timestamp} title={`예측 요청 ${point.requests}건`}>
                      <div className="bar" style={{ height: `${Math.max(4, (point.requests / maxRequests) * 100)}%` }} />
                      <span>{new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit" })}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DetailSection>

          <DetailSection
            eyebrow="운영 모델"
            title="운영 모델 품질 (Production Quality)"
            testId="monitoring-production-quality"
            actions={(
              <span className="row-actions">
                <HelpTip text={UI_HELP.monitoringProductionQuality} />
                <Link to={`/projects/${projectId}/model-quality/policies`} data-testid="quality-policies-link">
                  품질 정책 관리
                </Link>
              </span>
            )}
          >
            {qualityCards.length === 0 ? (
              <EmptyState
                title="설정된 운영 모델 품질 정책이 없습니다"
                description="예측 결과와 실제 정답을 비교하려면 품질 정책을 만들고 평가를 실행하세요. 조건에 따라 후보 모델 재학습을 연결할 수 있습니다."
                action={(
                  <Link to={`/projects/${projectId}/model-quality/policies`} className="btn">
                    품질 정책 열기
                  </Link>
                )}
              />
            ) : (
              <div className="stack-gap" data-testid="production-quality-cards">
                {qualityCards.map((card) => {
                  const advanced = card.mode === "advanced";
                  const detail = detailFromCard(card);
                  const recoveryLinks = closedLoopRecoveryLinks(String(projectId), detail, card);
                  const decisionReason =
                    card.latest_trigger_decision && typeof card.latest_trigger_decision.reason === "string"
                      ? String(card.latest_trigger_decision.reason)
                      : detail.reason;
                  return (
                    <div
                      className="panel nested-panel production-quality-card"
                      key={card.policy_id}
                      data-testid={`quality-card-${card.policy_id}`}
                    >
                      <div className="row-actions production-quality-card-head">
                        <strong>{card.endpoint_name || `배포 엔드포인트 #${card.endpoint_id}`}</strong>
                        <StatusBadge
                          status={card.latest_quality_status || "unknown"}
                          label={monitoringStatusLabel(card.latest_quality_status)}
                        />
                        {card.baseline_required ? (
                          <span className="notice notice-warning" data-testid={`baseline-required-${card.policy_id}`}>
                            기준 평가 필요
                          </span>
                        ) : null}
                        <span className="muted" data-testid={`closed-loop-state-${card.endpoint_id}`}>
                          {detail.label || card.closed_loop_state}
                        </span>
                      </div>
                      <div className="notice" data-testid={`closed-loop-detail-${card.policy_id}`}>
                        <p data-testid={`closed-loop-code-${card.policy_id}`}>
                          <strong>{detail.label}</strong>
                          {detail.reason ? (
                            <>
                              {" — "}
                              <span data-testid={`closed-loop-reason-${card.policy_id}`}>
                                {detail.reason_label || reasonLabel(detail.reason)}
                              </span>
                            </>
                          ) : null}
                        </p>
                        {detail.code === "insufficient_data" ? (
                          <p className="muted" data-testid={`closed-loop-samples-${card.policy_id}`}>
                            {formatMatchedSamples(
                              card.matched_ground_truth_count,
                              card.minimum_matched_samples,
                            )}
                          </p>
                        ) : null}
                        {detail.next_action ? (
                          <p data-testid={`closed-loop-next-${card.policy_id}`}>{detail.next_action}</p>
                        ) : null}
                        {decisionReason ? (
                          <p className="muted" data-testid={`trigger-decision-${card.policy_id}`}>
                            재학습 판단: {triggerDecisionLabel(decisionReason)}
                          </p>
                        ) : null}
                      </div>
                      <dl className="key-values">
                        <div>
                          <dt>현재 모델</dt>
                          <dd>
                            {card.current_model_name
                              ? `${card.current_model_name} v${card.current_model_version}`
                              : "—"}
                          </dd>
                        </div>
                        {advanced ? (
                          <>
                            <div>
                              <dt>정책 개정 번호</dt>
                              <dd data-testid={`quality-revision-${card.policy_id}`}>{card.revision ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>평가 규칙</dt>
                              <dd data-testid={`quality-rule-count-${card.policy_id}`}>
                                {card.rule_count ?? 0} · {(card.rule_logic || "any").toUpperCase()}
                              </dd>
                            </div>
                            <div>
                              <dt>기준 평가 실행</dt>
                              <dd data-testid={`quality-baseline-${card.policy_id}`}>
                                {card.baseline_quality_run_id == null
                                  ? "—"
                                  : `#${card.baseline_quality_run_id}`}
                              </dd>
                            </div>
                            <div>
                              <dt>평가 대기시간</dt>
                              <dd>{card.evaluation_delay_hours ?? 0}h</dd>
                            </div>
                            <div>
                              <dt><TermLabel ko="최소 연결률" en="Match rate" help={UI_HELP.monitoringMatchRate} /></dt>
                              <dd data-testid={`match-rate-min-${card.policy_id}`}>
                                {card.minimum_match_rate == null
                                  ? "—"
                                  : `${metric(card.minimum_match_rate * 100, 1)}%`}
                              </dd>
                            </div>
                            <div>
                              <dt>최근 품질 상태</dt>
                              <dd>{monitoringStatusLabel(card.latest_quality_status)}</dd>
                            </div>
                          </>
                        ) : (
                          <div>
                            <dt>대표 평가 지표</dt>
                            <dd>
                              {card.primary_metric}
                              {card.primary_metric_value == null ? "" : ` = ${metric(card.primary_metric_value, 4)}`}
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>연결된 실제 정답</dt>
                          <dd data-testid={`matched-gt-${card.policy_id}`}>{card.matched_ground_truth_count}</dd>
                        </div>
                        <div>
                          <dt>예측 건수</dt>
                          <dd>{card.prediction_count}</dd>
                        </div>
                        <div>
                          <dt><TermLabel ko="연결률" en="Match rate" help={UI_HELP.monitoringMatchRate} /></dt>
                          <dd data-testid={`match-rate-${card.policy_id}`}>
                            {card.match_rate == null ? "—" : `${metric(card.match_rate * 100, 1)}%`}
                          </dd>
                        </div>
                        <div>
                          <dt>최근 평가 시각</dt>
                          <dd>{card.last_evaluated_at ? new Date(card.last_evaluated_at).toLocaleString() : "—"}</dd>
                        </div>
                      </dl>
                      <div className="row-actions" data-testid={`closed-loop-actions-${card.policy_id}`}>
                        {recoveryLinks.map((link) => (
                          <Link key={link.id} to={link.to} data-testid={`recovery-${link.id}-${card.policy_id}`}>
                            {link.label}
                          </Link>
                        ))}
                        {card.current_model_version_id ? (
                          <Link to={`/projects/${projectId}/models/${card.current_model_version_id}`}>
                            현재 모델 보기
                          </Link>
                        ) : null}
                        <Link
                          to={`/projects/${projectId}/feedback?endpoint_id=${card.endpoint_id}`}
                          data-testid={`review-feedback-${card.endpoint_id}`}
                        >
                          피드백 검토
                        </Link>
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => openHistoryForCard(card)}
                          data-testid={`view-quality-history-${card.policy_id}`}
                        >
                          품질 이력 보기
                        </button>
                        <Link
                          to={`/projects/${projectId}/model-quality/policies`}
                          data-testid={`manage-policy-${card.policy_id}`}
                        >
                          정책 관리
                        </Link>
                        <Link to={`/projects/${projectId}/alerts`}>알림 확인</Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DetailSection>

          <DetailSection eyebrow="운영 모델" title="품질 평가 이력 (Quality History)" testId="monitoring-quality-trend">
            <div className="filter-bar catalog-filter" data-testid="quality-history-filters">
              <label>
                배포 엔드포인트
                <select
                  value={historyEndpointId}
                  onChange={(event) => {
                    setHistoryEndpointId(event.target.value);
                    setHistoryPolicyId("");
                    setHistorySkip(0);
                  }}
                  data-testid="quality-history-endpoint-filter"
                >
                  <option value="">전체</option>
                  {historyEndpoints.map(([id, name]) => (
                    <option key={id} value={String(id)}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                품질 정책
                <select
                  value={historyPolicyId}
                  onChange={(event) => {
                    setHistoryPolicyId(event.target.value);
                    setHistorySkip(0);
                  }}
                  data-testid="quality-history-policy-filter"
                >
                  <option value="">전체</option>
                  {historyPolicies.map((policy) => (
                    <option key={policy.id} value={String(policy.id)}>{policy.name}</option>
                  ))}
                </select>
              </label>
            </div>
            {historyLoading ? <Loading label="품질 평가 이력을 불러오는 중" /> : null}
            {!historyLoading && qualityRuns.length === 0 ? (
              <p className="muted">현재 필터 조건에 해당하는 품질 평가 이력이 없습니다. 엔드포인트와 정책을 변경하거나 품질 평가를 실행해 보세요.</p>
            ) : null}
            {!historyLoading && qualityRuns.length > 0 ? (
              <div className="table-wrap catalog-table">
                <table>
                  <thead>
                    <tr>
                      <th>실행 번호</th>
                      <th>상태</th>
                      <th>정책 개정</th>
                      <th>정답 연결 / 예측</th>
                      <th><TermLabel ko="연결률" en="Match rate" help={UI_HELP.monitoringMatchRate} /></th>
                      <th>기준 위반 규칙</th>
                      <th>평가 근거</th>
                      <th>완료 시각</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {qualityRuns.map((run) => {
                      const evaluation = run.evaluation;
                      const matched = Number(run.matched_ground_truth_count ?? 0);
                      const predictions = Number(run.prediction_count ?? 0);
                      const matchRate = run.match_rate;
                      const expanded = expandedRunId === run.id;
                      const decision =
                        run.trigger_decision && typeof run.trigger_decision === "object"
                          ? (run.trigger_decision as Record<string, unknown>)
                          : null;
                      const evalObj =
                        evaluation && typeof evaluation === "object"
                          ? (evaluation as Record<string, unknown>)
                          : null;
                      return (
                        <Fragment key={String(run.id)}>
                          <tr data-testid={`quality-run-row-${run.id}`}>
                            <td>#{String(run.id)}</td>
                            <td>
                              <StatusBadge
                                status={String(run.quality_status || run.status || "unknown")}
                                label={monitoringStatusLabel(String(run.quality_status || run.status || "unknown"))}
                              />
                            </td>
                            <td data-testid={`run-policy-rev-${run.id}`}>
                              {run.policy_revision == null ? "—" : String(run.policy_revision)}
                            </td>
                            <td data-testid={`run-matched-preds-${run.id}`}>
                              {matched} / {predictions}
                            </td>
                            <td>
                              {matchRate == null || typeof matchRate !== "number"
                                ? "—"
                                : `${metric(matchRate * 100, 1)}%`}
                            </td>
                            <td data-testid={`run-breached-${run.id}`}>{breachedRuleCount(evaluation)}</td>
                            <td data-testid={`run-evidence-${run.id}`}>{evaluationEvidence(evaluation)}</td>
                            <td>{run.finished_at ? new Date(String(run.finished_at)).toLocaleString() : "—"}</td>
                            <td>
                              <button
                                type="button"
                                className="btn secondary"
                                onClick={() => setExpandedRunId(expanded ? null : run.id)}
                                data-testid={`expand-quality-run-${run.id}`}
                              >
                                {expanded ? "접기" : "상세"}
                              </button>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr data-testid={`quality-run-detail-${run.id}`}>
                              <td colSpan={9}>
                                <dl className="key-values">
                                  <div><dt>품질 평가 실행 번호</dt><dd>#{run.id}</dd></div>
                                  <div><dt>정책 개정 번호</dt><dd>{String(run.policy_revision ?? "—")}</dd></div>
                                  <div><dt>모델 버전 (ModelVersion)</dt><dd>#{String(run.model_version_id ?? "—")}</dd></div>
                                  <div>
                                    <dt>평가 기간</dt>
                                    <dd>
                                      {run.window_start ? new Date(String(run.window_start)).toLocaleString() : "—"}
                                      {" → "}
                                      {run.window_end ? new Date(String(run.window_end)).toLocaleString() : "—"}
                                    </dd>
                                  </div>
                                  <div><dt>정답 연결 / 예측 건수</dt><dd>{matched} / {predictions}</dd></div>
                                  <div>
                                    <dt><TermLabel ko="연결률" en="Match rate" help={UI_HELP.monitoringMatchRate} /></dt>
                                    <dd>
                                      {matchRate == null || typeof matchRate !== "number"
                                        ? "—"
                                        : `${metric(matchRate * 100, 1)}%`}
                                    </dd>
                                  </div>
                                  <div><dt>품질 상태</dt><dd>{monitoringStatusLabel(String(run.quality_status || "unknown"))}</dd></div>
                                  <div>
                                    <dt>평가 데이터 충분 여부</dt>
                                    <dd data-testid={`run-sufficiency-${run.id}`}>
                                      {reasonLabel(
                                        evalObj && typeof evalObj.reason === "string"
                                          ? String(evalObj.reason)
                                          : null,
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>규칙 평가 근거</dt>
                                    <dd>{evaluationEvidence(evaluation)}</dd>
                                  </div>
                                  <div>
                                    <dt>기준 평가 실행 / 모델</dt>
                                    <dd>
                                      {evalObj?.baseline_quality_run_id != null
                                        ? `실행 #${String(evalObj.baseline_quality_run_id)}`
                                        : "—"}
                                      {" / "}
                                      {evalObj?.baseline_model_version_id != null
                                        ? `모델 #${String(evalObj.baseline_model_version_id)}`
                                        : "—"}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>재학습 실행 판단</dt>
                                    <dd data-testid={`run-trigger-${run.id}`}>
                                      {triggerDecisionLabel(
                                        decision && typeof decision.reason === "string"
                                          ? String(decision.reason)
                                          : null,
                                      )}
                                    </dd>
                                  </div>
                                </dl>
                                <details className="advanced-json">
                                  <summary>고급 정보 (JSON)</summary>
                                  <pre className="code-block">{JSON.stringify({ evaluation: evalObj, trigger_decision: decision }, null, 2)}</pre>
                                </details>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="row-actions" data-testid="quality-history-pagination">
              <button
                type="button"
                className="btn secondary"
                disabled={historySkip <= 0 || historyLoading}
                onClick={() => setHistorySkip((prev) => Math.max(0, prev - HISTORY_PAGE_SIZE))}
                data-testid="quality-history-prev"
              >
                이전
              </button>
              <span className="muted">
                {qualityRunTotal === 0
                  ? "평가 이력 0건"
                  : `전체 ${qualityRunTotal}건 중 ${historySkip + 1}–${Math.min(historySkip + HISTORY_PAGE_SIZE, qualityRunTotal)}건`}
              </span>
              <button
                type="button"
                className="btn secondary"
                disabled={historySkip + HISTORY_PAGE_SIZE >= qualityRunTotal || historyLoading}
                onClick={() => setHistorySkip((prev) => prev + HISTORY_PAGE_SIZE)}
                data-testid="quality-history-next"
              >
                다음
              </button>
            </div>
          </DetailSection>

          <div className="two-column">
            <DetailSection
              eyebrow="데이터"
              title="데이터 품질 상태 (Data Health)"
              testId="monitoring-data"
              actions={(
                <span className="row-actions">
                  <StatusBadge
                    status={data.latest_quality_status || "unknown"}
                    label={monitoringStatusLabel(data.latest_quality_status)}
                  />
                  <HelpTip text={UI_HELP.monitoringDataHealth} />
                </span>
              )}
            >
              <dl className="key-values">
                <div><dt>데이터셋</dt><dd>{data.dataset_count}</dd></div>
                <div><dt>데이터셋 버전</dt><dd>{data.dataset_version_count}</dd></div>
                <div><dt>품질 검사</dt><dd>{data.quality_check_count}</dd></div>
                <div><dt>실패한 검사</dt><dd>{data.failed_quality_check_count}</dd></div>
              </dl>
              {!data.latest_quality_status && (
                <p className="muted" data-testid="monitoring-data-unknown-help">
                  {data.quality_check_count === 0
                    ? "상태 미확인은 오류가 아닙니다. 아직 품질 검사를 실행하지 않아 판정할 결과가 없습니다. 데이터셋 버전에서 품질 검사를 실행하세요."
                    : "최근 품질 검사 판정이 제공되지 않아 상태를 확인할 수 없습니다. 검사 실행 이력을 확인해 주세요."}
                </p>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/datasets`}>데이터셋 열기</Link>
              </div>
            </DetailSection>

            <DetailSection
              eyebrow="모델"
              title="모델 상태 (Model Health)"
              testId="monitoring-models"
              actions={(
                <span className="row-actions">
                  <StatusBadge
                    status={models.latest_drift_status || "unknown"}
                    label={monitoringStatusLabel(models.latest_drift_status)}
                  />
                  <HelpTip text={UI_HELP.monitoringModelHealth} />
                </span>
              )}
            >
              <dl className="key-values">
                <div><dt>모델 버전</dt><dd>{models.model_version_count}</dd></div>
                <div><dt>배포 준비 완료</dt><dd>{models.ready_endpoint_count} / {models.endpoint_count}</dd></div>
                <div><dt>전체 예측 요청</dt><dd>{models.total_requests.toLocaleString()}</dd></div>
                <div><dt>전체 예측 오류</dt><dd>{models.total_errors.toLocaleString()}</dd></div>
              </dl>
              {!models.latest_drift_status && (
                <p className="muted" data-testid="monitoring-model-unknown-help">
                  상태 미확인은 배포 장애를 뜻하지 않습니다. 최근 데이터 분포 변화(Drift) 평가 결과가 없어 판정할 수 없습니다.
                  배포 준비 상태와 예측 오류는 위의 별도 지표를 확인하세요.
                </p>
              )}
              <div className="tag-list">
                {Object.entries(models.lifecycle_counts).map(([name, count]) => (
                  <span key={name}>{modelLifecycleLabelKo(name)} · {count}</span>
                ))}
              </div>
              <div className="row-actions">
                <Link to={`/projects/${projectId}/registry`}>모델 등록소 열기</Link>
                <Link to={`/projects/${projectId}/deployments`}>배포 관리 열기</Link>
              </div>
            </DetailSection>
          </div>
        </>
      )}
    </div>
  );
}
