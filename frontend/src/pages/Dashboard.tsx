import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Alert, type Dataset, type Endpoint, type Job } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge } from "../components";
import {
  buildHomeNextActions,
  countActiveJobs,
  countAttentionAlerts,
  countFailedJobs,
  type HomeStats,
} from "../operationsHelpers";
import { useProject } from "../ProjectContext";
import { jobStatusLabel } from "../uiTerminology";

export default function Dashboard() {
  const { projects, selectedProject, loading: projectLoading } = useProject();
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedProject) {
      setStats(null);
      setJobs([]);
      return;
    }
    setStats(null);
    setError("");
    Promise.all([
      api<Dataset[]>(`/projects/${selectedProject.id}/datasets`),
      api<Job[]>(`/projects/${selectedProject.id}/jobs`),
      api<Endpoint[]>(`/projects/${selectedProject.id}/endpoints`),
      api<Alert[]>(`/projects/${selectedProject.id}/alerts?is_read=false&is_resolved=false`),
    ])
      .then(([datasets, trainingJobs, endpoints, alerts]) => {
        setJobs(trainingJobs.slice(0, 5));
        setStats({
          datasets: datasets.length,
          jobs: trainingJobs.length,
          running: countActiveJobs(trainingJobs),
          failed: countFailedJobs(trainingJobs),
          endpoints: endpoints.length,
          unreadAlerts: alerts.length,
          attentionAlerts: countAttentionAlerts(alerts),
        });
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "홈 현황을 불러오지 못했습니다."));
  }, [selectedProject]);

  const nextActions = useMemo(
    () => (selectedProject && stats ? buildHomeNextActions(selectedProject.id, stats) : []),
    [selectedProject, stats],
  );

  return (
    <div className="ops-page">
      <PageHeader
        title="작업 공간 홈"
        description="선택한 프로젝트에서 확인할 사항과 다음 작업을 안내합니다."
        actions={<Link className="btn" to="/projects/new">프로젝트 만들기</Link>}
      />
      <ErrorNotice message={error} />
      {projectLoading ? (
        <Loading label="작업 공간 불러오는 중" />
      ) : !selectedProject ? (
        <EmptyState
          title="첫 프로젝트 만들기"
          description="프로젝트별로 데이터·모델 학습·배포·접근 권한을 관리할 수 있습니다."
          action={<Link className="btn" to="/projects/new">프로젝트 만들기</Link>}
        />
      ) : (
        <>
          <section className="panel ops-context-panel" data-testid="home-current-project">
            <div className="section-heading">
              <div>
                <span className="eyebrow">현재 프로젝트</span>
                <h2>{selectedProject.name}</h2>
                <p className="muted">
                  {selectedProject.description || "선택한 프로젝트의 작업 현황입니다."}
                </p>
              </div>
              <Link className="btn secondary" to={`/projects/${selectedProject.id}`}>
                프로젝트 개요 보기
              </Link>
            </div>
          </section>

          {!stats ? (
            <Loading label="프로젝트 현황 계산 중" />
          ) : (
            <>
              {(stats.failed > 0 || stats.attentionAlerts > 0) && (
                <section className="panel ops-attention-panel" data-testid="home-attention">
                  <span className="eyebrow">확인 필요</span>
                  <ul className="ops-signal-list">
                    {stats.failed > 0 && (
                      <li>
                        <Link to={`/projects/${selectedProject.id}/jobs`}>
                          실패한 모델 학습 {stats.failed}건
                        </Link>
                      </li>
                    )}
                    {stats.attentionAlerts > 0 && (
                      <li>
                        <Link to={`/projects/${selectedProject.id}/alerts`}>
                          확인이 필요한 알림 {stats.attentionAlerts}건
                        </Link>
                      </li>
                    )}
                  </ul>
                </section>
              )}

              <div className="grid stats-grid" data-testid="home-stats">
                <div className="stat">
                  <div className="label">전체 프로젝트</div>
                  <div className="value">{projects.length}</div>
                </div>
                <div className="stat">
                  <div className="label">데이터셋</div>
                  <div className="value">{stats.datasets}</div>
                </div>
                <div className="stat">
                  <div className="label">모델 학습 작업</div>
                  <div className="value">{stats.jobs}</div>
                  <small>진행 중 {stats.running}건</small>
                </div>
                <div className={`stat${stats.failed > 0 ? " is-attention" : ""}`}>
                  <div className="label">실패한 학습</div>
                  <div className="value">{stats.failed}</div>
                </div>
                <div className="stat">
                  <div className="label">모델 배포</div>
                  <div className="value">{stats.endpoints}</div>
                </div>
                <div className={`stat${stats.attentionAlerts > 0 ? " is-attention" : ""}`}>
                  <div className="label">읽지 않은 알림</div>
                  <div className="value">{stats.unreadAlerts}</div>
                  {stats.unreadAlerts > 0 && (
                    <small>
                      <Link to={`/projects/${selectedProject.id}/alerts`}>알림 확인</Link>
                    </small>
                  )}
                </div>
              </div>
            </>
          )}

          <div className="two-column">
            <section className="panel">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">최근 활동</span>
                  <h2>모델 학습 작업</h2>
                </div>
                <Link to={`/projects/${selectedProject.id}/jobs`}>전체 보기</Link>
              </div>
              {jobs.length === 0 ? (
                <EmptyState
                  title="학습 작업이 없습니다"
                  description="데이터셋을 업로드한 뒤 첫 모델 학습을 설정하세요."
                  action={
                    <Link className="btn secondary" to={`/projects/${selectedProject.id}/datasets`}>
                      데이터 추가
                    </Link>
                  }
                />
              ) : (
                <div className="activity-list">
                  {jobs.map((job) => (
                    <Link key={job.id} to={`/projects/${selectedProject.id}/jobs/${job.id}`}>
                      <div>
                        <strong>{job.name}</strong>
                        <small>{job.algorithm}</small>
                      </div>
                      <StatusBadge status={job.status} label={jobStatusLabel(job.status)} />
                    </Link>
                  ))}
                </div>
              )}
            </section>
            <section className="panel" data-testid="home-next-actions">
              <span className="eyebrow">다음 작업</span>
              <h2>여기서 계속하기</h2>
              <div className="action-list">
                {nextActions.map((action, index) => (
                  <Link
                    key={action.id}
                    to={action.to}
                    className={action.attention ? "is-attention" : undefined}
                    data-testid={`home-next-action-${action.id}`}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{action.title}</strong>
                      <small>{action.description}</small>
                    </div>
                    →
                  </Link>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
