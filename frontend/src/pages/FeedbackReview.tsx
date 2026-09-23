import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useProject, userCanProject } from "../ProjectContext";
import { EmptyState, Loading, PageHeader, StatusBadge } from "../components";

type FeedbackItem = {
  id: number;
  prediction_id: string;
  endpoint_id: number | null;
  endpoint_name?: string | null;
  model_version_id?: number | null;
  model_name?: string | null;
  model_version?: string | null;
  predicted_value?: unknown;
  actual_value?: unknown;
  predicted_at?: string | null;
  review_status: string;
  input_snapshot_available: boolean;
  materializable: boolean;
  materialized_dataset_version_id?: number | null;
  materialization_run_id?: number | null;
};

type MaterializationRun = {
  id: number;
  status: string;
  endpoint_id: number;
  source_model_version_id: number;
  base_dataset_version_id: number;
  base_dataset_version?: number | null;
  output_dataset_version_id?: number | null;
  output_dataset_version?: number | null;
  dataset_id: number;
  feedback_count: number;
  row_count_added?: number | null;
  created_at?: string | null;
  finished_at?: string | null;
  error_message?: string | null;
};

const PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 10;

function stringifyValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function FeedbackReview() {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const canWrite = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [runs, setRuns] = useState<MaterializationRun[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState(searchParams.get("review_status") || "");
  const [endpointFilter, setEndpointFilter] = useState(searchParams.get("endpoint_id") || "");
  const [materializableFilter, setMaterializableFilter] = useState(
    searchParams.get("materializable") || "",
  );
  const [feedbackSkip, setFeedbackSkip] = useState(Number(searchParams.get("skip") || 0) || 0);
  const [historySkip, setHistorySkip] = useState(0);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  const syncUrl = (
    next: {
      review_status?: string;
      endpoint_id?: string;
      materializable?: string;
      skip?: number;
    },
  ) => {
    const params = new URLSearchParams();
    const status = next.review_status ?? statusFilter;
    const endpoint = next.endpoint_id ?? endpointFilter;
    const materializable = next.materializable ?? materializableFilter;
    const skip = next.skip ?? feedbackSkip;
    if (status) params.set("review_status", status);
    if (endpoint) params.set("endpoint_id", endpoint);
    if (materializable) params.set("materializable", materializable);
    if (skip > 0) params.set("skip", String(skip));
    setSearchParams(params, { replace: true });
  };

  const load = () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      paged: "true",
      skip: String(feedbackSkip),
      limit: String(PAGE_SIZE),
    });
    if (statusFilter) params.set("review_status", statusFilter);
    if (endpointFilter) params.set("endpoint_id", endpointFilter);
    if (materializableFilter === "true" || materializableFilter === "false") {
      params.set("materializable", materializableFilter);
    }
    const historyParams = new URLSearchParams({
      paged: "true",
      skip: String(historySkip),
      limit: String(HISTORY_PAGE_SIZE),
    });
    Promise.all([
      api<{ items: FeedbackItem[]; total: number }>(
        `/projects/${projectId}/feedback?${params.toString()}`,
      ),
      api<{ items: MaterializationRun[]; total: number }>(
        `/projects/${projectId}/feedback-materializations?${historyParams.toString()}`,
      ),
    ])
      .then(([feedback, history]) => {
        setItems(Array.isArray(feedback.items) ? feedback.items : []);
        setItemTotal(Number(feedback.total || 0));
        setRuns(Array.isArray(history.items) ? history.items : []);
        setRunTotal(Number(history.total || 0));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Feedback could not be loaded."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, statusFilter, endpointFilter, materializableFilter, feedbackSkip, historySkip]);

  const selectedIds = useMemo(
    () => Object.entries(selected).filter(([, on]) => on).map(([id]) => Number(id)),
    [selected],
  );

  const materializableSelected = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id) && item.materializable),
    [items, selectedIds],
  );

  const review = async (decision: "approved" | "rejected") => {
    if (!projectId || selectedIds.length === 0) return;
    setBusy(true);
    try {
      await api(`/projects/${projectId}/feedback/review`, {
        method: "POST",
        body: JSON.stringify({
          items: selectedIds.map((feedback_id) => ({ feedback_id, decision })),
        }),
      });
      setSelected({});
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  };

  const materialize = async () => {
    if (!projectId || materializableSelected.length === 0) return;
    const endpointId = materializableSelected[0].endpoint_id;
    if (!endpointId || materializableSelected.some((item) => item.endpoint_id !== endpointId)) {
      setError("Select approved materializable feedback from a single endpoint.");
      return;
    }
    const confirmed = window.confirm(
      [
        `Create a new immutable DatasetVersion from ${materializableSelected.length} approved feedback row(s)?`,
        `Endpoint #${endpointId}`,
        `Production model #${materializableSelected[0].model_version_id}`,
      ].join("\n"),
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await api(`/projects/${projectId}/feedback-materializations`, {
        method: "POST",
        body: JSON.stringify({
          endpoint_id: endpointId,
          feedback_ids: materializableSelected.map((item) => item.id),
        }),
      });
      setSelected({});
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Materialization could not be started.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack" data-testid="feedback-review-page">
      <PageHeader
        title="Feedback Review"
        description="Approve ground truth before it can become an immutable training DatasetVersion. Closed-loop automation still stops at CANDIDATE."
      />

      <div className="row-actions" data-testid="feedback-filters">
        <label>
          Review status
          <select
            value={statusFilter}
            onChange={(event) => {
              const value = event.target.value;
              setStatusFilter(value);
              setFeedbackSkip(0);
              syncUrl({ review_status: value, skip: 0 });
            }}
            data-testid="feedback-status-filter"
          >
            <option value="">All</option>
            <option value="PENDING">PENDING</option>
            <option value="APPROVED">APPROVED</option>
            <option value="REJECTED">REJECTED</option>
          </select>
        </label>
        <label>
          Endpoint ID
          <input
            value={endpointFilter}
            onChange={(event) => {
              const value = event.target.value;
              setEndpointFilter(value);
              setFeedbackSkip(0);
              syncUrl({ endpoint_id: value, skip: 0 });
            }}
            placeholder="optional"
            data-testid="feedback-endpoint-filter"
          />
        </label>
        <label>
          Materializable
          <select
            value={materializableFilter}
            onChange={(event) => {
              const value = event.target.value;
              setMaterializableFilter(value);
              setFeedbackSkip(0);
              syncUrl({ materializable: value, skip: 0 });
            }}
            data-testid="feedback-materializable-filter"
          >
            <option value="">All</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
        {canWrite ? (
          <>
            <button className="btn" disabled={busy || selectedIds.length === 0} onClick={() => review("approved")} data-testid="feedback-approve">
              Approve
            </button>
            <button className="btn btn-secondary" disabled={busy || selectedIds.length === 0} onClick={() => review("rejected")} data-testid="feedback-reject">
              Reject
            </button>
            <button
              className="btn"
              disabled={busy || materializableSelected.length === 0}
              onClick={materialize}
              data-testid="feedback-materialize"
            >
              Create training DatasetVersion
            </button>
          </>
        ) : null}
      </div>

      {error ? <p className="error-text" data-testid="feedback-error">{error}</p> : null}
      {loading ? <Loading label="Loading feedback" /> : null}

      {!loading && items.length === 0 ? (
        <EmptyState
          title="No feedback yet"
          description="Submit ground truth against production predictions, then review it here before materialization."
        />
      ) : null}

      {!loading && items.length > 0 ? (
        <div className="table-wrap" data-testid="feedback-queue">
          <table>
            <thead>
              <tr>
                {canWrite ? <th>Select</th> : null}
                <th>Predicted at</th>
                <th>Endpoint</th>
                <th>Model</th>
                <th>Prediction</th>
                <th>Ground truth</th>
                <th>Review</th>
                <th>Input snapshot</th>
                <th>Materialization</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const locked = Boolean(item.materialized_dataset_version_id || item.materialization_run_id);
                return (
                  <tr key={item.id} data-testid={`feedback-row-${item.id}`}>
                    {canWrite ? (
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(selected[item.id])}
                          disabled={locked}
                          onChange={(event) =>
                            setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                          }
                          data-testid={`feedback-select-${item.id}`}
                        />
                      </td>
                    ) : null}
                    <td>{item.predicted_at ? new Date(item.predicted_at).toLocaleString() : "—"}</td>
                    <td>{item.endpoint_name || (item.endpoint_id != null ? `#${item.endpoint_id}` : "—")}</td>
                    <td>
                      {item.model_name
                        ? `${item.model_name}${item.model_version ? ` v${item.model_version}` : ""}`
                        : item.model_version_id != null
                          ? `#${item.model_version_id}`
                          : "—"}
                    </td>
                    <td>{stringifyValue(item.predicted_value)}</td>
                    <td>{stringifyValue(item.actual_value)}</td>
                    <td><StatusBadge status={item.review_status} /></td>
                    <td data-testid={`feedback-snapshot-${item.id}`}>
                      {item.input_snapshot_available ? "Available" : "Not materializable — input snapshot unavailable"}
                    </td>
                    <td>
                      {item.materialized_dataset_version_id
                        ? `DatasetVersion #${item.materialized_dataset_version_id}`
                        : item.materialization_run_id
                          ? `Reserved run #${item.materialization_run_id}`
                          : item.materializable
                            ? "Ready"
                            : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row-actions" data-testid="feedback-pagination">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={feedbackSkip <= 0 || loading}
              onClick={() => {
                const next = Math.max(0, feedbackSkip - PAGE_SIZE);
                setFeedbackSkip(next);
                syncUrl({ skip: next });
              }}
              data-testid="feedback-prev"
            >
              Previous
            </button>
            <span className="muted">
              {itemTotal === 0
                ? "0 rows"
                : `${feedbackSkip + 1}–${Math.min(feedbackSkip + PAGE_SIZE, itemTotal)} of ${itemTotal}`}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={feedbackSkip + PAGE_SIZE >= itemTotal || loading}
              onClick={() => {
                const next = feedbackSkip + PAGE_SIZE;
                setFeedbackSkip(next);
                syncUrl({ skip: next });
              }}
              data-testid="feedback-next"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      <section className="panel" data-testid="feedback-materialization-history">
        <h2>Feedback Materialization History</h2>
        {runs.length === 0 ? (
          <p className="muted">No materialization runs yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Endpoint</th>
                  <th>Source model</th>
                  <th>Base version</th>
                  <th>Output version</th>
                  <th>Feedback rows</th>
                  <th>Rows added</th>
                  <th>Finished</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} data-testid={`materialization-run-${run.id}`}>
                    <td>#{run.id}</td>
                    <td><StatusBadge status={run.status} /></td>
                    <td>#{run.endpoint_id}</td>
                    <td>#{run.source_model_version_id}</td>
                    <td>#{run.base_dataset_version_id}{run.base_dataset_version != null ? ` (v${run.base_dataset_version})` : ""}</td>
                    <td>
                      {run.output_dataset_version_id ? (
                        <Link
                          to={
                            run.output_dataset_version != null
                              ? `/projects/${projectId}/datasets/${run.dataset_id}?version=${run.output_dataset_version}`
                              : `/projects/${projectId}/datasets/${run.dataset_id}`
                          }
                          data-testid={`materialization-output-${run.id}`}
                        >
                          {run.output_dataset_version != null
                            ? `v${run.output_dataset_version}`
                            : `DatasetVersion #${run.output_dataset_version_id}`}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{run.feedback_count}</td>
                    <td data-testid={`materialization-rows-added-${run.id}`}>
                      {run.status === "succeeded" ? (run.row_count_added ?? 0) : "—"}
                    </td>
                    <td>{run.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}</td>
                    <td data-testid={`materialization-error-${run.id}`}>
                      {run.status === "failed"
                        ? (run.error_message || "Materialization failed")
                        : (run.error_message || "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row-actions" data-testid="materialization-history-pagination">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={historySkip <= 0 || loading}
            onClick={() => setHistorySkip((prev) => Math.max(0, prev - HISTORY_PAGE_SIZE))}
            data-testid="materialization-history-prev"
          >
            Previous
          </button>
          <span className="muted">
            {runTotal === 0
              ? "0 runs"
              : `${historySkip + 1}–${Math.min(historySkip + HISTORY_PAGE_SIZE, runTotal)} of ${runTotal}`}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={historySkip + HISTORY_PAGE_SIZE >= runTotal || loading}
            onClick={() => setHistorySkip((prev) => prev + HISTORY_PAGE_SIZE)}
            data-testid="materialization-history-next"
          >
            Next
          </button>
        </div>
      </section>
    </div>
  );
}
