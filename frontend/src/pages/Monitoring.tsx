import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  metric,
} from "../components";

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

  return <div>
    <PageHeader title="Monitoring" description="Service health, data quality, and model lifecycle signals." actions={<label className="header-filter">Window<select value={hours} onChange={(event) => setHours(event.target.value)}><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select></label>} />
    <ErrorNotice message={error} />
    {loading || !service || !data || !models ? <Loading label="Loading monitoring metrics" /> : <>
      <section>
        <div className="section-heading"><div><span className="eyebrow">Prediction services</span><h2>Service health</h2></div></div>
        <div className="grid stats-grid">
          <div className="stat"><div className="label">Requests</div><div className="value">{service.request_count.toLocaleString()}</div></div>
          <div className="stat"><div className="label">Success rate</div><div className="value">{service.success_rate === null ? "—" : `${metric(service.success_rate * 100, 1)}%`}</div></div>
          <div className="stat"><div className="label">Average latency</div><div className="value metric-value">{metric(service.average_latency_ms, 1)} ms</div></div>
          <div className="stat"><div className="label">p95 latency</div><div className="value metric-value">{metric(service.p95_latency_ms, 1)} ms</div></div>
        </div>
        <div className="panel">
          {service.series.length === 0 ? <EmptyState title="No prediction traffic" description="Service metrics appear after a deployment receives prediction requests." /> : <div className="bar-chart" aria-label="Requests over time">{service.series.map((point) => <div className="bar-column" key={point.timestamp} title={`${point.requests} requests`}><div className="bar" style={{ height: `${Math.max(4, (point.requests / maxRequests) * 100)}%` }} /><span>{new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit" })}</span></div>)}</div>}
        </div>
      </section>
      <div className="two-column">
        <section className="panel"><div className="panel-title"><div><span className="eyebrow">Data</span><h2>Data health</h2></div><StatusBadge status={data.latest_quality_status || "unknown"} /></div><dl className="key-values"><div><dt>Datasets</dt><dd>{data.dataset_count}</dd></div><div><dt>Versions</dt><dd>{data.dataset_version_count}</dd></div><div><dt>Quality checks</dt><dd>{data.quality_check_count}</dd></div><div><dt>Failed checks</dt><dd>{data.failed_quality_check_count}</dd></div></dl>{data.quality_check_count === 0 && <p className="muted">Run quality checks from a dataset version to establish a health signal.</p>}</section>
        <section className="panel"><div className="panel-title"><div><span className="eyebrow">Models</span><h2>Model operations</h2></div><StatusBadge status={models.latest_drift_status || "unknown"} /></div><dl className="key-values"><div><dt>Model versions</dt><dd>{models.model_version_count}</dd></div><div><dt>Ready deployments</dt><dd>{models.ready_endpoint_count} / {models.endpoint_count}</dd></div><div><dt>Total requests</dt><dd>{models.total_requests.toLocaleString()}</dd></div><div><dt>Total errors</dt><dd>{models.total_errors.toLocaleString()}</dd></div></dl><div className="tag-list">{Object.entries(models.lifecycle_counts).map(([name, count]) => <span key={name}>{name.replaceAll("_", " ")} · {count}</span>)}</div></section>
      </div>
    </>}
  </div>;
}
