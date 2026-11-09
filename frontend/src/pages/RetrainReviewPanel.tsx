import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Job, type ModelVersion } from "../api";
import { HelpTip } from "../components";
import { formatMetricLabel, metricHelpText, selectPrimaryMetric } from "../metricHelpers";

type Props = {
  job: Job;
  projectId: string;
  canRegister: boolean;
  onRegister: () => void;
  registeredModel: ModelVersion | null;
};

export default function RetrainReviewPanel({ job, projectId, canRegister, onRegister, registeredModel }: Props) {
  const sourceId = job.retrain_source_job_id;
  const [source, setSource] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState(false);

  useEffect(() => {
    if (!sourceId || !job.is_retrain || job.status !== "succeeded") return;
    let active = true;
    setLoading(true);
    setSource(null);
    setSourceError(false);
    const load = async () => {
      try {
        const result = await api<Job>(`/projects/${projectId}/jobs/${sourceId}`);
        if (!active) return;
        if (result?.id !== sourceId || result.project_id !== job.project_id) {
          setSourceError(true);
          return;
        }
        setSource(result);
      } catch {
        if (active) setSourceError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [job.is_retrain, job.project_id, job.status, projectId, sourceId]);

  const sharedMetric = useMemo(() => {
    if (!source?.metrics || !job.metrics) return null;
    const primary = selectPrimaryMetric(job.metrics, { problemType: job.problem_type });
    const candidateKeys = [primary?.key, ...Object.keys(job.metrics)].filter((key): key is string => Boolean(key));
    const key = candidateKeys.find((candidate) =>
      Number.isFinite(job.metrics[candidate]) && Number.isFinite(source.metrics[candidate]),
    );
    return key ? { key, before: source.metrics[key], after: job.metrics[key] } : null;
  }, [job.metrics, job.problem_type, source]);

  if (!sourceId || !job.is_retrain || job.status !== "succeeded") return null;

  const compareAvailable = Boolean(source?.mlflow_run_id && job.mlflow_run_id && source.mlflow_run_id !== job.mlflow_run_id);
  const differentVersions = Boolean(source && source.dataset_version_id !== job.dataset_version_id);
  const registered = registeredModel?.training_job_id === job.id ? registeredModel : null;
  const compareUrl = compareAvailable
    ? `/projects/${projectId}/experiments/compare?run_ids=${encodeURIComponent(`${source!.mlflow_run_id},${job.mlflow_run_id}`)}`
    : "";

  return (
    <section className="panel retrain-review-panel" aria-label="재학습 결과 검토" data-testid="job-retrain-review">
      <div className="panel-title">
        <div>
          <span className="eyebrow">재학습 완료 · 다음 단계</span>
          <h2>원본과 재학습 결과 비교</h2>
        </div>
      </div>
      <p className="form-hint">재학습 결과는 기존 운영 모델을 자동으로 교체하지 않습니다. 성능과 데이터 차이를 검토한 후 후보 모델로 등록하고 승인 절차를 진행하세요.</p>

      {loading ? <p className="form-hint" data-testid="retrain-source-loading">원본 학습 결과 확인 중…</p> : null}
      {sourceError ? (
        <p className="form-hint" data-testid="retrain-source-unavailable">
          원본 작업 정보를 불러오지 못했습니다. <Link to={`/projects/${projectId}/jobs/${sourceId}`}>원본 작업 #{sourceId} 확인</Link>
        </p>
      ) : null}
      {source && (
        <>
          <div className="retrain-review-compare-grid" data-testid="retrain-review-summary">
            <div>
              <strong>재학습 전</strong>
              <Link to={`/projects/${projectId}/jobs/${source.id}`}>{source.name}</Link>
              <small>데이터 버전 ID #{source.dataset_version_id ?? "—"}</small>
              {sharedMetric && <span className="retrain-review-metric">{sharedMetric.before.toFixed(3)}</span>}
            </div>
            <div>
              <strong>재학습 후</strong>
              <span>{job.name}</span>
              <small>데이터 버전 ID #{job.dataset_version_id ?? "—"}</small>
              {sharedMetric && <span className="retrain-review-metric">{sharedMetric.after.toFixed(3)}</span>}
            </div>
          </div>
          {sharedMetric && (
            <p className="form-hint" data-testid="retrain-shared-metric">
              공통 지표: {formatMetricLabel(sharedMetric.key)} <HelpTip text={metricHelpText(sharedMetric.key)} />
            </p>
          )}
          {differentVersions ? (
            <p className="retrain-review-caution" data-testid="retrain-version-caution">
              데이터 버전이 다릅니다. 검증·테스트 데이터 구성도 달라질 수 있으므로, 표시된 점수만으로 성능 향상을 단정하지 마세요.
            </p>
          ) : (
            <p className="form-hint">같은 데이터 버전이라도 분할 방식이나 평가 표본이 다르면 점수를 직접 비교하기 어렵습니다.</p>
          )}
        </>
      )}

      <ol className="retrain-review-steps">
        <li>
          <strong>1. 학습 결과 비교</strong>
          <p>원본·재학습 실행의 평가 지표와 학습 설정을 확인합니다.</p>
          {compareAvailable ? (
            <Link className="btn secondary" to={compareUrl} data-testid="retrain-compare-runs">두 학습 실행 비교</Link>
          ) : (
            <span className="form-hint" data-testid="retrain-compare-unavailable">
              {loading ? "원본 실행 정보 확인 중…" : "두 학습 실행 기록을 확인할 수 없어 비교 링크를 제공하지 않습니다."}
            </span>
          )}
        </li>
        <li>
          <strong>2. 후보 모델 등록</strong>
          <p>비교를 마쳤다면 재학습 결과를 후보로 등록합니다. 등록만으로 운영에 반영되지는 않습니다.</p>
          {registered ? (
            <Link className="btn secondary" to={`/projects/${projectId}/models/${registered.id}`} data-testid="retrain-registered-model">
              등록한 모델 {registered.name} v{registered.version} 검토
            </Link>
          ) : canRegister ? (
            <button className="btn secondary" type="button" onClick={onRegister} data-testid="retrain-register-model">후보 모델 등록</button>
          ) : (
            <span className="form-hint">모델 등록은 모델 엔지니어 또는 프로젝트 관리자가 할 수 있습니다.</span>
          )}
        </li>
        <li>
          <strong>3. 검증·승인 후 운영 전환</strong>
          <p>적합성 검증 → 승인 요청 → 관리자 승인 → 운영 모델 전환 → 배포 확인 순서로 진행합니다.</p>
          <Link className="btn secondary" to={`/projects/${projectId}/models`} data-testid="retrain-registry-link">모델 관리로 이동</Link>
        </li>
      </ol>
    </section>
  );
}
