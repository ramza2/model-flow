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
  formatMetricKeyLabel,
  parseTargetsFromParams,
  runDisplayName,
} from "../lifecycleHelpers";

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
        setError(reason instanceof Error ? reason.message : "Experiment run could not be loaded."),
      )
      .finally(() => setLoading(false));
  }, [projectId, runId]);

  const displayName = run ? runDisplayName(run) : "Experiment run";
  const problemType = String(run?.params.problem_type ?? run?.tags["modelflow.problem_type"] ?? "");
  const algorithm = String(run?.params.algorithm ?? run?.tags["modelflow.algorithm"] ?? "—");
  const targets = run ? parseTargetsFromParams(run.params) : [];
  const jobId = run?.tags["modelflow.training_job_id"] || run?.tags.training_job_id || "";

  return (
    <div>
      <PageHeader
        title={displayName}
        description="Tracked parameters, metrics, tags, and artifact lineage for this MLflow run."
        actions={run ? <StatusBadge status={run.status} /> : undefined}
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Loading label="Loading experiment run" />
      ) : !run ? null : (
        <>
          <div className="row-actions toolbar-actions">
            <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>
              ← Back to experiments
            </Link>
            {jobId ? (
              <Link className="btn secondary" to={`/projects/${projectId}/jobs/${jobId}`} data-testid="open-training-job">
                Open training job
              </Link>
            ) : null}
          </div>

          <DetailSection eyebrow="Run" title="Summary">
            <dl className="key-values">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={run.status} />
                </dd>
              </div>
              <div>
                <dt>Algorithm</dt>
                <dd>{algorithm}</dd>
              </div>
              <div>
                <dt>Problem type</dt>
                <dd>{problemType || "—"}</dd>
              </div>
              <div data-testid="run-targets">
                <dt>Targets</dt>
                <dd>
                  <TargetChips targets={targets} />
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{run.start_time ? formatDate(new Date(run.start_time).toISOString()) : "—"}</dd>
              </div>
              <div>
                <dt>Finished</dt>
                <dd>{run.end_time ? formatDate(new Date(run.end_time).toISOString()) : "—"}</dd>
              </div>
            </dl>
            <MetricSummary
              metrics={run.metrics}
              problemType={problemType || undefined}
              targetColumns={targets}
            />
          </DetailSection>

          <EntityLineage
            items={[
              ...(jobId
                ? [
                    {
                      label: "Training job",
                      value: `Job #${jobId}`,
                      to: `/projects/${projectId}/jobs/${jobId}`,
                    },
                  ]
                : [{ label: "Training job", value: "Not linked in run tags" }]),
              {
                label: "MLflow run id",
                value: run.run_id,
                mono: true,
              },
              {
                label: "Artifact URI",
                value: run.artifact_uri || "—",
                mono: true,
              },
            ]}
          />

          <DetailSection eyebrow="Metrics" title="Logged metrics">
            {Object.keys(run.metrics).length === 0 ? (
              <p>—</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Label</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(run.metrics).map(([key, value]) => (
                      <tr key={key}>
                        <td className="mono">{key}</td>
                        <td>{formatMetricKeyLabel(key)}</td>
                        <td>{Number(value).toFixed(6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DetailSection>

          <div className="two-column">
            <DetailSection eyebrow="Parameters" title="Run parameters">
              <TechnicalBlock>
                <pre className="json-view" data-testid="run-params-json">
                  {JSON.stringify(run.params, null, 2)}
                </pre>
              </TechnicalBlock>
            </DetailSection>
            <DetailSection eyebrow="Tags" title="Run tags">
              {Object.keys(run.tags).length === 0 ? (
                <p>—</p>
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

          <DetailSection eyebrow="Technical" title="Identifiers">
            <dl className="key-values">
              <div>
                <dt>Run ID</dt>
                <dd className="mono break-word">{run.run_id}</dd>
              </div>
              <div>
                <dt>Experiment ID</dt>
                <dd className="mono">{run.experiment_id}</dd>
              </div>
              <div>
                <dt>Artifact URI</dt>
                <dd className="mono break-word">{run.artifact_uri || "—"}</dd>
              </div>
            </dl>
          </DetailSection>
        </>
      )}
    </div>
  );
}
