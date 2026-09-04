import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiRequestError, type ModelVersion as ModelVersionType } from "../api";
import { useAuth } from "../AuthContext";
import {
  ErrorNotice,
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
import { parseTargetColumns, problemTypeLabel } from "../lifecycleHelpers";
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
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Model version could not be loaded."));
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
        name === "request-approval" ? "Approval requested."
          : name === "approve" ? "Model approved."
            : name === "reject" ? "Model rejected."
              : "Model promoted to production.",
      );
      setComment("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Lifecycle action failed.");
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
      setSuccess("Validation gates re-evaluated.");
    } catch (reason) {
      if (reason instanceof ApiRequestError) {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "Gate evaluation failed.");
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
  const canDeployLink = Boolean(mv && ["APPROVED", "PRODUCTION"].includes(mv.lifecycle));
  const canReject = Boolean(mv && canApprove && mv.lifecycle === "PENDING_APPROVAL");
  const canApproveNow = Boolean(mv && canApprove && mv.lifecycle === "PENDING_APPROVAL");

  const targets = useMemo(() => parseTargetColumns(mv?.metadata), [mv?.metadata]);
  const problemType = typeof mv?.metadata?.problem_type === "string" ? mv.metadata.problem_type : undefined;

  let primaryKind: "request" | "approve" | "promote" | "deploy" | "rerun" | null = null;
  let headerPrimary: ReactNode = null;
  if (mv) {
    if (canWrite && canRequestApproval) {
      primaryKind = "request";
      headerPrimary = (
        <button className="btn" disabled={Boolean(busy)} onClick={() => void action("request-approval")} data-testid="request-approval">
          Request approval
        </button>
      );
    } else if (canApproveNow) {
      primaryKind = "approve";
      headerPrimary = (
        <button className="btn" disabled={Boolean(busy)} onClick={() => void action("approve")} data-testid="approve-model">
          ✓ Approve
        </button>
      );
    } else if (canPromote) {
      primaryKind = "promote";
      headerPrimary = (
        <button className="btn" disabled={Boolean(busy)} onClick={() => void action("promote-production")} data-testid="promote-production">
          Promote to production
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
          Create deployment
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
          {busy === "evaluate-gates" ? "Validating…" : "Rerun validation"}
        </button>
      );
    }
  }

  return (
    <div>
      <PageHeader
        title={mv ? `${mv.name} · v${mv.version}` : "Model version"}
        description={
          mv
            ? `${problemTypeLabel(problemType)}${targets.length ? ` · ${targets.length} target${targets.length === 1 ? "" : "s"}` : ""}`
            : "Governance evidence, metrics, lineage, and deployment readiness."
        }
        actions={
          <>
            <StatusBadge status={mv?.lifecycle} />
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
          <div className="row-actions toolbar-actions">
            {canRerun && primaryKind !== "rerun" && (
              <button
                className="btn secondary"
                disabled={busy === "evaluate-gates"}
                onClick={() => void rerunValidation()}
                data-testid="rerun-validation"
              >
                {busy === "evaluate-gates" ? "Validating…" : "Rerun validation"}
              </button>
            )}
            {canReject && (
              <button className="btn danger" disabled={Boolean(busy)} onClick={() => void action("reject")} data-testid="reject-model">
                Reject
              </button>
            )}
            {canDeployLink && primaryKind !== "deploy" && (
              <Link
                className="btn secondary"
                to={`/projects/${projectId}/deployments`}
                state={{ modelVersionId: mv.id }}
                data-testid="create-deployment"
              >
                Create deployment
              </Link>
            )}
          </div>

          {showApprovalBlocked && canWrite && (
            <p className="form-hint" data-testid="approval-blocked-hint">
              Approval blocked. Validation gates must pass before approval can be requested.
            </p>
          )}

          <DetailSection eyebrow="Lifecycle" title="Progress">
            <LifecycleStepper lifecycle={mv.lifecycle} />
            {targets.length > 0 && (
              <div className="lifecycle-targets">
                <span className="eyebrow">Targets</span>
                <TargetChips targets={targets} testId="model-target-chips" />
              </div>
            )}
          </DetailSection>

          {(mv.lifecycle === "PENDING_APPROVAL" || RERUN_LIFECYCLES.includes(mv.lifecycle)) && (
            <label className="panel comment-field">
              Review comment
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Add context for the reviewer"
                data-testid="approval-comment-input"
              />
              <small className="form-hint">
                Stored approval evidence is shown below. Leaving this blank keeps the existing comment on approve/reject.
              </small>
            </label>
          )}

          <DetailSection eyebrow="Quality" title="Metrics">
            <MetricSummary
              metrics={mv.metrics}
              problemType={problemType}
              targetColumns={targets}
            />
          </DetailSection>

          <div className="two-column">
            <DetailSection eyebrow="Governance" title="Approval evidence" testId="approval-evidence">
              <dl className="key-values">
                <div>
                  <dt>Lifecycle</dt>
                  <dd>
                    <StatusBadge status={mv.lifecycle} />
                  </dd>
                </div>
                <div>
                  <dt>Gates</dt>
                  <dd>
                    <StatusBadge status={mv.gates_passed ? "passed" : "pending"} />
                  </dd>
                </div>
                <div>
                  <dt>Comment</dt>
                  <dd data-testid="approval-comment-value">{mv.approval_comment || "—"}</dd>
                </div>
                {mv.approved_at ? (
                  <div>
                    <dt>Approved at</dt>
                    <dd>{formatDate(mv.approved_at)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Registered</dt>
                  <dd>{formatDate(mv.created_at)}</dd>
                </div>
              </dl>
            </DetailSection>

            <EntityLineage
              items={[
                {
                  label: "Dataset version",
                  value: mv.dataset_version_id ? `Version #${mv.dataset_version_id}` : "—",
                },
                {
                  label: "Training job",
                  value: mv.training_job_id ? `Job #${mv.training_job_id}` : "—",
                  to: mv.training_job_id
                    ? `/projects/${projectId}/jobs/${mv.training_job_id}`
                    : undefined,
                },
                {
                  label: "Experiment run",
                  value: mv.mlflow_run_id || "—",
                  to: mv.mlflow_run_id
                    ? `/projects/${projectId}/experiments/runs/${mv.mlflow_run_id}`
                    : undefined,
                  mono: true,
                },
                {
                  label: "Model URI",
                  value: mv.model_uri || "—",
                  mono: true,
                },
                ...(mv.pipeline_run_id
                  ? [
                      {
                        label: "Pipeline run",
                        value: `Run #${mv.pipeline_run_id}`,
                        to: `/projects/${projectId}/pipeline-runs/${mv.pipeline_run_id}`,
                      },
                    ]
                  : []),
              ]}
            />
          </div>

          <DetailSection eyebrow="Validation" title="Gates">
            <GateSummary gatesPassed={mv.gates_passed} gateResults={mv.gate_results || {}} />
          </DetailSection>
        </>
      )}
    </div>
  );
}
