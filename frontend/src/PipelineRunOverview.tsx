import { Link } from "react-router-dom";
import type { PipelineRun, PipelineVersion } from "./api";
import { StatusBadge } from "./components";
import { EntityLineage } from "./lifecycleComponents";
import {
  firstFailedPipelineNode,
  pipelineRunLineageItems,
  summarizePipelineRunProgress,
  summarizePipelineRunStages,
  type PipelineRunDisplayStatus,
} from "./pipelineRunUx";

function countSummary(counts: Record<PipelineRunDisplayStatus, number>): string {
  return ([
    ["running", counts.running],
    ["pending", counts.pending],
    ["succeeded", counts.succeeded],
    ["reused", counts.reused],
    ["failed", counts.failed],
    ["skipped", counts.skipped],
    ["cancelled", counts.cancelled],
  ] as Array<[string, number]>)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}

export function PipelineRunOverview({
  run,
  version,
  projectId,
  runLink,
  showLineage = true,
}: {
  run: PipelineRun;
  version?: PipelineVersion | null;
  projectId: string | number;
  runLink?: string;
  showLineage?: boolean;
}) {
  const progress = summarizePipelineRunProgress(run, version);
  const stages = summarizePipelineRunStages(run, version);
  const failedNode = firstFailedPipelineNode(run, version);
  const lineage = pipelineRunLineageItems(run, version, projectId);

  return (
    <>
      <section className="panel" data-testid="pipeline-run-overview">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Lifecycle execution</span>
            <h2>Run #{run.id}</h2>
          </div>
          <div className="row-actions">
            <StatusBadge status={run.status} />
            {runLink && (
              <Link className="btn link" to={runLink} data-testid="pipeline-run-overview-open">
                Open run
              </Link>
            )}
          </div>
        </div>

        <div className="grid stats-grid" data-testid="pipeline-run-progress">
          <div className="stat">
            <div className="label">Progress</div>
            <div className="value">{progress.percent}%</div>
            <small>{progress.terminal} / {progress.total} steps terminal</small>
          </div>
          <div className="stat">
            <div className="label">Running</div>
            <div className="value">{progress.counts.running}</div>
            <small>{progress.counts.pending} pending</small>
          </div>
          <div className="stat">
            <div className="label">Succeeded</div>
            <div className="value">{progress.counts.succeeded}</div>
            <small>{progress.counts.reused} reused</small>
          </div>
          <div className="stat">
            <div className="label">Needs attention</div>
            <div className="value">{progress.counts.failed}</div>
            <small>{progress.counts.skipped + progress.counts.cancelled} skipped/cancelled</small>
          </div>
        </div>

        {stages.length > 0 && (
          <div className="activity-list" data-testid="pipeline-run-stage-summary">
            {stages.map((stage) => (
              <div key={stage.id} className="source-card" data-testid={`pipeline-run-stage-${stage.id}`}>
                <div>
                  <strong>{stage.label}</strong>
                  <small>{countSummary(stage.counts) || `${stage.total} step${stage.total === 1 ? "" : "s"}`}</small>
                </div>
                <StatusBadge status={stage.status} />
              </div>
            ))}
          </div>
        )}

        {failedNode && (
          <div className="pipeline-validation-errors" data-testid="pipeline-run-recovery">
            <strong>{failedNode.label} failed</strong>
            <p>{failedNode.error || failedNode.reason || run.error_message || "The step did not complete."}</p>
            <p className="form-hint">
              Inspect this step and its upstream inputs. Rerun from failed restarts the failed step and
              its descendants while retaining successful upstream artifacts.
            </p>
            {runLink && (
              <Link className="btn secondary" to={runLink}>
                Inspect failed step
              </Link>
            )}
          </div>
        )}
      </section>

      {showLineage && lineage.length > 1 && <EntityLineage items={lineage} />}
    </>
  );
}
