import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Job, type ModelVersion } from "../api";
import { effectiveTargetColumns, isMultiOutputJob } from "../jobHelpers";
import { useAuth } from "../AuthContext";
import {
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  TermLabel,
  SuccessNotice,
  confirmAction,
  formatDate,
} from "../components";
import { DetailSection, EntityLineage, MetricSummary, TargetChips } from "../lifecycleComponents";
import { resolveDisplayProblemType } from "../metricHelpers";
import {
  UI_HELP,
  jobStatusLabel,
  problemTypeLabel,
  splitStrategyLabel,
  trainingModeLabel,
  trainingTaskLabel,
} from "../uiTerminology";
import { userCanProject, useProject } from "../ProjectContext";
import type { AlgorithmSpec } from "../trainingConfig";
import JobContinueTrainingDialog from "./JobContinueTrainingDialog";
import JobRetrainDialog from "./JobRetrainDialog";
import RegisterModelDialog from "./RegisterModelDialog";

export default function JobDetail() {
  const { projectId, jobId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [job, setJob] = useState<Job | null>(null);
  const [algorithmSpec, setAlgorithmSpec] = useState<AlgorithmSpec | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState("");
  const [showRetrain, setShowRetrain] = useState(false);
  const [showContinue, setShowContinue] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const canTrain = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");
  const canRegister = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");
  const supportsContinued = Boolean(algorithmSpec?.supports_continued_training);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Job>(`/projects/${projectId}/jobs/${jobId}`)
        .then((j) => alive && setJob(j))
        .catch((reason) =>
          alive && setError(reason instanceof Error ? reason.message : "학습 작업을 불러오지 못했습니다."),
        );
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobId, projectId]);

  useEffect(() => {
    if (!projectId || !job?.algorithm) {
      setAlgorithmSpec(null);
      return;
    }
    let alive = true;
    api<{ algorithms: AlgorithmSpec[] }>(`/projects/${projectId}/training/algorithms`)
      .then((payload) => {
        if (!alive) return;
        const match = (payload.algorithms ?? []).find((item) => item.id === job.algorithm) ?? null;
        setAlgorithmSpec(match);
      })
      .catch(() => {
        if (alive) setAlgorithmSpec(null);
      });
    return () => {
      alive = false;
    };
  }, [job?.algorithm, projectId]);

  async function register(modelName: string) {
    if (!job) return;
    setBusy("register");
    setSuccess("");
    try {
      const model = await api<ModelVersion>(`/projects/${projectId}/models/register`, {
        method: "POST",
        body: JSON.stringify({
          training_job_id: job.id,
          name: modelName,
        }),
      });
      setSuccess(`모델 ${model.name} v${model.version}을 등록했습니다.`);
      setShowRegister(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "모델을 등록하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function action(name: "cancel" | "retry") {
    if (!job) return;
    if (name === "cancel" && !confirmAction(`학습 작업 ‘${job.name}’의 중지를 요청하시겠습니까?`)) return;
    setBusy(name);
    setError("");
    try {
      const next = await api<Job>(`/projects/${projectId}/jobs/${job.id}/${name}`, {
        method: "POST",
      });
      if (name === "cancel") {
        setJob(next);
        setSuccess("학습 중지를 요청했습니다.");
      } else {
        navigate(`/projects/${projectId}/jobs/${next.id}`);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : name === "cancel"
            ? "학습 중지를 요청하지 못했습니다."
            : "학습을 다시 실행하지 못했습니다.",
      );
    } finally {
      setBusy("");
    }
  }

  const active = job && ["pending", "queued", "running", "cancel_requested"].includes(job.status);
  const targets = job ? effectiveTargetColumns(job) : [];
  const showRetrainAction = canTrain && job?.status === "succeeded";
  const showContinueAction =
    showRetrainAction && Boolean(job?.model_uri) && Boolean(job?.mlflow_run_id) && supportsContinued;

  return (
    <div>
      <PageHeader
        title={job?.name ?? "모델 학습"}
        description="학습 상태와 성능, 사용한 데이터·설정, 실행 로그를 확인합니다."
        actions={
          <>
            {job ? (
              <span className="header-status" data-testid="job-header-status">
                <StatusBadge status={job.status} label={jobStatusLabel(job.status)} />
              </span>
            ) : null}
            <span className="header-lifecycle-actions">
              {canTrain && job && ["failed", "cancelled"].includes(job.status) && (
                <button className="btn" disabled={busy === "retry"} onClick={() => void action("retry")} data-testid="job-retry">
                  다시 실행
                </button>
              )}
              {canRegister && job?.status === "succeeded" && job.model_uri && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy === "register"}
                  onClick={() => setShowRegister(true)}
                  data-testid="register-model"
                >
                  {busy === "register" ? "모델 등록 중…" : "모델 등록"}
                </button>
              )}
              {showRetrainAction && !(canRegister && job?.model_uri) && (
                <button type="button" className="btn" data-testid="job-retrain" onClick={() => setShowRetrain(true)}>
                  전체 재학습
                </button>
              )}
              {showContinueAction && !(canRegister && job?.model_uri) && (
                <button type="button" className="btn secondary" data-testid="job-continue" onClick={() => setShowContinue(true)}>
                  이어서 학습
                </button>
              )}
            </span>
          </>
        }
      />
      <ErrorNotice message={error || job?.error_message || ""} />
      <SuccessNotice message={success} />
      {!job ? (
        <Loading label="학습 작업 불러오는 중" />
      ) : (
        <>
          <div className="row-actions toolbar-actions lifecycle-toolbar">
            {canTrain && active && (
              <button className="btn danger" disabled={busy === "cancel"} onClick={() => void action("cancel")}>
                학습 중지
              </button>
            )}
            {canTrain && ["failed", "cancelled"].includes(job.status) && (
              <p className="form-hint" data-testid="retry-hint">
                다시 실행은 기존 설정을 그대로 사용해 학습을 다시 시작합니다. 설정을 변경하려면 ‘설정 복제’를 사용하세요.
              </p>
            )}
            {canTrain && (
              <Link
                className="btn secondary"
                to={`/projects/${projectId}/jobs/new?cloneFrom=${job.id}`}
                data-testid="job-clone"
              >
                설정 복제
              </Link>
            )}
            {job.mlflow_run_id && (
              <Link className="btn secondary" to={`/projects/${projectId}/experiments/runs/${job.mlflow_run_id}`}>
                실험 결과 보기
              </Link>
            )}
            {showRetrainAction && canRegister && job.model_uri && (
              <button type="button" className="btn secondary" data-testid="job-retrain" onClick={() => setShowRetrain(true)}>
                전체 재학습
              </button>
            )}
            {showContinueAction && canRegister && job.model_uri && (
              <button type="button" className="btn secondary" data-testid="job-continue" onClick={() => setShowContinue(true)}>
                이어서 학습
              </button>
            )}
          </div>

          {showRetrainAction && (
            <p className="form-hint" data-testid="retrain-continue-hint">
              <strong>전체 재학습 (Full retrain)</strong>은 모델과 전처리를 처음부터 다시 학습합니다.
              {supportsContinued ? (
                <>
                  {" "}
                  <strong>이어서 학습 (Continue training)</strong>은 기존 전처리를 재사용하고 같은 데이터셋의 새 버전으로 지원되는 모델을 추가 학습합니다.
                </>
              ) : algorithmSpec ? (
                <> {algorithmSpec.display_name}은 이어서 학습을 지원하지 않습니다.</>
              ) : null}
            </p>
          )}

          <section className="metric-summary-panel" aria-label="학습 평가 지표">
            <div className="panel-title">
              <div>
                <span className="eyebrow">성능</span>
                <h2>평가 지표 (Metrics)</h2>
              </div>
            </div>
            <MetricSummary
              metrics={job.metrics}
              problemType={job.problem_type}
              targetColumns={targets}
              showMetricHelp
              labels={{
                emptyTitle: "평가 지표",
                emptyHint: "학습 완료 후 확인할 수 있습니다.",
                primaryPrefix: "대표 지표:",
              }}
            />
          </section>

          <div className="two-column detail-two-column">
            <DetailSection eyebrow="설정" title="학습 설정 (Training setup)">
              {job.is_retrain && job.retrain_source_job_id && (
                <p data-testid="job-retrain-lineage">
                  재학습 원본{" "}
                  <Link to={`/projects/${projectId}/jobs/${job.retrain_source_job_id}`}>
                    학습 작업 #{job.retrain_source_job_id}
                  </Link>
                </p>
              )}
              {job.is_continued_training && job.continued_from_job_id && (
                <p data-testid="job-continue-lineage">
                  이어서 학습 원본{" "}
                  <Link to={`/projects/${projectId}/jobs/${job.continued_from_job_id}`}>
                    학습 작업 #{job.continued_from_job_id}
                  </Link>
                </p>
              )}
              <dl className="key-values">
                <div><dt><TermLabel ko="학습 알고리즘" en="Algorithm" help={UI_HELP.algorithm} /></dt><dd>{job.algorithm.replaceAll("_", " ")}</dd></div>
                {job.training_mode && (
                  <div data-testid="job-training-mode">
                    <dt><TermLabel ko="학습 방식" en="Training mode" help={UI_HELP.trainingMode} /></dt>
                    <dd>{trainingModeLabel(job.training_mode)}</dd>
                  </div>
                )}
                <div data-testid="job-training-task">
                  <dt><TermLabel ko="학습 유형" en="Task" help={UI_HELP.trainingTask} /></dt>
                  <dd>{trainingTaskLabel(job.training_task)}</dd>
                </div>
                <div data-testid="job-problem-type">
                  <dt><TermLabel ko="예측 문제 유형" en="Problem type" help={UI_HELP.problemType} /></dt>
                  <dd>{problemTypeLabel(resolveDisplayProblemType(job.problem_type, job.metrics))}</dd>
                </div>
                <div data-testid="job-target-columns">
                  <dt>
                    {job.training_task === "forecasting"
                      ? "예측 대상 (Forecast target)"
                      : isMultiOutputJob(job)
                        ? "예측 대상들 (Targets)"
                        : "예측 대상 (Target)"}
                  </dt>
                  <dd><TargetChips targets={targets} /></dd>
                </div>
                {job.training_task === "forecasting" ? (
                  <>
                    <div data-testid="job-forecast-strategy">
                      <dt>예측 방식 (Forecast strategy)</dt>
                      <dd>
                        {job.forecast_strategy === "direct_multioutput"
                          ? "직접 다중 출력 (Direct multi-output)"
                          : job.forecast_strategy || "—"}
                      </dd>
                    </div>
                    <div data-testid="job-forecast-horizons">
                      <dt>미래 예측 시점 (Forecast horizons)</dt>
                      <dd>
                        {Array.isArray(job.forecast_horizons) && job.forecast_horizons.length
                          ? job.forecast_horizons.join(", ")
                          : "—"}
                      </dd>
                    </div>
                    <div data-testid="job-forecast-outputs">
                      <dt>예측 출력 항목 (Outputs)</dt>
                      <dd>
                        {Array.isArray(job.forecast_output_names) && job.forecast_output_names.length ? (
                          <TargetChips targets={job.forecast_output_names} />
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt><TermLabel ko="입력 항목" en="Features" help={UI_HELP.features} /></dt>
                  <dd>{job.feature_columns?.length ? `${job.feature_columns.length}개 컬럼` : "—"}</dd>
                </div>
                <div>
                  <dt>데이터셋 (Dataset)</dt>
                  <dd>
                    <Link to={`/projects/${projectId}/datasets/${job.dataset_id}`}>
                      데이터셋 #{job.dataset_id}
                    </Link>
                    {job.dataset_version_id ? (
                      <span className="mono"> · 버전 ID #{job.dataset_version_id}</span>
                    ) : null}
                  </dd>
                </div>
                <div data-testid="job-data-split">
                  <dt><TermLabel ko="데이터 분할" en="Data split" help={UI_HELP.dataSplit} /></dt>
                  <dd>
                    {job.split_id ? (
                      <>
                        <div>저장된 분할 #{job.split_id}</div>
                        <div data-testid="job-split-strategy-label">
                          방식: {splitStrategyLabel(job.split_strategy)}
                        </div>
                        {(job.split_strategy || "random") === "time" && job.time_column ? (
                          <div data-testid="job-time-column-label">
                            시간 기준 컬럼 (Time column): {job.time_column}
                          </div>
                        ) : null}
                        <small>
                          {job.ratios
                            ? `학습 ${Math.round(job.ratios.train * 100)}% · 검증 ${Math.round(job.ratios.validation * 100)}% · 테스트 ${Math.round(job.ratios.test * 100)}%`
                            : "—"}
                          {(job.split_strategy || "random") === "random" &&
                          typeof job.random_seed === "number"
                            ? ` · 시드 ${job.random_seed}`
                            : ""}
                        </small>
                      </>
                    ) : (
                      <>
                        <div>실행 시 분할</div>
                        <div data-testid="job-split-strategy-label">
                          방식: {splitStrategyLabel(job.split_strategy)}
                        </div>
                        {(job.split_strategy || "random") === "time" && job.time_column ? (
                          <div data-testid="job-time-column-label">
                            시간 기준 컬럼 (Time column): {job.time_column}
                          </div>
                        ) : null}
                        <small>
                          {job.ratios
                            ? `${Math.round(job.ratios.train * 100)}/${Math.round(job.ratios.validation * 100)}/${Math.round(job.ratios.test * 100)}`
                            : "70/15/15"}
                          {(job.split_strategy || "random") === "random"
                            ? typeof job.random_seed === "number"
                              ? ` · 시드 ${job.random_seed}`
                              : " · 시드 42"
                            : ""}
                        </small>
                      </>
                    )}
                  </dd>
                </div>
                <div><dt>시작 시각 (Started)</dt><dd>{formatDate(job.started_at)}</dd></div>
                <div><dt>완료 시각 (Finished)</dt><dd data-testid="job-finished-at">{formatDate(job.finished_at)}</dd></div>
              </dl>
            </DetailSection>

            <EntityLineage
              eyebrow="이력"
              title="학습 연결 경로"
              items={[
                {
                  label: "데이터셋",
                  value: `데이터셋 #${job.dataset_id}`,
                  to: `/projects/${projectId}/datasets/${job.dataset_id}`,
                },
                {
                  label: "실험 실행",
                  value: job.mlflow_run_id || "—",
                  to: job.mlflow_run_id
                    ? `/projects/${projectId}/experiments/runs/${job.mlflow_run_id}`
                    : undefined,
                  mono: true,
                },
                ...(job.is_retrain && job.retrain_source_job_id
                  ? [
                      {
                        label: "재학습 원본",
                        value: `학습 작업 #${job.retrain_source_job_id}`,
                        to: `/projects/${projectId}/jobs/${job.retrain_source_job_id}`,
                      },
                    ]
                  : []),
                ...(job.is_continued_training && job.continued_from_job_id
                  ? [
                      {
                        label: "이어서 학습 원본",
                        value: `학습 작업 #${job.continued_from_job_id}`,
                        to: `/projects/${projectId}/jobs/${job.continued_from_job_id}`,
                      },
                    ]
                  : []),
              ]}
            />
          </div>

          <DetailSection eyebrow="모델 설정" title="세부 학습 설정 (Hyperparameters)">
            <div className="engineering-surface">
              <pre className="json-view">{JSON.stringify(job.hyperparameters, null, 2)}</pre>
            </div>
          </DetailSection>

          <DetailSection
            eyebrow="실행"
            title="실행 로그 (Logs)"
            actions={active ? <span className="live-indicator"><span /> 실시간</span> : undefined}
          >
            <div className="engineering-surface">
              <div className="logs" data-testid="job-logs">{job.logs || "학습 시작을 기다리는 중…"}</div>
            </div>
          </DetailSection>

          {showRegister && (
            <RegisterModelDialog
              job={job}
              busy={busy === "register"}
              onClose={() => setShowRegister(false)}
              onSubmit={register}
            />
          )}
          {showRetrain && (
            <JobRetrainDialog
              projectId={projectId!}
              sourceJob={job}
              onClose={() => setShowRetrain(false)}
              onCreated={(created) => {
                setShowRetrain(false);
                navigate(`/projects/${projectId}/jobs/${created.id}`);
              }}
            />
          )}
          {showContinue && (
            <JobContinueTrainingDialog
              projectId={projectId!}
              sourceJob={job}
              onClose={() => setShowContinue(false)}
              onCreated={(created) => {
                setShowContinue(false);
                navigate(`/projects/${projectId}/jobs/${created.id}`);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
