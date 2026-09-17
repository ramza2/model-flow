import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Pipeline, type PipelineRun, type PipelineVersion } from "../api";
import { ErrorNotice, Loading, StatusBadge } from "../components";
import { PIPELINE_LIFECYCLE_STAGES } from "../pipelineHelpers";
import {
  collectPipelineLineage,
  summarizePipelineRunLifecycle,
  type LifecycleStageSummary,
} from "../pipelineRunUx";
import { PipelineBuilder, PipelineRunDetail } from "./Pipelines";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "canceled"]);

function StageStrip({ stages, showStatus }: { stages: LifecycleStageSummary[]; showStatus: boolean }) {
  return (
    <div className="activity-list" data-testid="pipeline-lifecycle-stages">
      {stages.map((stage) => (
        <div key={stage.id} data-testid={`pipeline-lifecycle-stage-${stage.id}`}>
          <div>
            <strong>{stage.label}</strong>
            <small>
              {stage.total === 0
                ? "No steps"
                : `${stage.terminal}/${stage.total} terminal step${stage.total === 1 ? "" : "s"}`}
            </small>
          </div>
          {stage.total > 0 && showStatus ? (
            <StatusBadge status={stage.status} />
          ) : stage.total > 0 ? (
            <span className="muted">Configured</span>
          ) : null}
        </div>
      ))}
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
            <span className="eyebrow">Lifecycle coverage</span>
            <h2>End-to-end workflow</h2>
          </div>
          {latestRun ? (
            <Link className="btn link" to={`/projects/${projectId}/pipeline-runs/${latestRun.id}`}>
              Latest run #{latestRun.id}
            </Link>
          ) : null}
        </div>
        <ErrorNotice message={error} />
        {!pipeline ? (
          <Loading label="Loading lifecycle summary" />
        ) : (
          <>
            <p className="form-hint">
              {latestMatchesGraph
                ? `Latest run uses this saved pipeline version · ${summary.progressPercent}% terminal.`
                : latestRun
                  ? "Latest run used another saved pipeline version. Stage cards below describe the current graph without borrowing historical run state."
                  : "Stage cards describe the current saved graph. Run state appears after this version executes."}
            </p>
            <StageStrip stages={summary.stages} showStatus={latestMatchesGraph} />
          </>
        )}
      </section>
      <PipelineBuilder />
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
            <span className="eyebrow">Unified execution</span>
            <h2>Lifecycle progress</h2>
          </div>
          {run ? <StatusBadge status={run.status} /> : null}
        </div>
        <ErrorNotice message={error} />
        {!run || !version ? (
          <Loading label="Loading pipeline run lifecycle" />
        ) : (
          <>
            <p data-testid="pipeline-run-progress">
              <strong>{summary.progressPercent}%</strong> · {summary.terminal}/{summary.total} steps terminal
            </p>
            {firstFailed ? (
              <div className="notice" data-testid="pipeline-run-recovery-cue">
                <strong>Recovery focus: {firstFailed}</strong>
                <p>
                  The run detail below automatically focuses the first failed step. Inspect its error and artifacts, fix the cause, then use <strong>Rerun from failed</strong> when available.
                </p>
                <a className="btn link" href="#pipeline-run-execution-detail">Open failed-step detail</a>
              </div>
            ) : firstRunning ? (
              <p className="form-hint" data-testid="pipeline-run-active-cue">
                Currently running: {firstRunning}
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
              <span className="eyebrow">Lineage</span>
              <h2>Resources produced or consumed</h2>
            </div>
          </div>
          <div className="activity-list">
            <div>
              <div>
                <strong>Pipeline version</strong>
                <small>Version #{run.pipeline_version_id}</small>
              </div>
              <Link className="btn link" to={`/projects/${projectId}/pipelines/${run.pipeline_id}`}>
                Open pipeline
              </Link>
            </div>
            {lineage.map((ref) => (
              <div key={`${ref.kind}-${ref.id}`} data-testid={`pipeline-lineage-${ref.kind}-${ref.id}`}>
                <div>
                  <strong>{ref.label}</strong>
                  <small>{ref.kind.replaceAll("_", " ")}</small>
                </div>
                {ref.to ? (
                  <Link className="btn link" to={ref.to}>Open</Link>
                ) : (
                  <span className="muted">Recorded</span>
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
