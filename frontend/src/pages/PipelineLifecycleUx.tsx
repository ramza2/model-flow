import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Pipeline, type PipelineRun, type PipelineVersion } from "../api";
import { ErrorNotice, HelpTip, Loading, StatusBadge } from "../components";
import { PIPELINE_LIFECYCLE_STAGES } from "../pipelineHelpers";
import {
  collectPipelineLineage,
  summarizePipelineRunLifecycle,
  type LifecycleStageSummary,
} from "../pipelineRunUx";
import {
  UI_HELP,
  lifecycleStageDisplayLabel,
  pipelineRunStatusLabel,
} from "../uiTerminology";
import { setUnsavedChangesActive } from "../unsavedChanges";
import { PipelineBuilder, PipelineRunDetail } from "./Pipelines";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "canceled"]);

function StageStrip({
  stages,
  showStatus,
}: {
  stages: LifecycleStageSummary[];
  showStatus: boolean;
}) {
  return (
    <div className="activity-list" data-testid="pipeline-lifecycle-stages">
      {stages.map((stage) => {
        const label = lifecycleStageDisplayLabel(stage.id);
        let countLabel: string;
        if (stage.total === 0) {
          countLabel = "구성된 노드 없음";
        } else if (!showStatus) {
          countLabel = `구성 노드 ${stage.total}개`;
        } else {
          countLabel = `종료 ${stage.terminal}/${stage.total}`;
        }
        return (
          <div key={stage.id} data-testid={`pipeline-lifecycle-stage-${stage.id}`}>
            <div>
              <strong>{label}</strong>
              <small>{countLabel}</small>
            </div>
            {stage.total > 0 && showStatus ? (
              <StatusBadge
                status={stage.status}
                label={pipelineRunStatusLabel(stage.status)}
              />
            ) : stage.total > 0 ? (
              <span className="muted">노드 구성됨</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PipelineBuilderWithUnsavedBridge() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const sync = () => {
      setUnsavedChangesActive(Boolean(host.querySelector("[data-testid='pipeline-dirty-badge']")));
    };
    const observer = new MutationObserver(sync);
    observer.observe(host, { childList: true, subtree: true });
    sync();

    return () => {
      observer.disconnect();
      setUnsavedChangesActive(false);
    };
  }, []);

  return (
    <div ref={hostRef} data-testid="pipeline-builder-unsaved-bridge">
      <PipelineBuilder />
    </div>
  );
}

export function PipelineBuilderLifecyclePage() {
  const { projectId, pipelineId } = useParams();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [latestRun, setLatestRun] = useState<PipelineRun | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projectId || !pipelineId) return;
    let cancelled = false;
    Promise.all([
      api<Pipeline>(`/projects/${projectId}/pipelines/${pipelineId}`),
      api<PipelineRun[]>(`/projects/${projectId}/pipelines/${pipelineId}/runs`),
    ])
      .then(([row, runs]) => {
        if (cancelled) return;
        setPipeline(row);
        setLatestRun(runs[0] || null);
        setError("");
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Pipeline lifecycle summary could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, projectId]);

  const graph = pipeline?.version?.graph;
  const latestMatchesGraph = Boolean(
    latestRun && pipeline?.version?.id && latestRun.pipeline_version_id === pipeline.version.id,
  );
  const summary = useMemo(
    () => summarizePipelineRunLifecycle(graph, latestMatchesGraph ? latestRun?.node_states : undefined),
    [graph, latestMatchesGraph, latestRun?.node_states],
  );

  return (
    <>
      <section className="panel" data-testid="pipeline-builder-lifecycle-summary">
        <div className="panel-title">
          <div>
            <span className="eyebrow">단계별 구성 현황 (Lifecycle Coverage)</span>
            <h2>파이프라인 전체 구성</h2>
          </div>
          {latestRun ? (
            <Link className="btn link" to={`/projects/${projectId}/pipeline-runs/${latestRun.id}`}>
              최근 실행 #{latestRun.id}
            </Link>
          ) : null}
        </div>
        <ErrorNotice message={error} />
        {!pipeline ? (
          <Loading label="단계별 구성 현황을 불러오는 중…" />
        ) : (
          <>
            <p className="form-hint" data-testid="pipeline-lifecycle-saved-hint">
              이 영역은 마지막으로 저장된 파이프라인 버전을 기준으로 단계별 노드 구성을 보여줍니다.
              저장하지 않은 편집 내용은 반영되지 않을 수 있습니다.
              <HelpTip text={UI_HELP.pipelineLifecycleCoverage} />
            </p>
            <p className="form-hint" data-testid="pipeline-lifecycle-run-hint">
              {latestMatchesGraph
                ? `최근 실행이 현재 저장 버전과 일치합니다 · 종료 진행률 ${summary.progressPercent}% (실패·취소·건너뜀 등 종료 상태 포함, 성공률이 아님).`
                : latestRun
                  ? "최근 실행은 다른 저장 버전을 사용했습니다. 아래 카드는 현재 저장 그래프의 구성만 보여 주며, 과거 실행 상태를 현재 버전 결과처럼 사용하지 않습니다."
                  : "실행 이력이 없습니다. 아래 카드는 현재 저장 그래프의 구성만 보여 줍니다. 이 버전을 실행하면 실행 상태가 표시됩니다."}
            </p>
            <StageStrip stages={summary.stages} showStatus={latestMatchesGraph} />
          </>
        )}
      </section>
      <PipelineBuilderWithUnsavedBridge />
    </>
  );
}

export function PipelineRunLifecyclePage() {
  const { projectId, runId } = useParams();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [version, setVersion] = useState<PipelineVersion | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!projectId || !runId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const row = await api<PipelineRun>(`/projects/${projectId}/pipeline-runs/${runId}`);
        if (cancelled) return;
        setRun(row);
        setError("");
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Pipeline run summary could not be loaded.");
        }
      }
    };
    void load();
    const isTerminal = run ? TERMINAL_RUN_STATUSES.has(String(run.status).toLowerCase()) : false;
    const timer = isTerminal ? undefined : window.setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [projectId, runId, run?.status]);

  useEffect(() => {
    if (!projectId || !run?.pipeline_version_id) return;
    let cancelled = false;
    api<PipelineVersion>(`/projects/${projectId}/pipeline-versions/${run.pipeline_version_id}`)
      .then((row) => {
        if (!cancelled) setVersion(row);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Pipeline version lineage could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, run?.pipeline_version_id]);

  const summary = useMemo(
    () => summarizePipelineRunLifecycle(version?.graph, run?.node_states),
    [run?.node_states, version?.graph],
  );
  const lineage = useMemo(
    () => collectPipelineLineage(projectId || "", version?.graph, run),
    [projectId, run, version?.graph],
  );
  const firstFailed = summary.failedNodeIds[0];
  const firstRunning = summary.runningNodeIds[0];

  return (
    <>
      <section className="panel" data-testid="pipeline-run-lifecycle-summary">
        <div className="panel-title">
          <div>
            <span className="eyebrow">통합 실행 현황</span>
            <h2>단계별 실행 진행 현황</h2>
          </div>
          {run ? (
            <StatusBadge status={run.status} label={pipelineRunStatusLabel(run.status)} />
          ) : null}
        </div>
        <ErrorNotice message={error} />
        {!run || !version ? (
          <Loading label="실행 현황을 불러오는 중…" />
        ) : (
          <>
            <p data-testid="pipeline-run-progress">
              <strong>{summary.progressPercent}%</strong>
              {" · "}
              종료 {summary.terminal}/{summary.total}단계 (실패·취소·건너뜀 등 포함, 성공률이 아님)
            </p>
            {firstFailed ? (
              <div className="notice" data-testid="pipeline-run-recovery-cue">
                <strong>오류 확인이 필요한 단계: {firstFailed}</strong>
                <p>
                  아래 실행 상세에서 첫 실패 단계를 자동으로 선택합니다. 오류와 산출물을 확인한 뒤,
                  가능하면 <strong>실패 단계부터 다시 실행</strong>을 사용하세요.
                </p>
                <a className="btn link" href="#pipeline-run-execution-detail">
                  실패 단계 상세 보기
                </a>
              </div>
            ) : firstRunning ? (
              <p className="form-hint" data-testid="pipeline-run-active-cue">
                현재 실행 중: {firstRunning}
              </p>
            ) : null}
            <StageStrip stages={summary.stages} showStatus />
          </>
        )}
      </section>

      {run && version && (
        <section className="panel" data-testid="pipeline-run-lineage">
          <div className="panel-title">
            <div>
              <span className="eyebrow">작업 결과 추적 (Lineage)</span>
              <h2>사용·생성된 리소스</h2>
            </div>
          </div>
          <div className="activity-list">
            <div>
              <div>
                <strong>파이프라인 버전</strong>
                <small>Version #{run.pipeline_version_id}</small>
              </div>
              <Link className="btn link" to={`/projects/${projectId}/pipelines/${run.pipeline_id}`}>
                파이프라인 열기
              </Link>
            </div>
            {lineage.map((ref) => (
              <div key={`${ref.kind}-${ref.id}`} data-testid={`pipeline-lineage-${ref.kind}-${ref.id}`}>
                <div>
                  <strong>{ref.label}</strong>
                  <small>{ref.kind.replaceAll("_", " ")}</small>
                </div>
                {ref.to ? (
                  <Link className="btn link" to={ref.to}>
                    열기
                  </Link>
                ) : (
                  <span className="muted">기록됨</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <div id="pipeline-run-execution-detail">
        <PipelineRunDetail />
      </div>
    </>
  );
}

export const PIPELINE_LIFECYCLE_STAGE_COUNT = PIPELINE_LIFECYCLE_STAGES.length;
