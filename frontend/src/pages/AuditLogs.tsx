import { type FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type AuditEvent } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";

export default function AuditLogs() {
  const { projectId } = useParams();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    const base = projectId ? `/projects/${projectId}/audit` : "/admin/audit";
    api<AuditEvent[]>(`${base}${query}`)
      .then(setEvents)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Audit logs could not be loaded."))
      .finally(() => setLoading(false));
  }, [projectId, query]);

  function filter(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (resourceType) params.set("resource_type", resourceType);
    if (dateFrom) params.set("date_from", new Date(`${dateFrom}T00:00:00`).toISOString());
    const value = params.toString();
    setQuery(value ? `?${value}` : "");
  }

  return (
    <div className="page-stack ops-page audit-logs-page">
      <PageHeader
        title={projectId ? "Audit Logs" : "Global Audit Logs"}
        description={
          projectId
            ? "Review security and lifecycle events for this project."
            : "Review system-wide security and administration events."
        }
      />
      <ErrorNotice message={error} />
      <form className="filter-bar catalog-filter filter-form audit-filter-toolbar" onSubmit={filter}>
        <label>
          Action
          <input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="e.g. model.approve"
          />
        </label>
        <label>
          Resource
          <select value={resourceType} onChange={(event) => setResourceType(event.target.value)}>
            <option value="">All resources</option>
            <option value="project">Project</option>
            <option value="dataset">Dataset</option>
            <option value="training_job">Training job</option>
            <option value="model_version">Model version</option>
            <option value="endpoint">Deployment</option>
            <option value="user">User</option>
          </select>
        </label>
        <label>
          From
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <button className="btn" type="submit">
          Apply filters
        </button>
      </form>
      {loading ? (
        <Loading label="Loading audit events" />
      ) : events.length === 0 ? (
        <EmptyState
          title="No matching audit events"
          description="Adjust the filters or perform an action in this scope."
        />
      ) : (
        <div className="panel table-wrap catalog-table audit-catalog-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Outcome</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className={event.success ? undefined : "is-failed"}>
                  <td className="catalog-meta-date">{formatDate(event.created_at)}</td>
                  <td>{event.user_email || "System"}</td>
                  <td className="mono">{event.action}</td>
                  <td>
                    {event.resource_type.replaceAll("_", " ")}{" "}
                    {event.resource_id ? <span className="mono">#{event.resource_id}</span> : null}
                  </td>
                  <td>
                    <StatusBadge status={event.success ? "succeeded" : "failed"} />
                    {event.failure_reason ? (
                      <small className="table-subtitle break-word">{event.failure_reason}</small>
                    ) : null}
                  </td>
                  <td className="mono audit-detail-cell">#{event.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
