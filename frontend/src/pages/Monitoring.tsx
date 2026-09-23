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
  Loading,
  PageHeader,
  StatusBadge,
  metric,
} from "../components";
import { DetailSection } from "../lifecycleComponents";
import { buildMonitoringAttention } from "../operationsHelpers";

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
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Monitoring metrics could not be loaded."))
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
    <div className="ops-page">
      <PageHeader
        title="Monitoring"
        description="Operational triage for service traffic, data quality, and model serving signals."
        actions={(
          <label className="header-filter">
            Window
            <select value={hours} onChange={(event) => setHours(event.target.value)} data-testid="monitoring-window">
              <option value="24">Last 24 hours</option>
              <option value="168">Last 7 days</option>
              <option value="720">Last 30 days</option>
            </select>
          </label>
        )}
      />
      <ErrorNotice message={error} />
      {loading || !service || !data || !models ? (
        <Loading label="Loading monitoring metrics" />
      ) : (
        <>
          <section className="panel ops-attention-panel" data-testid="monitoring-attention">
            <span className="eyebrow">Attention</span>
            {attention.length === 0 ? (
              <p className="muted">
                No attention signals from current metrics
                ({service.error_count} service errors, {data.failed_quality_check_count} failed quality checks,
                {" "}{models.ready_endpoint_count}/{models.endpoint_count} deployments ready).
              </p>
            ) : (
              <ul className="ops-signal-list">
                {attention.map((item) => (
                  <li key={item.id}>
                    {item.to ? <Link to={item.to}>{item.label}</Link> : item.label}
                  </li>
                ))}
              </ul>
            )}
            <div className="row-actions">
              <Link to={`/projects/${projectId}/alerts`}>Open alerts</Link>
              <Link to={`/projects/${projectId}/deployments`}>Deployments</Link>
              <Link to={`/projects/${projectId}/datasets`}>Datasets</Link>
              <Link to={`/projects/${projectId}/registry`}>Model registry</Link>
            </div>
          </section>

          <DetailSection eyebrow="Service" title="Service health" testId="monitoring-service">
            <div className="grid stats-grid">
              <div className="stat"><div className="label">Requests</div><div className="value">{service.request_count.toLocaleString()}</div></div>
              <div className="stat"><div className="label">Successes</div><div className="value">{service.success_count.toLocaleString()}</div></div>
              <div className={`stat${service.error_count > 0 ? " is-attention" : ""}`}><div className="label">Errors</div><div className="value">{service.error_count.toLocaleString()}</div></div>
              <div className="stat"><div className="label">Success rate</div><div className="value">{service.success_rate === null ? "—" : `${metric(service.success_rate * 100, 1)}%`}</div></div>
              <div className="stat"><div className="label">Average latency</div><div className="value metric-value">{metric(service.average_latency_ms, 1)} ms</div></div>
              <div className="stat"><div className="label">p95 latency</div><div className="value metric-value">{metric(service.p95_latency_ms, 1)} ms</div></div>
            </div>
            <div className="panel nested-panel">
              {service.series.length === 0 ? (
                <EmptyState
                  title="No prediction traffic"
                  description="Service metrics appear after a deployment receives prediction requests."
                />
              ) : (
                <div className="bar-chart" aria-label="Requests over time">
                  {service.series.map((point) => (
                    <div className="bar-column" key={point.timestamp} title={`${point.requests} requests`}>
                      <div className="bar" style={{ height: `${Math.max(4, (point.requests / maxRequests) * 100)}%` }} />
                      <span>{new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit" })}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DetailSection>

          <DetailSection
            eyebrow="Models"
            title="Production Quality"
            testId="monitoring-production-quality"
            actions={(
              <Link to={`/projects/${projectId}/model-quality/policies`} data-testid="quality-policies-link">
                Quality policies
              </Link>
            )}
          >
            {qualityCards.length === 0 ? (
              <EmptyState
                title="No production quality policies"
                description="Create a model quality policy to evaluate prediction vs ground-truth and drive closed-loop retraining to CANDIDATE."
                action={(
                  <Link to={`/projects/${projectId}/model-quality/policies`} className="btn">
                    Open quality policies
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
                    <div className="panel nested-panel" key={card.policy_id} data-testid={`quality-card-${card.policy_id}`}>
                      <div className="row-actions">
                        <strong>{card.endpoint_name || `Endpoint #${card.endpoint_id}`}</strong>
                        <StatusBadge status={card.latest_quality_status || "unknown"} />
                        {card.baseline_required ? (
                          <span className="notice notice-warning" data-testid={`baseline-required-${card.policy_id}`}>
                            Baseline required
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
                            Trigger: {triggerDecisionLabel(decisionReason)}
                          </p>
                        ) : null}
                      </div>
                      <dl className="key-values">
                        <div>
                          <dt>Current model</dt>
                          <dd>
                            {card.current_model_name
                              ? `${card.current_model_name} v${card.current_model_version}`
                              : "—"}
                          </dd>
                        </div>
                        {advanced ? (
                          <>
                            <div>
                              <dt>Revision</dt>
                              <dd data-testid={`quality-revision-${card.policy_id}`}>{card.revision ?? "—"}</dd>
                            </div>
                            <div>
                              <dt>Rules</dt>
                              <dd data-testid={`quality-rule-count-${card.policy_id}`}>
                                {card.rule_count ?? 0} · {(card.rule_logic || "any").toUpperCase()}
                              </dd>
                            </div>
                            <div>
                              <dt>Baseline run</dt>
                              <dd data-testid={`quality-baseline-${card.policy_id}`}>
                                {card.baseline_quality_run_id == null
                                  ? "—"
                                  : `#${card.baseline_quality_run_id}`}
                              </dd>
                            </div>
                            <div>
                              <dt>Evaluation delay</dt>
                              <dd>{card.evaluation_delay_hours ?? 0}h</dd>
                            </div>
                            <div>
                              <dt>Minimum match rate</dt>
                              <dd data-testid={`match-rate-min-${card.policy_id}`}>
                                {card.minimum_match_rate == null
                                  ? "—"
                                  : `${metric(card.minimum_match_rate * 100, 1)}%`}
                              </dd>
                            </div>
                            <div>
                              <dt>Latest status</dt>
                              <dd>{card.latest_quality_status || "—"}</dd>
                            </div>
                          </>
                        ) : (
                          <div>
                            <dt>Primary metric</dt>
                            <dd>
                              {card.primary_metric}
                              {card.primary_metric_value == null ? "" : ` = ${metric(card.primary_metric_value, 4)}`}
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>Matched ground truth</dt>
                          <dd data-testid={`matched-gt-${card.policy_id}`}>{card.matched_ground_truth_count}</dd>
                        </div>
                        <div>
                          <dt>Predictions</dt>
                          <dd>{card.prediction_count}</dd>
                        </div>
                        <div>
                          <dt>Match rate</dt>
                          <dd data-testid={`match-rate-${card.policy_id}`}>
                            {card.match_rate == null ? "—" : `${metric(card.match_rate * 100, 1)}%`}
                          </dd>
                        </div>
                        <div>
                          <dt>Last evaluated</dt>
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
                            Open current model
                          </Link>
                        ) : null}
                        <Link
                          to={`/projects/${projectId}/feedback?endpoint_id=${card.endpoint_id}`}
                          data-testid={`review-feedback-${card.endpoint_id}`}
                        >
                          Review feedback
                        </Link>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => openHistoryForCard(card)}
                          data-testid={`view-quality-history-${card.policy_id}`}
                        >
                          View quality history
                        </button>
                        <Link
                          to={`/projects/${projectId}/model-quality/policies`}
                          data-testid={`manage-policy-${card.policy_id}`}
                        >
                          Manage policy
                        </Link>
                        <Link to={`/projects/${projectId}/alerts`}>Open alerts</Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DetailSection>

          <DetailSection eyebrow="Models" title="Quality history" testId="monitoring-quality-trend">
            <div className="row-actions" data-testid="quality-history-filters">
              <label>
                Endpoint
                <select
                  value={historyEndpointId}
                  onChange={(event) => {
                    setHistoryEndpointId(event.target.value);
                    setHistoryPolicyId("");
                    setHistorySkip(0);
                  }}
                  data-testid="quality-history-endpoint-filter"
                >
                  <option value="">All</option>
                  {historyEndpoints.map(([id, name]) => (
                    <option key={id} value={String(id)}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                Policy
                <select
                  value={historyPolicyId}
                  onChange={(event) => {
                    setHistoryPolicyId(event.target.value);
                    setHistorySkip(0);
                  }}
                  data-testid="quality-history-policy-filter"
                >
                  <option value="">All</option>
                  {historyPolicies.map((policy) => (
                    <option key={policy.id} value={String(policy.id)}>{policy.name}</option>
                  ))}
                </select>
              </label>
            </div>
            {historyLoading ? <Loading label="Loading quality history" /> : null}
            {!historyLoading && qualityRuns.length === 0 ? (
              <p className="muted">No quality runs match the current filters.</p>
            ) : null}
            {!historyLoading && qualityRuns.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Status</th>
                      <th>Policy rev</th>
                      <th>Matched / Predictions</th>
                      <th>Match rate</th>
                      <th>Breached rules</th>
                      <th>Evidence</th>
                      <th>Finished</th>
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
                            <td><StatusBadge status={String(run.quality_status || run.status || "unknown")} /></td>
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
                                className="btn btn-secondary"
                                onClick={() => setExpandedRunId(expanded ? null : run.id)}
                                data-testid={`expand-quality-run-${run.id}`}
                              >
                                {expanded ? "Hide" : "Details"}
                              </button>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr data-testid={`quality-run-detail-${run.id}`}>
                              <td colSpan={9}>
                                <dl className="key-values">
                                  <div><dt>Quality Run ID</dt><dd>#{run.id}</dd></div>
                                  <div><dt>Policy revision</dt><dd>{String(run.policy_revision ?? "—")}</dd></div>
                                  <div><dt>ModelVersion</dt><dd>#{String(run.model_version_id ?? "—")}</dd></div>
                                  <div>
                                    <dt>Window</dt>
                                    <dd>
                                      {run.window_start ? new Date(String(run.window_start)).toLocaleString() : "—"}
                                      {" → "}
                                      {run.window_end ? new Date(String(run.window_end)).toLocaleString() : "—"}
                                    </dd>
                                  </div>
                                  <div><dt>Matched / Predictions</dt><dd>{matched} / {predictions}</dd></div>
                                  <div>
                                    <dt>Match rate</dt>
                                    <dd>
                                      {matchRate == null || typeof matchRate !== "number"
                                        ? "—"
                                        : `${metric(matchRate * 100, 1)}%`}
                                    </dd>
                                  </div>
                                  <div><dt>Quality status</dt><dd>{String(run.quality_status || "—")}</dd></div>
                                  <div>
                                    <dt>Sufficiency reason</dt>
                                    <dd data-testid={`run-sufficiency-${run.id}`}>
                                      {reasonLabel(
                                        evalObj && typeof evalObj.reason === "string"
                                          ? String(evalObj.reason)
                                          : null,
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Rule evidence</dt>
                                    <dd>{evaluationEvidence(evaluation)}</dd>
                                  </div>
                                  <div>
                                    <dt>Baseline run / model</dt>
                                    <dd>
                                      {evalObj?.baseline_quality_run_id != null
                                        ? `Run #${String(evalObj.baseline_quality_run_id)}`
                                        : "—"}
                                      {" / "}
                                      {evalObj?.baseline_model_version_id != null
                                        ? `Model #${String(evalObj.baseline_model_version_id)}`
                                        : "—"}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Trigger decision</dt>
                                    <dd data-testid={`run-trigger-${run.id}`}>
                                      {triggerDecisionLabel(
                                        decision && typeof decision.reason === "string"
                                          ? String(decision.reason)
                                          : null,
                                      )}
                                    </dd>
                                  </div>
                                </dl>
                                <details>
                                  <summary>Advanced JSON</summary>
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
                className="btn btn-secondary"
                disabled={historySkip <= 0 || historyLoading}
                onClick={() => setHistorySkip((prev) => Math.max(0, prev - HISTORY_PAGE_SIZE))}
                data-testid="quality-history-prev"
              >
                Previous
              </button>
              <span className="muted">
                {qualityRunTotal === 0
                  ? "0 runs"
                  : `${historySkip + 1}–${Math.min(historySkip + HISTORY_PAGE_SIZE, qualityRunTotal)} of ${qualityRunTotal}`}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={historySkip + HISTORY_PAGE_SIZE >= qualityRunTotal || historyLoading}
                onClick={() => setHistorySkip((prev) => prev + HISTORY_PAGE_SIZE)}
                data-testid="quality-history-next"
              >
                Next
              </button>
            </div>
          </DetailSection>

          <div className="two-column">
            <DetailSection
              eyebrow="Data"
              title="Data health"
              testId="monitoring-data"
              actions={<StatusBadge status={data.latest_quality_status || "unknown"} />}
            >
              <dl className="key-values">
                <div><dt>Datasets</dt><dd>{data.dataset_count}</dd></div>
                <div><dt>Versions</dt><dd>{data.dataset_version_count}</dd></div>
                <div><dt>Quality checks</dt><dd>{data.quality_check_count}</dd></div>
                <div><dt>Failed checks</dt><dd>{data.failed_quality_check_count}</dd></div>
              </dl>
              {data.quality_check_count === 0 && (
                <p className="muted">Run quality checks from a dataset version to establish a health signal.</p>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/datasets`}>Open datasets</Link>
              </div>
            </DetailSection>

            <DetailSection
              eyebrow="Model"
              title="Model health"
              testId="monitoring-models"
              actions={<StatusBadge status={models.latest_drift_status || "unknown"} />}
            >
              <dl className="key-values">
                <div><dt>Model versions</dt><dd>{models.model_version_count}</dd></div>
                <div><dt>Ready deployments</dt><dd>{models.ready_endpoint_count} / {models.endpoint_count}</dd></div>
                <div><dt>Total requests</dt><dd>{models.total_requests.toLocaleString()}</dd></div>
                <div><dt>Total errors</dt><dd>{models.total_errors.toLocaleString()}</dd></div>
              </dl>
              <div className="tag-list">
                {Object.entries(models.lifecycle_counts).map(([name, count]) => (
                  <span key={name}>{name.replaceAll("_", " ")} · {count}</span>
                ))}
              </div>
              <div className="row-actions">
                <Link to={`/projects/${projectId}/registry`}>Open registry</Link>
                <Link to={`/projects/${projectId}/deployments`}>Open deployments</Link>
              </div>
            </DetailSection>
          </div>
        </>
      )}
    </div>
  );
}
