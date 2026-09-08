import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Alert } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";
import { userCanProject, useProject } from "../ProjectContext";

type AlertFilter = "open" | "resolved" | "all";

function parseFilter(value: string | null): AlertFilter {
  if (value === "resolved" || value === "all" || value === "open") return value;
  return "open";
}

export default function Alerts() {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [filter, setFilter] = useState<AlertFilter>(() => parseFilter(searchParams.get("filter")));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canResolve = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const load = useCallback(async () => {
    const query = filter === "open" ? "?is_resolved=false" : filter === "resolved" ? "?is_resolved=true" : "";
    try {
      setAlerts(await api<Alert[]>(`/projects/${projectId}/alerts${query}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Alerts could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filter, projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setFilter(parseFilter(searchParams.get("filter")));
  }, [searchParams]);

  function setFilterAndUrl(next: AlertFilter) {
    setFilter(next);
    const params = new URLSearchParams(searchParams);
    if (next === "open") params.delete("filter");
    else params.set("filter", next);
    setSearchParams(params, { replace: true });
  }

  async function action(alert: Alert, name: "read" | "resolve") {
    setError("");
    try {
      await api(`/projects/${projectId}/alerts/${alert.id}/${name}`, { method: "POST" });
      setSuccess(name === "read" ? "Alert marked as read." : "Alert resolved.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Alert could not be updated.");
    }
  }

  return (
    <div className="ops-page">
      <PageHeader
        title="Alerts"
        description="Review project alerts for data, model, and service events."
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      <div className="segmented" role="tablist" aria-label="Alert filters">
        <button type="button" className={filter === "open" ? "active" : ""} onClick={() => setFilterAndUrl("open")}>Open</button>
        <button type="button" className={filter === "resolved" ? "active" : ""} onClick={() => setFilterAndUrl("resolved")}>Resolved</button>
        <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilterAndUrl("all")}>All</button>
      </div>
      {loading ? (
        <Loading label="Loading alerts" />
      ) : alerts.length === 0 ? (
        <EmptyState
          title={filter === "resolved" ? "No resolved alerts" : filter === "all" ? "No alerts" : "All clear"}
          description={
            filter === "resolved"
              ? "Resolved alerts will remain visible here."
              : "There are no alerts requiring attention in this project."
          }
        />
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <article
              className={`alert-card ${alert.is_read ? "" : "unread"}`}
              key={alert.id}
              data-testid={`alert-card-${alert.id}`}
            >
              <div className={`severity-mark ${alert.severity}`} aria-hidden="true">!</div>
              <div className="alert-copy">
                <div className="row-actions">
                  <StatusBadge status={alert.severity} />
                  <span>{formatDate(alert.created_at)}</span>
                  {!alert.is_read && <span className="unread-label">Unread</span>}
                  {alert.is_resolved && <StatusBadge status="resolved" />}
                </div>
                <h2>{alert.title}</h2>
                <p>{alert.message}</p>
                <div className="row-actions">
                  {alert.link_path && (
                    <Link to={alert.link_path} data-testid={`alert-link-${alert.id}`}>
                      View related resource →
                    </Link>
                  )}
                  {!alert.is_read && (
                    <button className="btn link" onClick={() => action(alert, "read")}>
                      Mark read
                    </button>
                  )}
                  {canResolve && !alert.is_resolved && (
                    <button
                      className="btn secondary"
                      title="Mark this alert as resolved. It remains available in the Resolved tab."
                      aria-label={`Resolve alert ${alert.title}. Mark this alert as resolved. It remains available in the Resolved tab.`}
                      onClick={() => action(alert, "resolve")}
                    >
                      Resolve
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
