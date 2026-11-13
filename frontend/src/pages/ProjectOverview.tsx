import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Alert,
  type Job,
  type Membership,
  type Project,
  type ProjectRole,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  formatDate,
} from "../components";
import { DetailSection } from "../lifecycleComponents";
import {
  countActiveJobs,
  countFailedJobs,
  factualSignalLines,
  type OverviewSignals,
} from "../operationsHelpers";
import { userCanProject, useProject } from "../ProjectContext";
import { alertDisplayCopy, jobStatusLabel, operationalStatusLabel, projectRoleLabel } from "../uiTerminology";

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

export default function ProjectOverview() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectProject, refreshProjects } = useProject();
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dataMetrics, setDataMetrics] = useState<DataMetrics | null>(null);
  const [modelMetrics, setModelMetrics] = useState<ModelMetrics | null>(null);
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<ProjectRole>("VIEWER");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    try {
      const projectRow = await api<Project>(`/projects/${projectId}`);
      const canManage = userCanProject(user, projectRow, "PROJECT_ADMIN");
      const [jobRows, dataRows, modelRows, alertRows, memberRows] = await Promise.all([
        api<Job[]>(`/projects/${projectId}/jobs`),
        api<DataMetrics>(`/projects/${projectId}/monitoring/data`),
        api<ModelMetrics>(`/projects/${projectId}/monitoring/models`),
        api<Alert[]>(`/projects/${projectId}/alerts?is_resolved=false`),
        canManage ? api<Membership[]>(`/projects/${projectId}/members`) : Promise.resolve([]),
      ]);
      setProject(projectRow);
      setName(projectRow.name);
      setDescription(projectRow.description);
      setJobs(jobRows);
      setDataMetrics(dataRows);
      setModelMetrics(modelRows);
      setOpenAlerts(alertRows);
      setMembers(memberRows);
      selectProject(projectRow.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "프로젝트를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectProject, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = userCanProject(user, project, "PROJECT_ADMIN");
  const canWriteData = userCanProject(user, project, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");
  const canTrain = userCanProject(user, project, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");
  const canBuildPipeline = userCanProject(user, project, "ML_ENGINEER", "PROJECT_ADMIN");

  const signals: OverviewSignals | null = useMemo(() => {
    if (!dataMetrics || !modelMetrics) return null;
    return {
      datasetCount: dataMetrics.dataset_count,
      failedQualityChecks: dataMetrics.failed_quality_check_count,
      latestQualityStatus: dataMetrics.latest_quality_status,
      jobCount: jobs.length,
      activeJobs: countActiveJobs(jobs),
      failedJobs: countFailedJobs(jobs),
      modelVersionCount: modelMetrics.model_version_count,
      productionModels: modelMetrics.lifecycle_counts.PRODUCTION ?? 0,
      lifecycleCounts: modelMetrics.lifecycle_counts,
      endpointCount: modelMetrics.endpoint_count,
      readyEndpoints: modelMetrics.ready_endpoint_count,
      openAlerts: openAlerts.length,
    };
  }, [dataMetrics, modelMetrics, jobs, openAlerts]);

  const signalLines = signals ? factualSignalLines(signals) : [];
  const recentJobs = jobs.slice(0, 5);

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    try {
      const updated = await api<Project>(`/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
      });
      setProject(updated);
      setEditing(false);
      setSuccess("프로젝트 정보가 수정됐습니다.");
      await refreshProjects();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "프로젝트를 수정하지 못했습니다.");
    }
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      });
      setMemberEmail("");
      setSuccess("프로젝트에 구성원을 추가했습니다.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "구성원을 추가하지 못했습니다.");
    }
  }

  async function removeMember(member: Membership) {
    if (!confirmAction(`이 프로젝트에서 ${member.email} 구성원을 제거하시겠습니까?`)) return;
    setError("");
    try {
      await api(`/projects/${projectId}/members/${member.user_id}`, { method: "DELETE" });
      setMembers((rows) => rows.filter((row) => row.id !== member.id));
      setSuccess("프로젝트에서 구성원을 제거했습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "구성원을 제거하지 못했습니다.");
    }
  }

  async function deleteProject() {
    if (!project || !confirmAction(`“${project.name}” 프로젝트를 삭제하시겠습니까? 이 프로젝트의 데이터에 더 이상 접근할 수 없습니다.`)) return;
    setError("");
    try {
      await api(`/projects/${project.id}`, { method: "DELETE" });
      await refreshProjects();
      navigate("/projects");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "프로젝트를 삭제하지 못했습니다.");
    }
  }

  return (
    <div className="ops-page">
      <PageHeader
        title={project?.name ?? "프로젝트 개요"}
        description={project?.description || "데이터·모델 학습·배포·알림 현황을 한곳에서 확인합니다."}
        actions={canManage ? <button className="btn secondary" onClick={() => setEditing(!editing)}>프로젝트 수정</button> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {loading ? <Loading label="프로젝트 불러오는 중" /> : (
        <>
          {editing && (
            <form className="panel form" onSubmit={saveProject} data-testid="project-edit-form">
              <label>이름<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
              <label>설명<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <div className="row-actions">
                <button className="btn">변경 사항 저장</button>
                <button className="btn secondary" type="button" onClick={() => setEditing(false)}>취소</button>
              </div>
            </form>
          )}

          {signals && (
            <section className="panel ops-attention-panel" data-testid="overview-signals">
              <span className="eyebrow">주요 운영 현황</span>
              <ul className="ops-signal-list">
                {signalLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="ops-lifecycle-grid">
            <DetailSection eyebrow="데이터" title="데이터셋 및 품질" testId="overview-data">
              {!dataMetrics ? <Loading label="데이터 현황 불러오는 중" /> : (
                <dl className="key-values">
                  <div><dt>데이터셋</dt><dd>{dataMetrics.dataset_count}</dd></div>
                  <div><dt>버전 수</dt><dd>{dataMetrics.dataset_version_count}</dd></div>
                  <div><dt>실패한 품질 검사</dt><dd>{dataMetrics.failed_quality_check_count}</dd></div>
                  <div>
                    <dt>최근 품질 결과</dt>
                    <dd>{dataMetrics.latest_quality_status
                      ? <StatusBadge status={dataMetrics.latest_quality_status} label={operationalStatusLabel(dataMetrics.latest_quality_status)} />
                      : "—"}</dd>
                  </div>
                </dl>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/datasets`}>데이터셋 보기</Link>
              </div>
            </DetailSection>

            <DetailSection eyebrow="모델 개발" title="학습 현황" testId="overview-build">
              <dl className="key-values">
                <div><dt>모델 학습 작업</dt><dd>{signals?.jobCount ?? 0}</dd></div>
                <div><dt>진행 중인 학습</dt><dd>{signals?.activeJobs ?? 0}</dd></div>
                <div><dt>실패한 학습</dt><dd>{signals?.failedJobs ?? 0}</dd></div>
              </dl>
              {recentJobs.length === 0 ? (
                <EmptyState title="학습 작업이 없습니다" description="준비된 데이터셋으로 모델 학습을 시작하세요." />
              ) : (
                <div className="activity-list compact">
                  {recentJobs.map((job) => (
                    <Link key={job.id} to={`/projects/${projectId}/jobs/${job.id}`}>
                      <div>
                        <strong>{job.name}</strong>
                        <small>{job.algorithm}</small>
                      </div>
                      <StatusBadge status={job.status} label={jobStatusLabel(job.status)} />
                    </Link>
                  ))}
                </div>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/jobs`}>학습 작업 보기</Link>
              </div>
            </DetailSection>

            <DetailSection eyebrow="모델" title="모델 등록 및 승인 현황" testId="overview-models">
              {!modelMetrics ? <Loading label="모델 현황 불러오는 중" /> : (
                <>
                  <dl className="key-values">
                    <div><dt>모델 버전</dt><dd>{modelMetrics.model_version_count}</dd></div>
                    <div><dt>운영 모델</dt><dd>{modelMetrics.lifecycle_counts.PRODUCTION ?? 0}</dd></div>
                  </dl>
                  <div className="tag-list">
                    {Object.entries(modelMetrics.lifecycle_counts).map(([name, count]) => (
                      <span key={name}>{operationalStatusLabel(name)} · {count}</span>
                    ))}
                  </div>
                </>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/registry`}>모델 관리 보기</Link>
              </div>
            </DetailSection>

            <DetailSection eyebrow="예측 서비스" title="모델 배포" testId="overview-serving">
              {!modelMetrics ? <Loading label="배포 현황 불러오는 중" /> : (
                <dl className="key-values">
                  <div><dt>배포 수</dt><dd>{modelMetrics.endpoint_count}</dd></div>
                  <div><dt>준비 완료</dt><dd>{modelMetrics.ready_endpoint_count} / {modelMetrics.endpoint_count}</dd></div>
                  <div><dt>전체 예측 요청</dt><dd>{modelMetrics.total_requests.toLocaleString()}</dd></div>
                  <div><dt>전체 오류</dt><dd>{modelMetrics.total_errors.toLocaleString()}</dd></div>
                </dl>
              )}
              <div className="row-actions">
                <Link to={`/projects/${projectId}/deployments`}>모델 배포 보기</Link>
              </div>
            </DetailSection>
          </div>

          <DetailSection
            eyebrow="알림"
            title="미해결 알림"
            testId="overview-alerts"
            actions={<Link to={`/projects/${projectId}/alerts`}>알림 전체 보기</Link>}
          >
            {openAlerts.length === 0 ? (
              <p className="muted" data-testid="overview-alerts-empty">미해결 알림 없음</p>
            ) : (
              <div className="activity-list">
                {openAlerts.slice(0, 3).map((alert) => (
                  <div key={alert.id} className="ops-alert-row">
                    <div>
                      <div className="row-actions">
                        <StatusBadge status={alert.severity} label={operationalStatusLabel(alert.severity)} />
                        {!alert.is_read && <span className="unread-label">읽지 않음</span>}
                      </div>
                      <strong>{alertDisplayCopy(alert.title, alert.message).title}</strong>
                      <small>{formatDate(alert.created_at)}</small>
                    </div>
                    {alert.link_path ? <Link to={alert.link_path}>열기</Link> : null}
                  </div>
                ))}
              </div>
            )}
          </DetailSection>

          <section className="panel" data-testid="overview-next-actions">
            <div className="panel-title">
              <div>
                <span className="eyebrow">다음 작업</span>
                <h2>작업 이어서 진행하기</h2>
              </div>
            </div>
            <div className="row-actions">
              {canWriteData && <Link className="btn" to={`/projects/${projectId}/datasets`}>데이터셋 업로드</Link>}
              {canTrain && <Link className="btn secondary" to={`/projects/${projectId}/jobs/new`}>모델 학습 시작</Link>}
              <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>실험 비교 보기</Link>
              {canBuildPipeline && <Link className="btn secondary" to={`/projects/${projectId}/pipelines`}>파이프라인 만들기</Link>}
              <Link className="btn secondary" to={`/projects/${projectId}/monitoring`}>모니터링 보기</Link>
            </div>
          </section>

          {canManage && (
            <section className="panel ops-secondary-panel" data-testid="overview-members">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">접근 권한</span>
                  <h2>프로젝트 구성원</h2>
                </div>
                <StatusBadge status={project?.role} label={projectRoleLabel(project?.role)} />
              </div>
              <form className="inline-form" onSubmit={addMember}>
                <label>이메일<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} required placeholder="teammate@example.com" /></label>
                <label>역할<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as ProjectRole)}>
                  <option value="VIEWER">조회자</option>
                  <option value="DATA_SCIENTIST">데이터 분석가</option>
                  <option value="ML_ENGINEER">ML 엔지니어</option>
                  <option value="PROJECT_ADMIN">프로젝트 관리자</option>
                </select></label>
                <button className="btn">구성원 추가</button>
              </form>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>구성원</th><th>역할</th><th>추가일</th><th><span className="sr-only">작업</span></th></tr></thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.id}>
                        <td><strong>{member.full_name || member.email}</strong><small className="table-subtitle">{member.email}</small></td>
                        <td>{projectRoleLabel(member.role)}</td>
                        <td>{formatDate(member.created_at)}</td>
                        <td className="align-right"><button className="btn link danger-text" onClick={() => removeMember(member)} disabled={member.user_id === user?.id}>제거</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {canManage && (
            <section className="panel danger-zone ops-secondary-panel" data-testid="overview-danger">
              <div><h2>프로젝트 삭제</h2><p>프로젝트를 사용 목록에서 제거합니다. 데이터 보관은 시스템 정책을 따릅니다.</p></div>
              <button className="btn danger" onClick={deleteProject}>프로젝트 삭제</button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
