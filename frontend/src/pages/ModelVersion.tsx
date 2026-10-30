import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiRequestError, type ModelVersion as ModelVersionType } from "../api";
import { useAuth } from "../AuthContext";
import {
  ErrorNotice,
  HelpTip,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";
import {
  DetailSection,
  EntityLineage,
  GateSummary,
  LifecycleStepper,
  MetricSummary,
  TargetChips,
} from "../lifecycleComponents";
import { parseTargetColumns } from "../lifecycleHelpers";
import { modelGateStatusKo, modelLifecycleLabelKo, modelProblemTypeKo } from "../modelRegistryLabels";
import { userCanProject, useProject } from "../ProjectContext";

const RERUN_LIFECYCLES = ["CANDIDATE", "VALIDATING", "REJECTED"];

export default function ModelVersion() {
  const { projectId, modelVersionId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [mv, setMv] = useState<ModelVersionType | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(() => {
    return api<ModelVersionType>(`/projects/${projectId}/models/${modelVersionId}`)
      .then(setMv)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "모델 정보를 불러오지 못했습니다."));
  }, [modelVersionId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(name: "request-approval" | "approve" | "reject" | "promote-production") {
    setBusy(name);
    setError("");
    setSuccess("");
    try {
      const updated = await api<ModelVersionType>(`/projects/${projectId}/models/${modelVersionId}/${name}`, {
        method: "POST",
        body: name === "promote-production" ? undefined : JSON.stringify({ comment: comment || undefined }),
      });
      setMv(updated);
      setSuccess(
        name === "request-approval" ? "모델 승인 요청을 등록했습니다."
          : name === "approve" ? "모델 승인을 완료했습니다."
            : name === "reject" ? "모델을 반려했습니다."
              : "모델을 운영 상태로 변경했습니다.",
      );
      setComment("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "모델 상태 변경에 실패했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function rerunValidation() {
    setBusy("evaluate-gates");
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/models/${modelVersionId}/evaluate-gates`, {
        method: "POST",
      });
      await load();
      setSuccess("모델 적합성 검증을 다시 실행했습니다.");
    } catch (reason) {
      if (reason instanceof ApiRequestError) {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "검증 재실행에 실패했습니다.");
      }
    } finally {
      setBusy("");
    }
  }

  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");
  const canApprove = userCanProject(user, selectedProject, "PROJECT_ADMIN");
  const canRequestApproval = Boolean(mv && RERUN_LIFECYCLES.includes(mv.lifecycle) && mv.gates_passed);
  const showApprovalBlocked = Boolean(mv && RERUN_LIFECYCLES.includes(mv.lifecycle) && !mv.gates_passed);
  const canRerun = Boolean(mv && canWrite && RERUN_LIFECYCLES.includes(mv.lifecycle));
  const canPromote = Boolean(mv && canApprove && mv.lifecycle === "APPROVED");
  const canDeployLink = Boolean(
    mv && canWrite && ["APPROVED", "PRODUCTION"].includes(mv.lifecycle),
  );
  const canReject = Boolean(mv && canApprove && mv.lifecycle === "PENDING_APPROVAL");
  const canApproveNow = Boolean(mv && canApprove && mv.lifecycle === "PENDING_APPROVAL");
  const showReviewCommentInput = Boolean(
    mv && (
      (canWrite && RERUN_LIFECYCLES.includes(mv.lifecycle) && mv.gates_passed)
      || canApproveNow
      || canReject
    ),
  );
  const closedLoop = (mv?.metadata as { closed_loop?: Record<string, number | null> } | undefined)?.closed_loop;

  const targets = useMemo(() => parseTargetColumns(mv?.metadata), [mv?.metadata]);
  const problemType = typeof mv?.metadata?.problem_type === "string" ? mv.metadata.problem_type : undefined;

  let primaryKind: "request" | "approve" | "promote" | "deploy" | "rerun" | null = null;
  let headerPrimary: ReactNode = null;
  if (mv) {
    if (canWrite && canRequestApproval) {
      primaryKind = "request";
      headerPrimary = (
        <button className="btn" disabled={Boolean(busy)} onClick={() => void action("request-approval")} data-testid="request-approval">
          승인 요청
        </button>
      );
    } else if (canApproveNow) {
      primaryKind = "approve";
      headerPrimary = (
        <button className="btn" disabled={Boolean(busy)} onClick={() => void action("approve")} data-testid="approve-model">
          ✓ 승인
        </button>
      );
    } else if (canPromote) {
      primaryKind = "promote";
      headerPrimary = (
        <button className="btn" disabled={Boolean(busy)} onClick={() => void action("promote-production")} data-testid="promote-production">
          운영 모델로 전환
        </button>
      );
    } else if (canDeployLink) {
      primaryKind = "deploy";
      headerPrimary = (
        <Link
          className="btn"
          to={`/projects/${projectId}/deployments`}
          state={{ modelVersionId: mv.id }}
          data-testid="create-deployment"
        >
          모델 배포 만들기
        </Link>
      );
    } else if (canRerun) {
      primaryKind = "rerun";
      headerPrimary = (
        <button
          className="btn"
          disabled={busy === "evaluate-gates"}
          onClick={() => void rerunValidation()}
          data-testid="rerun-validation"
        >
          {busy === "evaluate-gates" ? "검증 중…" : "검증 다시 실행"}
        </button>
      );
    }
  }

  return (
    <div className="page-stack model-version-page">
      <PageHeader
        title={mv ? `${mv.name} · v${mv.version}` : "모델 상세"}
        description={
          mv
            ? `${modelProblemTypeKo(problemType)}${targets.length ? ` · 예측 대상 ${targets.length}개` : ""}`
            : "모델 검증 결과, 성능 지표와 승인·배포 상태를 확인합니다."
        }
        actions={
          <>
            <span className="header-status">
              <StatusBadge status={mv?.lifecycle} label={modelLifecycleLabelKo(mv?.lifecycle)} />
            </span>
            {headerPrimary}
          </>
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {!mv ? (
        <Loading label="Loading model version" />
      ) : (
        <>
          <div
            className={`builder-state-band governance-state-band${mv.gates_passed ? " is-ready" : " is-blocked"}`}
            role="status"
          >
            <span className="builder-state-copy">모델 상태</span>
            <StatusBadge status={mv.lifecycle} label={modelLifecycleLabelKo(mv.lifecycle)} />
            <span className="builder-state-copy">적합성 검증</span>
            <StatusBadge status={mv.gates_passed ? "passed" : "pending"} label={modelGateStatusKo(mv.gates_passed)} />
            {mv.version != null ? <span className="version-chip">v{mv.version}</span> : null}
          </div>

          {(canRerun && primaryKind !== "rerun") || canReject || (canDeployLink && primaryKind !== "deploy") ? (
            <div className="row-actions toolbar-actions governance-secondary-actions">
              {canRerun && primaryKind !== "rerun" && (
                <button
                  className="btn secondary"
                  disabled={busy === "evaluate-gates"}
                  onClick={() => void rerunValidation()}
                  data-testid="rerun-validation"
                >
                  {busy === "evaluate-gates" ? "검증 중…" : "검증 다시 실행"}
                </button>
              )}
              {canReject && (
                <button
                  className="btn danger"
                  disabled={Boolean(busy)}
                  onClick={() => void action("reject")}
                  data-testid="reject-model"
                >
                  반려
                </button>
              )}
              {canDeployLink && primaryKind !== "deploy" && (
                <Link
                  className="btn secondary"
                  to={`/projects/${projectId}/deployments`}
                  state={{ modelVersionId: mv.id }}
                  data-testid="create-deployment"
                >
                  모델 배포 만들기
                </Link>
              )}
            </div>
          ) : null}

          {showApprovalBlocked && canWrite && (
            <p className="form-hint governance-blocked-hint" data-testid="approval-blocked-hint">
              승인 요청 전 모델 적합성 검증을 모두 통과해야 합니다.
            </p>
          )}

          <div className="governance-lifecycle-section">
            <DetailSection eyebrow="모델 상태" title="진행 단계">
              <LifecycleStepper lifecycle={mv.lifecycle} korean />
              {targets.length > 0 && (
                <div className="lifecycle-targets">
                  <span className="eyebrow">예측 대상</span>
                  <TargetChips targets={targets} testId="model-target-chips" />
                </div>
              )}
            </DetailSection>
          </div>

          {showReviewCommentInput && (
            <label className="panel comment-field governance-comment-panel">
              <span className="eyebrow">검토 의견 입력</span>
              <span className="governance-comment-title">승인 검토 의견</span>
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="검토자에게 전달할 의견을 입력하세요"
                data-testid="approval-comment-input"
              />
              <small className="form-hint">
                기존 검토 의견은 아래에 표시됩니다. 비워두면 승인·반려 시 기존 의견을 유지합니다.
              </small>
            </label>
          )}

          <div className="governance-metrics-section">
            <DetailSection eyebrow="예측 품질" title="성능 지표">
              <MetricSummary
                metrics={mv.metrics}
                problemType={problemType}
                targetColumns={targets}
                korean
                showMetricHelp
                labels={{ emptyTitle: "성능 지표", emptyHint: "학습 완료 후 표시됩니다.", primaryPrefix: "대표 지표:" }}
              />
              {targets.length > 1 && (
                <p className="form-hint model-metric-relationship-hint" data-testid="model-metric-relationship-hint">
                  대표 지표는 모델 목록에서 우선 표시하는 요약 지표입니다. 예측 대상별 지표는 각 대상의 성능을 별도로 보여 주며,
                  아래 성능 기준 검증은 정책에 지정된 지표를 사용하므로 값이 서로 다를 수 있습니다.
                </p>
              )}
              <p className="form-hint">검증 통과가 예측 성능이나 운영 적합성을 보장하지는 않습니다. <HelpTip text="RMSE·MAE는 낮을수록 좋으며, R²는 1에 가까울수록 좋습니다. 학습 데이터와 평가 조건이 다른 모델끼리는 수치를 직접 비교하지 마세요." /></p>
            </DetailSection>
          </div>

          <div className="two-column governance-evidence-grid">
            <DetailSection eyebrow="승인 관리" title="승인 및 검토 이력" testId="approval-evidence">
              <dl className="key-values">
                <div>
                  <dt>모델 상태</dt>
                  <dd>
                    <StatusBadge status={mv.lifecycle} label={modelLifecycleLabelKo(mv.lifecycle)} />
                  </dd>
                </div>
                <div>
                  <dt>적합성 검증</dt>
                  <dd>
                    <StatusBadge status={mv.gates_passed ? "passed" : "pending"} label={modelGateStatusKo(mv.gates_passed)} />
                  </dd>
                </div>
                <div>
                  <dt>검토 의견</dt>
                  <dd className="governance-comment-value" data-testid="approval-comment-value">
                    {mv.approval_comment || "—"}
                  </dd>
                </div>
                {mv.approved_by != null ? (
                  <div>
                    <dt>검토자</dt>
                    <dd data-testid="approval-reviewed-by">사용자 #{mv.approved_by}</dd>
                  </div>
                ) : null}
                {mv.approved_at ? (
                  <div>
                    <dt>승인 일시</dt>
                    <dd className="catalog-meta-date">{formatDate(mv.approved_at)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>등록일</dt>
                  <dd className="catalog-meta-date">{formatDate(mv.created_at)}</dd>
                </div>
              </dl>
            </DetailSection>

            <EntityLineage
              items={[
                ...(closedLoop
                  ? [
                      {
                        label: "생성 방식",
                        value: "자동 재학습",
                      },
                      {
                        label: "실행 계기",
                        value: closedLoop.quality_run_id
                          ? `품질 평가 #${closedLoop.quality_run_id}`
                          : "—",
                      },
                      {
                        label: "기존 운영 모델",
                        value: closedLoop.source_model_version_id
                          ? `모델 버전 #${closedLoop.source_model_version_id}`
                          : "—",
                        to: closedLoop.source_model_version_id
                          ? `/projects/${projectId}/models/${closedLoop.source_model_version_id}`
                          : undefined,
                      },
                      {
                        label: "기존 학습 작업",
                        value: closedLoop.source_training_job_id
                          ? `학습 작업 #${closedLoop.source_training_job_id}`
                          : "—",
                        to: closedLoop.source_training_job_id
                          ? `/projects/${projectId}/jobs/${closedLoop.source_training_job_id}`
                          : undefined,
                      },
                      {
                        label: "학습 데이터셋",
                        value: closedLoop.target_dataset_version_id
                          ? `데이터셋 버전 #${closedLoop.target_dataset_version_id}`
                          : "—",
                      },
                    ]
                  : []),
                {
                  label: "데이터셋 버전",
                  value: mv.dataset_version_id ? `버전 #${mv.dataset_version_id}` : "—",
                },
                {
                  label: "학습 작업",
                  value: mv.training_job_id ? `작업 #${mv.training_job_id}` : "—",
                  to: mv.training_job_id
                    ? `/projects/${projectId}/jobs/${mv.training_job_id}`
                    : undefined,
                },
                {
                  label: "실험 실행 기록",
                  value: mv.mlflow_run_id || "—",
                  to: mv.mlflow_run_id
                    ? `/projects/${projectId}/experiments/runs/${mv.mlflow_run_id}`
                    : undefined,
                  mono: true,
                },
                {
                  label: "모델 URI",
                  value: mv.model_uri || "—",
                  mono: true,
                },
                ...(mv.pipeline_run_id
                  ? [
                      {
                        label: "파이프라인 실행",
                        value: `실행 #${mv.pipeline_run_id}`,
                        to: `/projects/${projectId}/pipeline-runs/${mv.pipeline_run_id}`,
                      },
                    ]
                  : []),
              ]}
              eyebrow="생성 이력"
              title="모델 생성·학습 경로"
            />
          </div>

          <div className="governance-gates-section">
            <DetailSection eyebrow="모델 검증" title="적합성 검증 결과">
              <GateSummary gatesPassed={mv.gates_passed} gateResults={mv.gate_results || {}} targetColumns={targets} korean />
            </DetailSection>
          </div>
        </>
      )}
    </div>
  );
}
