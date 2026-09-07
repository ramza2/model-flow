import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "./components";
import {
  formatMetricLabel,
  formatPrimaryMetric,
  selectPrimaryMetric,
} from "./metricHelpers";
import {
  lifecycleStepperStates,
  type LineageItem,
} from "./lifecycleHelpers";

export function TargetChips({
  targets,
  testId,
}: {
  targets: string[];
  testId?: string;
}) {
  if (targets.length === 0) {
    return <span data-testid={testId}>—</span>;
  }
  return (
    <ul className="target-chips" data-testid={testId}>
      {targets.map((target) => (
        <li key={target} className="target-chip">
          {target}
        </li>
      ))}
    </ul>
  );
}

export function LifecycleStepper({ lifecycle }: { lifecycle: string }) {
  const steps = lifecycleStepperStates(lifecycle);
  return (
    <ol className="lifecycle-stepper" data-testid="lifecycle-stepper" aria-label="Model lifecycle">
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
          <span className="lifecycle-step-label">{step.label}</span>
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

export function EntityLineage({ items }: { items: LineageItem[] }) {
  return (
    <DetailSection eyebrow="Lineage" title="ML lifecycle path" testId="entity-lineage">
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
}: {
  metrics: Record<string, number>;
  problemType?: string;
  targetColumns?: string[];
  limit?: number;
}) {
  const entries = Object.entries(metrics);
  if (entries.length === 0) {
    return (
      <div className="stat">
        <div className="label">Metrics</div>
        <div className="value metric-value">—</div>
        <small>Available after training</small>
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
      {ordered.slice(0, limit).map(([name, value]) => (
        <div className="stat" key={name}>
          <div className="label">{formatMetricLabel(name, targetColumns)}</div>
          <div className="value metric-value">{Number(value).toFixed(3)}</div>
        </div>
      ))}
      {primary && (
        <p className="form-hint metric-primary-hint" data-testid="metric-primary-hint">
          Primary: {formatPrimaryMetric(metrics, { problemType, targetColumns })}
        </p>
      )}
    </div>
  );
}

export function GateSummary({
  gatesPassed,
  gateResults,
}: {
  gatesPassed: boolean;
  gateResults: Record<string, unknown>;
}) {
  return (
    <div className="gate-summary" data-testid="gate-summary">
      <div className="row-actions">
        <StatusBadge status={gatesPassed ? "passed" : "pending"} />
        <span className="form-hint">
          {gatesPassed
            ? "Validation gates passed."
            : "Validation gates require attention before approval."}
        </span>
      </div>
      <details className="advanced-json">
        <summary>Gate details</summary>
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
