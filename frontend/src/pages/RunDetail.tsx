import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Run } from "../api";
import {
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  formatDate,
} from "../components";
import {
  DetailSection,
  EntityLineage,
  MetricSummary,
  TargetChips,
  TechnicalBlock,
} from "../lifecycleComponents";
import {
  parseTargetsFromParams,
  resolveTrainingJobIdFromRun,
  runDisplayName,
} from "../lifecycleHelpers";
import { formatMetricLabel } from "../metricHelpers";
import { problemTypeLabel, runStatusLabel } from "../uiTerminology";

export default function RunDetail() {
  const { projectId, runId } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId || !runId) return;
    setLoading(true);
    api<Run>(`/projects/${projectId}/experiments/runs/${runId}`)
      .then(setRun)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "실험 실행 정보를 불러오지 못했습니다."),
      )
      .finally(() => setLoading(false));
  }, [projectId, runId]);

  const displayName = run ? runDisplayName(run) : "실험 실행";
  const problemType = String(run?.params.problem_type ?? run?.tags["modelflow.problem_type"] ?? "");
  const algorithm = String(run?.params.algorithm ?? run?.tags["modelflow.algorithm"] ?? "—");
  const targets = run ? parseTargetsFromParams(run.params) : [];
  const jobId = run ? resolveTrainingJobIdFromRun(run) : null;

  return (
    <div>
      <PageHeader
        title={displayName}
        description="모델 학습 실행의 상태와 성능, 연결된 학습 작업 및 기록된 설정을 확인합니다."
        actions={
          run ? (
            <span className="header-status">
              <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
            </span>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Loading label="실험 실행 정보 불러오는 중" />
      ) : !run ? null : (
        <>
          <div className="row-actions toolbar-actions lifecycle-toolbar">
            <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>
              ← 실험 비교로 돌아가기
            </Link>
            {jobId ? (
              <Link className="btn secondary" to={`/projects/${projectId}/jobs/${jobId}`} data-testid="open-training-job">
                학습 작업 보기
              </Link>
            ) : null}
          </div>

          <DetailSection eyebrow="실행" title="실행 요약">
            <dl className="key-values">
              <div>
                <dt>상태</dt>
                <dd>
                  <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
                </dd>
              </div>
              <div>
                <dt>학습 알고리즘</dt>
                <dd className="catalog-secondary-text">{algorithm.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>예측 문제 유형</dt>
                <dd>
                  {problemType ? (
                    <span className="type-chip">{problemTypeLabel(problemType)}</span>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div data-testid="run-targets">
                <dt>예측 대상</dt>
                <dd>
                  <TargetChips targets={targets} />
                </dd>
              </div>
              <div>
                <dt>시작 시각</dt>
                <dd className="catalog-meta-date">
                  {run.start_time ? formatDate(new Date(run.start_time).toISOString()) : "—"}
                </dd>
              </div>
              <div>
                <dt>완료 시각</dt>
                <dd className="catalog-meta-date">
                  {run.end_time ? formatDate(new Date(run.end_time).toISOString()) : "—"}
                </dd>
              </div>
            </dl>
          </DetailSection>

          <section className="metric-summary-panel" aria-label="실험 실행 평가 지표">
            <div className="panel-title">
              <div>
                <span className="eyebrow">성능</span>
                <h2>평가 지표 (Metrics)</h2>
              </div>
            </div>
            <MetricSummary
              metrics={run.metrics}
              problemType={problemType || undefined}
              targetColumns={targets}
              showMetricHelp
              labels={{
                emptyTitle: "평가 지표",
                emptyHint: "실행 결과에 기록된 평가 지표가 없습니다.",
                primaryPrefix: "대표 지표:",
              }}
            />
          </section>

          <EntityLineage
            eyebrow="이력"
            title="학습 연결 경로"
            items={[
              ...(jobId
                ? [
                    {
                      label: "학습 작업",
                      value: `학습 작업 #${jobId}`,
                      to: `/projects/${projectId}/jobs/${jobId}`,
                    },
                  ]
                : [{ label: "학습 작업", value: "연결된 학습 작업 정보가 없습니다." }]),
              {
                label: "MLflow 실행 ID",
                value: run.run_id,
                mono: true,
              },
              {
                label: "산출물 URI (Artifact URI)",
                value: run.artifact_uri || "—",
                mono: true,
              },
            ]}
          />

          <DetailSection eyebrow="지표" title="전체 평가 지표 기록">
            {Object.keys(run.metrics).length === 0 ? (
              <p className="catalog-empty-meta">—</p>
            ) : (
              <div className="table-wrap catalog-table metrics-table">
                <table>
                  <thead>
                    <tr>
                      <th>지표 키</th>
                      <th>표시 이름</th>
                      <th>측정값</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(run.metrics).map(([key, value]) => (
                      <tr key={key}>
                        <td className="mono">{key}</td>
                        <td>{formatMetricLabel(key, targets)}</td>
                        <td className="tabular-num">{Number(value).toFixed(6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DetailSection>

          <div className="two-column detail-two-column">
            <DetailSection eyebrow="설정" title="실행 설정 원문 (Parameters)">
              <p className="catalog-empty-meta">
                학습 실행 시 기록된 설정입니다. 원본 값을 확인하기 위한 정보이며 이 화면에서 수정할 수 없습니다.
              </p>
              <TechnicalBlock>
                <div className="engineering-surface">
                  <pre className="json-view" data-testid="run-params-json">
                    {JSON.stringify(run.params, null, 2)}
                  </pre>
                </div>
              </TechnicalBlock>
            </DetailSection>
            <DetailSection eyebrow="태그" title="실행 태그 (Tags)">
              {Object.keys(run.tags).length === 0 ? (
                <p className="catalog-empty-meta">—</p>
              ) : (
                <dl className="key-values">
                  {Object.entries(run.tags).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd className="mono break-word">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </DetailSection>
          </div>

          <DetailSection eyebrow="기술 정보" title="기술 식별자 (Identifiers)">
            <dl className="key-values">
              <div>
                <dt>실행 ID (Run ID)</dt>
                <dd className="mono break-word">{run.run_id}</dd>
              </div>
              <div>
                <dt>실험 ID (Experiment ID)</dt>
                <dd className="mono">{run.experiment_id}</dd>
              </div>
              <div>
                <dt>산출물 URI (Artifact URI)</dt>
                <dd className="mono break-word">{run.artifact_uri || "—"}</dd>
              </div>
            </dl>
          </DetailSection>
        </>
      )}
    </div>
  );
}
