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
import { operationalStatusLabel } from "../uiTerminology";

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
      setError(reason instanceof Error ? reason.message : "알림 목록을 불러오지 못했습니다.");
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
      setSuccess(name === "read" ? "알림을 읽음 처리했습니다." : "알림을 해결 완료 처리했습니다.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "알림 상태를 변경하지 못했습니다.");
    }
  }

  return (
    <div className="page-stack ops-page alerts-page">
      <PageHeader
        title="알림"
        description="데이터·모델·서비스에서 발생한 프로젝트 알림을 확인하고 처리합니다."
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      <div className="segmented alerts-filter" role="tablist" aria-label="알림 필터">
        <button type="button" className={filter === "open" ? "active" : ""} onClick={() => setFilterAndUrl("open")}>미해결</button>
        <button type="button" className={filter === "resolved" ? "active" : ""} onClick={() => setFilterAndUrl("resolved")}>해결 완료</button>
        <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilterAndUrl("all")}>전체</button>
      </div>
      {loading ? (
        <Loading label="알림 불러오는 중" />
      ) : alerts.length === 0 ? (
        <EmptyState
          title={filter === "resolved" ? "해결 완료된 알림이 없습니다" : filter === "all" ? "알림이 없습니다" : "미해결 알림이 없습니다"}
          description={
            filter === "resolved"
              ? "해결 완료한 알림은 이곳에서 다시 확인할 수 있습니다."
              : "현재 프로젝트에서 조치가 필요한 알림이 없습니다."
          }
        />
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <article
              className={[
                "alert-card",
                alert.is_read ? "is-read" : "unread",
                alert.is_resolved ? "is-resolved" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={alert.id}
              data-testid={`alert-card-${alert.id}`}
            >
              <div className={`severity-mark ${alert.severity}`} aria-hidden="true">!</div>
              <div className="alert-copy">
                <div className="row-actions alert-meta-row">
                  <StatusBadge status={alert.severity} label={operationalStatusLabel(alert.severity)} />
                  <span className="catalog-meta-date">{formatDate(alert.created_at)}</span>
                  {!alert.is_read && <span className="unread-label">읽지 않음</span>}
                  {alert.is_resolved && <StatusBadge status="resolved" label="해결 완료" />}
                </div>
                <h2>{alert.title}</h2>
                <p>{alert.message}</p>
                <div className="row-actions alert-actions">
                  {alert.link_path && (
                    <Link className="btn link" to={alert.link_path} data-testid={`alert-link-${alert.id}`}>
                      관련 항목 보기 →
                    </Link>
                  )}
                  {!alert.is_read && (
                    <button className="btn link" onClick={() => action(alert, "read")}>
                      읽음 처리
                    </button>
                  )}
                  {canResolve && !alert.is_resolved && (
                    <button
                      className="btn secondary"
                      title="이 알림을 해결 완료로 표시합니다. 해결 완료 탭에서 계속 확인할 수 있습니다."
                      aria-label={`${alert.title} 알림 해결 완료 처리. 해결 완료 탭에서 계속 확인할 수 있습니다.`}
                      onClick={() => action(alert, "resolve")}
                    >
                      해결 완료
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
