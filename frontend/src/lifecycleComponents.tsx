import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { HelpTip, StatusBadge } from "./components";
import {
  formatMetricLabel,
  formatPrimaryMetric,
  metricHelpText,
  selectPrimaryMetric,
} from "./metricHelpers";
import {
  lifecycleStepperStates,
  type LineageItem,
} from "./lifecycleHelpers";
import {
  formatModelMetricLabelKo,
  gateLabelKo,
  modelMetricDisplayKo,
  modelGateStatusKo,
  modelLifecycleLabelKo,
  parseModelForecastTargetKo,
} from "./modelRegistryLabels";

export function TargetChips({
  targets,
  testId,
  koreanForecast = false,
}: {
  targets: string[];
  testId?: string;
  /** Opt-in for the Korean Model Version detail; other callers stay unchanged. */
  koreanForecast?: boolean;
}) {
  if (targets.length === 0) {
    return <span data-testid={testId}>—</span>;
  }
  return (
    <ul className="target-chips" data-testid={testId}>
      {targets.map((target) => {
        const forecast = koreanForecast ? parseModelForecastTargetKo(target) : undefined;
        return (
          <li key={target} className="target-chip" title={forecast ? target : undefined}>
            {forecast ? `${forecast.step}단계 후 예측 · ${forecast.targetName}` : target}
          </li>
        );
      })}
    </ul>
  );
}

