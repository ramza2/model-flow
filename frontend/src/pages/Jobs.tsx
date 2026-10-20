import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Job } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  formatDate,
} from "../components";
import { effectiveTargetColumns } from "../jobHelpers";
import { TargetChips } from "../lifecycleComponents";
import { formatPrimaryMetric, resolveDisplayProblemType } from "../metricHelpers";
import { userCanProject, useProject } from "../ProjectContext";
import { jobStatusLabel, problemTypeLabel } from "../uiTerminology";

export default function Jobs() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [items, setItems] = useState<Job[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canTrain = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Job[]>(`/projects/${projectId}/jobs${status ? `?status=${status}` : ""}`)
        .then((rows) => {
          if (alive) setItems(rows);
        })
        .catch((reason) => {
          if (alive) setError(reason instanceof Error ? reason.message : "모델 학습 목록을 불러오지 못했습니다.");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId, status]);

  return (
    <div>
      <PageHeader
        title="모델 학습"
        description="학습 상태와 주요 평가 지표를 확인하고, 작업을 열어 상세 성능·데이터 이력·실행 로그를 살펴볼 수 있습니다."
        actions={canTrain ? <Link className="btn" to={`/projects/${projectId}/jobs/new`}>＋ 새 모델 학습</Link> : undefined}
      />
      <ErrorNotice message={error} />
      <div className="workflow-catalog">
        <div className="filter-bar catalog-filter">
          <label>
            상태
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              data-testid="jobs-status-filter"
            >
              <option value="">전체 상태</option>
              <option value="pending">대기 중</option>
              <option value="running">학습 중</option>
              <option value="succeeded">완료</option>
              <option value="failed">실패</option>
              <option value="cancelled">취소됨</option>
            </select>
          </label>
          <div className="catalog-summary" aria-live="polite" data-testid="jobs-summary">
            <span className="catalog-summary-label">학습 작업 </span>
            <span className="catalog-summary-count">{items.length}</span>
            <span className="catalog-summary-label">
              건{status ? ` · ${jobStatusLabel(status)}` : ""}
            </span>
          </div>
        </div>
        {loading ? (
          <Loading label="모델 학습 목록 불러오는 중" />
        ) : items.length === 0 ? (
          <EmptyState
            title={status ? "선택한 상태의 학습 작업이 없습니다" : "아직 모델 학습 작업이 없습니다"}
            description="새 모델 학습을 만들어 데이터셋으로 학습을 시작할 수 있습니다."
            action={!status && canTrain ? <Link className="btn" to={`/projects/${projectId}/jobs/new`}>새 모델 학습</Link> : undefined}
          />
        ) : (
          <div className="panel table-wrap catalog-table">
            <table data-testid="jobs-table">
              <thead>
                <tr>
                  <th>학습 작업</th>
                  <th>상태</th>
                  <th>예측 유형</th>
                  <th>학습 알고리즘</th>
                  <th>예측 대상</th>
                  <th>주요 평가 지표</th>
                  <th>생성일시</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.id} data-testid={`job-row-${job.id}`}>
                    <td>
                      <Link className="catalog-primary-link" to={`/projects/${projectId}/jobs/${job.id}`}>
                        <strong>{job.name}</strong>
                      </Link>
                      <small className="table-subtitle">
                        <span className="mono">데이터셋 #{job.dataset_id}</span>
                        {job.description ? ` · ${job.description}` : ""}
                      </small>
                    </td>
                    <td>
                      <StatusBadge status={job.status} label={jobStatusLabel(job.status)} />
                    </td>
                    <td>
                      <span className="type-chip">
                        {problemTypeLabel(resolveDisplayProblemType(job.problem_type, job.metrics))}
                      </span>
                    </td>
                    <td className="catalog-secondary-text">
                      {job.algorithm.replaceAll("_", " ")}
                    </td>
                    <td><TargetChips targets={effectiveTargetColumns(job)} /></td>
                    <td className="tabular-num">
                      {formatPrimaryMetric(job.metrics, {
                        problemType: job.problem_type,
                        targetColumns: effectiveTargetColumns(job),
                      })}
                    </td>
                    <td className="catalog-meta-date">{formatDate(job.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
