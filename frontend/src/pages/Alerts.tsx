import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
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

export default function Alerts() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [filter, setFilter] = useState("open");
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

  return <div>
    <PageHeader title="Alerts" description="Triage actionable data, model, and service events." />
    <ErrorNotice message={error} /><SuccessNotice message={success} />
    <div className="segmented"><button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>Open</button><button className={filter === "resolved" ? "active" : ""} onClick={() => setFilter("resolved")}>Resolved</button><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button></div>
    {loading ? <Loading label="Loading alerts" /> : alerts.length === 0 ? (
      <EmptyState title={filter === "resolved" ? "No resolved alerts" : "All clear"} description={filter === "resolved" ? "Resolved alerts will remain visible here." : "There are no alerts requiring attention in this project."} />
    ) : (
      <div className="alert-list">
        {alerts.map((alert) => <article className={`alert-card ${alert.is_read ? "" : "unread"}`} key={alert.id}>
          <div className={`severity-mark ${alert.severity}`} aria-hidden="true">!</div>
          <div className="alert-copy"><div className="row-actions"><StatusBadge status={alert.severity} /><span>{formatDate(alert.created_at)}</span>{!alert.is_read && <span className="unread-label">Unread</span>}</div><h2>{alert.title}</h2><p>{alert.message}</p><div className="row-actions">{alert.link_path && <Link to={alert.link_path}>View related item →</Link>}{!alert.is_read && <button className="btn link" onClick={() => action(alert, "read")}>Mark read</button>}{canResolve && !alert.is_resolved && <button className="btn secondary" title="Mark this alert as resolved. It remains available in the Resolved tab." aria-label={`Resolve alert ${alert.title}. Mark this alert as resolved. It remains available in the Resolved tab.`} onClick={() => action(alert, "resolve")}>Resolve</button>}</div></div>
        </article>)}
      </div>
    )}
  </div>;
}