export function LifecycleStepper({ lifecycle, korean = false }: { lifecycle: string; korean?: boolean }) {
  const steps = lifecycleStepperStates(lifecycle);
  return (
    <ol className="lifecycle-stepper" data-testid="lifecycle-stepper" aria-label={korean ? "모델 상태 진행 단계" : "Model lifecycle"}>
      {steps.map((step) => (
        <li
          key={step.id}
          className={`lifecycle-step is-${step.state}`}
          data-state={step.state}
          aria-current={step.state === "current" || step.state === "rejected" ? "step" : undefined}
        >
          <span className="lifecycle-step-marker" aria-hidden="true">
            {step.state === "complete" ? "✓"
              : step.state === "rejected" ? "!"
                : step.state === "current" ? "●"
                  : "○"}
          </span>
          <span className="lifecycle-step-label">{korean ? modelLifecycleLabelKo(step.id) : step.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function DetailSection({
  eyebrow,
  title,
  children,
  actions,
  testId,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="panel detail-section" data-testid={testId}>
      <div className="panel-title">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EntityLineage({
  items,
  eyebrow = "Lineage",
  title = "ML lifecycle path",
}: {
  items: LineageItem[];
  /** Optional display-only section eyebrow. Defaults preserve existing English callers. */
  eyebrow?: string;
  /** Optional display-only section title. Defaults preserve existing English callers. */
  title?: string;
}) {
  return (
    <DetailSection eyebrow={eyebrow} title={title} testId="entity-lineage">
      <ol className="entity-lineage">
        {items.map((item) => (
          <li key={`${item.label}-${item.value}`}>
            <span className="entity-lineage-label">{item.label}</span>
            {item.to ? (
              <Link to={item.to} className={item.mono ? "mono" : undefined}>
                {item.value}
              </Link>
            ) : (
              <span className={item.mono ? "mono break-word" : undefined}>{item.value}</span>
            )}
          </li>
        ))}
      </ol>
    </DetailSection>
  );
}

export function MetricSummary({
  metrics,
  problemType,
  targetColumns = [],
  limit = 6,
  showMetricHelp = false,
  labels,
  korean = false,
}: {
  metrics: Record<string, number>;
  problemType?: string;
  targetColumns?: string[];
  limit?: number;
  /** When true, each metric card shows a per-metric HelpTip. Default keeps other screens unchanged. */
  showMetricHelp?: boolean;
  /** Korean presentation is opt-in to avoid changing other screens. */
  korean?: boolean;
  /** Optional display-only copy overrides. Defaults preserve existing English callers. */
  labels?: {
    emptyTitle?: string;
    emptyHint?: string;
    primaryPrefix?: string;
  };
}) {
  const emptyTitle = labels?.emptyTitle ?? "Metrics";
  const emptyHint = labels?.emptyHint ?? "Available after training";
  const primaryPrefix = labels?.primaryPrefix ?? "Primary:";
  const metricLabel = korean ? formatModelMetricLabelKo : formatMetricLabel;
  const entries = Object.entries(metrics);
  if (entries.length === 0) {
    return (
      <div className="stat">
        <div className="label">{emptyTitle}</div>
        <div className="value metric-value">—</div>
        <small>{emptyHint}</small>
      </div>
    );
  }

  const primary = selectPrimaryMetric(metrics, {
    problemType,
    preferAggregate: true,
  });
  const ordered = primary
    ? [
        [primary.key, primary.value] as const,
        ...entries.filter(([key]) => key !== primary.key),
      ]
    : entries;

  return (
    <div className="grid stats-grid" data-testid="metric-summary">
      {ordered.slice(0, limit).map(([name, value]) => {
        const metricDisplay = korean ? modelMetricDisplayKo(name, targetColumns) : null;
        const metricTitle = metricLabel(name, targetColumns);
        const renderedLabel = metricDisplay ? (
          <div className="model-metric-label">
            <span className="model-metric-kind">
              {[metricDisplay.scope, metricDisplay.metric].filter(Boolean).join(" · ")}
            </span>
            {metricDisplay.target && (
              <span className="model-metric-target" title={metricDisplay.target}>
                {metricDisplay.forecast ? (
                  <>
                    <span className="model-metric-horizon">
                      {metricDisplay.forecast.step}단계 후 예측
                    </span>
                    <span className="model-metric-target-name">
                      대상: {metricDisplay.forecast.targetName}
                    </span>
                  </>
                ) : (
                  <>예측 대상: {metricDisplay.target}</>
                )}
              </span>
            )}
          </div>
        ) : metricTitle;
        return (
          <div className="stat" key={name} data-testid={`metric-card-${name}`}>
            {showMetricHelp ? (
              <div className="stat-label-row">
                <div className="label" title={metricTitle}>{renderedLabel}</div>
                <HelpTip text={metricHelpText(name)} />
              </div>
            ) : (
              <div className="label" title={metricTitle}>{renderedLabel}</div>
            )}
            <div className="value metric-value">{Number(value).toFixed(3)}</div>
          </div>
        );
      })}
      {primary && (
        <p className="form-hint metric-primary-hint" data-testid="metric-primary-hint">
          {primaryPrefix} {korean
            ? `${metricLabel(primary.key, targetColumns)}: ${Number(primary.value).toFixed(3)}`
            : formatPrimaryMetric(metrics, { problemType, targetColumns })}
        </p>
      )}
    </div>
  );
}

export function GateSummary({
  gatesPassed,
  gateResults,
  korean = false,
  targetColumns = [],
}: {
  gatesPassed: boolean;
  gateResults: Record<string, unknown>;
  korean?: boolean;
  targetColumns?: string[];
}) {
  const rows = Array.isArray(gateResults.results)
    ? gateResults.results.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
  return (
    <div className="gate-summary" data-testid="gate-summary">
      <div className="row-actions">
        <StatusBadge
          status={gatesPassed ? "passed" : "pending"}
          label={korean ? modelGateStatusKo(gatesPassed) : undefined}
        />
        <span className="form-hint">
          {korean
            ? gatesPassed
              ? "설정된 검증 항목을 모두 통과했습니다. 실제 운영 적합성은 별도로 판단해야 합니다."
              : "승인을 요청하려면 확인이 필요한 검증 항목을 해결해야 합니다."
            : gatesPassed
              ? "Validation gates passed."
              : "Validation gates require attention before approval."}
        </span>
      </div>
      {korean && rows.length > 0 && (
        <div className="gate-checklist" role="list" aria-label="항목별 검증 결과">
          {rows.map((row, index) => {
            const type = String(row.type ?? "unknown");
            const passed = row.passed === true;
            const label = gateLabelKo(type);
            const observed = row.observed;
            const expected = row.expected;
            const obs = observed && typeof observed === "object" && !Array.isArray(observed)
              ? observed as Record<string, unknown> : {};
            const exp = expected && typeof expected === "object" && !Array.isArray(expected)
              ? expected as Record<string, unknown> : {};
            const schema = Array.isArray(observed) ? observed : [];
            const latency = typeof obs.latency_ms === "number" ? obs.latency_ms : null;
            const limit = typeof exp.maximum_ms === "number" ? exp.maximum_ms : null;
            return (
              <div className="gate-checklist-item" role="listitem" key={`${type}-${index}`}>
                <div className="gate-checklist-title">
                  <strong>{label.name}</strong>
                  <HelpTip text={label.help} />
                  <StatusBadge status={passed ? "passed" : "failed"} label={passed ? "통과" : "실패"} />
                </div>
                <p className="form-hint">{label.help}</p>
                {type === "inference_latency" && latency != null && (
                  <small>실측 {latency.toFixed(1)}ms{limit != null ? ` / 허용 ${limit.toLocaleString("ko-KR")}ms` : ""}</small>
                )}
                {type === "metric_threshold" && typeof obs.metric === "string" && typeof obs.value === "number" && (
                  <div className="gate-policy-metric" data-testid="gate-policy-metric">
                    <small>검증 정책 지표: {formatModelMetricLabelKo(obs.metric, targetColumns)} · 측정값: {obs.value.toFixed(3)}</small>
                    <small className="form-hint">이 값은 검증 정책에 지정된 지표로, 위의 모델 대표 지표나 예측 대상별 지표와 다를 수 있습니다.</small>
                  </div>
                )}
                {type === "test_inference" && typeof obs.prediction_count === "number" && (
                  <small>예측 성공: {obs.prediction_count}건</small>
                )}
                {type === "schema_present" && schema.length > 0 && (
                  <details>
                    <summary>입력 컬럼 {schema.length}개 확인</summary>
                    <ul className="gate-schema-list">
                      {schema.map((feature, featureIndex) => {
                        const item = feature && typeof feature === "object" && !Array.isArray(feature)
                          ? feature as Record<string, unknown> : {};
                        return <li key={`${String(item.name ?? featureIndex)}-${featureIndex}`}>
                          <code>{String(item.name ?? "—")}</code> · {String(item.dtype ?? "자료형 미상")}
                        </li>;
                      })}
                    </ul>
                  </details>
                )}
                {!passed && <small>실패 원인은 아래 기술 상세 정보에서 확인할 수 있습니다.</small>}
              </div>
            );
          })}
        </div>
      )}
      <details className="advanced-json">
        <summary>{korean ? "기술 상세 정보(JSON)" : "Gate details"}</summary>
        <pre className="json-view" data-testid="gate-results">
          {JSON.stringify(gateResults, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function TechnicalBlock({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="technical-block" data-testid={testId}>
      {children}
    </div>
  );
}
