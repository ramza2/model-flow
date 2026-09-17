import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type PipelineRun, type PipelineVersion } from "../api";
import { ErrorNotice } from "../components";
import { PipelineRunOverview } from "../PipelineRunOverview";
import { PipelineBuilder, PipelineRunDetail } from "./Pipelines";

const ACTIVE_RUN_STATUSES = new Set(["created", "pending", "queued", "running", "cancel_requested"]);

function isActiveRun(status: string | null | undefined): boolean {
  return ACTIVE_RUN_STATUSES.has(String(status || "").toLowerCase());
}

export function PipelineBuilderLifecyclePage() {
  const { projectId, pipelineId } = useParams();
  const [latestRun, setLatestRun] = useState<PipelineRun | null>(null);
  const [error, setError] = useState("");

  const loadLatestRun = useCallback(async () => {
    if (!projectId || !pipelineId) return;
    try {
      const rows = await api<PipelineRun[]>(`/projects/${projectId}/pipelines/${pipelineId}/runs`);
      const latest = [...rows].sort((left, right) => right.id - left.id)[0] || null;
      setLatestRun(latest);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Latest pipeline run could not be loaded.");
    }
  }, [pipelineId, projectId]);

  useEffect(() => {
    void loadLatestRun();
  }, [loadLatestRun]);

  useEffect(() => {
    if (!latestRun || !isActiveRun(latestRun.status)) return;
    const timer = window.setInterval(() => void loadLatestRun(), 5000);
    return () => window.clearInterval(timer);
  }, [latestRun, loadLatestRun]);

  return (
    <>
      <PipelineBuilder />
      <ErrorNotice message={error} />
      {latestRun && projectId && (
        <PipelineRunOverview
          run={latestRun}
          projectId={projectId}
          showLineage={false}
          runLink={`/projects/${projectId}/pipeline-runs/${latestRun.id}`}
        />
      )}
    </>
  );
}

export function PipelineRunLifecyclePage() {
  const { projectId, runId } = useParams();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [version, setVersion] = useState<PipelineVersion | null>(null);
  const [error, setError] = useState("");

  const loadRun = useCallback(async () => {
    if (!projectId || !runId) return;
    try {
      const row = await api<PipelineRun>(`/projects/${projectId}/pipeline-runs/${runId}`);
      setRun(row);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline run overview could not be loaded.");
    }
  }, [projectId, runId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    if (!run || !isActiveRun(run.status)) return;
    const timer = window.setInterval(() => void loadRun(), 5000);
    return () => window.clearInterval(timer);
  }, [loadRun, run]);

  useEffect(() => {
    if (!projectId || !run?.pipeline_version_id) {
      setVersion(null);
      return;
    }
    let cancelled = false;
    api<PipelineVersion>(`/projects/${projectId}/pipeline-versions/${run.pipeline_version_id}`)
      .then((row) => {
        if (!cancelled) setVersion(row);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, run?.pipeline_version_id]);

  const overview = useMemo(() => {
    if (!run || !projectId) return null;
    return <PipelineRunOverview run={run} version={version} projectId={projectId} />;
  }, [projectId, run, version]);

  return (
    <>
      <ErrorNotice message={error} />
      {overview}
      <PipelineRunDetail />
    </>
  );
}
