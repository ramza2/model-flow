import { type FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type AuditEvent } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";
import { auditActionLabel, auditResourceLabel } from "../uiTerminology";

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
      .catch((reason) => setError(reason instanceof Error ? reason.message : "감사 로그를 불러오지 못했습니다."))
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
        title={projectId ? "감사 로그" : "전체 감사 로그"}
        description={
          projectId
            ? "이 프로젝트에서 발생한 보안·모델 운영 변경 이력을 확인합니다."
            : "시스템 전체의 보안·관리 작업 이력을 확인합니다."
        }
      />
      <ErrorNotice message={error} />
      <form className="filter-bar catalog-filter filter-form audit-filter-toolbar" onSubmit={filter}>
        <label>
          작업 유형
          <input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder="예: model.approve (내부 작업 코드)"
          />
        </label>
        <label>
          대상 유형
          <select value={resourceType} onChange={(event) => setResourceType(event.target.value)}>
            <option value="">전체 대상</option>
            <option value="project">프로젝트</option>
            <option value="dataset">데이터셋</option>
            <option value="training_job">모델 학습 작업</option>
            <option value="model_version">모델 버전</option>
            <option value="endpoint">모델 배포</option>
            <option value="user">사용자</option>
          </select>
        </label>
        <label>
          시작 날짜
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <button className="btn" type="submit">
          필터 적용
        </button>
      </form>
      {loading ? (
        <Loading label="감사 로그 불러오는 중" />
      ) : events.length === 0 ? (
        <EmptyState
          title="조건에 맞는 감사 로그가 없습니다"
          description="필터를 변경하거나 해당 범위에서 작업이 발생한 후 다시 확인해 주세요."
        />
      ) : (
        <div className="panel table-wrap catalog-table audit-catalog-table">
          <table>
            <thead>
              <tr>
                <th>발생 시각</th>
                <th>수행자</th>
                <th>작업 유형</th>
                <th>대상</th>
                <th>결과</th>
                <th>상세 ID</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className={event.success ? undefined : "is-failed"}>
                  <td className="catalog-meta-date">{formatDate(event.created_at)}</td>
                  <td>{event.user_email || "시스템"}</td>
                  <td title={event.action}>
                    {auditActionLabel(event.action)}
                    {auditActionLabel(event.action) !== event.action ? (
                      <> <small className="table-subtitle mono">{event.action}</small></>
                    ) : null}
                  </td>
                  <td>
                    {auditResourceLabel(event.resource_type)}{" "}
                    {event.resource_id ? <span className="mono">#{event.resource_id}</span> : null}
                  </td>
                  <td>
                    <StatusBadge status={event.success ? "succeeded" : "failed"} label={event.success ? "성공" : "실패"} />
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
