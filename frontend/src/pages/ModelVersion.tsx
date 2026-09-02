import { useCallback, useEffect, useState } from "react";
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
import { formatMetricLabel } from "../metricHelpers";
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

  return (
    <div>
      <PageHeader title={mv ? `${mv.name} · v${mv.version}` : "Model version"} description="Governance evidence, metrics, lineage, and deployment readiness." actions={<StatusBadge status={mv?.lifecycle} />} />
      <ErrorNotice message={error} /><SuccessNotice message={success} />
      {!mv ? <Loading label="Loading model version" /> : (
        <>
          <div className="row-actions toolbar-actions">
            {canWrite && RERUN_LIFECYCLES.includes(mv.lifecycle) && (
              <button
                className="btn secondary"
                disabled={busy === "evaluate-gates"}
                onClick={() => void rerunValidation()}
                data-testid="rerun-validation"
              >
                {busy === "evaluate-gates" ? "Validating…" : "Rerun validation"}
              </button>
            )}
            {canWrite && canRequestApproval && (
              <button className="btn" disabled={Boolean(busy)} onClick={() => action("request-approval")} data-testid="request-approval">
                Request approval
              </button>
            )}
            {canApprove && mv.lifecycle === "PENDING_APPROVAL" && <><button className="btn" disabled={Boolean(busy)} onClick={() => action("approve")} data-testid="approve-model">✓ Approve</button><button className="btn danger" disabled={Boolean(busy)} onClick={() => action("reject")}>Reject</button></>}
            {canApprove && mv.lifecycle === "APPROVED" && <button className="btn" disabled={Boolean(busy)} onClick={() => action("promote-production")}>Promote to production</button>}
            {["APPROVED", "PRODUCTION"].includes(mv.lifecycle) && <Link className="btn secondary" to={`/projects/${projectId}/deployments`} state={{ modelVersionId: mv.id }}>Create deployment</Link>}
          </div>
          {showApprovalBlocked && (
            <p className="form-hint" data-testid="approval-blocked-hint">
              Approval cannot be requested until all validation gates pass.
            </p>
          )}
          {(mv.lifecycle === "PENDING_APPROVAL" || RERUN_LIFECYCLES.includes(mv.lifecycle)) && <label className="panel comment-field">Review comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add context for the reviewer" /></label>}
          <div className="grid stats-grid">
            {Object.entries(mv.metrics).slice(0, 4).map(([name, value]) => (
              <div className="stat" key={name}>
                <div className="label">
                  {formatMetricLabel(
                    name,
                    Array.isArray(mv.metadata?.target_columns)
                      ? mv.metadata.target_columns.map(String)
                      : [],
                  )}
                </div>
                <div className="value metric-value">{Number(value).toFixed(3)}</div>
              </div>
            ))}
          </div>
          <div className="two-column">
            <section className="panel"><span className="eyebrow">Governance</span><h2>Approval evidence</h2><dl className="key-values"><div><dt>Lifecycle</dt><dd><StatusBadge status={mv.lifecycle} /></dd></div><div><dt>Gates</dt><dd><StatusBadge status={mv.gates_passed ? "passed" : "pending"} /></dd></div><div><dt>Comment</dt><dd>{mv.approval_comment || "—"}</dd></div><div><dt>Registered</dt><dd>{formatDate(mv.created_at)}</dd></div></dl></section>
            <section className="panel"><span className="eyebrow">Lineage</span><h2>Source</h2><dl className="key-values"><div><dt>Training job</dt><dd>{mv.training_job_id ? <Link to={`/projects/${projectId}/jobs/${mv.training_job_id}`}>Job #{mv.training_job_id}</Link> : "—"}</dd></div><div><dt>Experiment run</dt><dd className="mono">{mv.mlflow_run_id || "—"}</dd></div><div><dt>Model URI</dt><dd className="mono break-word">{mv.model_uri}</dd></div></dl></section>
          </div>
          <section className="panel"><span className="eyebrow">Gate results</span><h2>Validation details</h2><pre className="json-view" data-testid="gate-results">{JSON.stringify(mv.gate_results, null, 2)}</pre></section>
        </>
      )}
    </div>
  );
}
