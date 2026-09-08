import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
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

export default function Monitoring() {
  const { projectId } = useParams();
  const [service, setService] = useState<ServiceMetrics | null>(null);
  const [data, setData] = useState<DataMetrics | null>(null);
  const [models, setModels] = useState<ModelMetrics | null>(null);
  const [hours, setHours] = useState("24");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([
      api<ServiceMetrics>(`/projects/${projectId}/monitoring/service?hours=${hours}`),
      api<DataMetrics>(`/projects/${projectId}/monitoring/data`),
      api<ModelMetrics>(`/projects/${projectId}/monitoring/models`),
    ]).then(([serviceRows, dataRows, modelRows]) => {
      setService(serviceRows);
      setData(dataRows);
      setModels(modelRows);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Monitoring metrics could not be loaded."))
      .finally(() => setLoading(false));
  }, [hours, projectId]);

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
