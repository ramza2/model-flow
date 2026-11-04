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
    setSelected({});
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
      .catch((reason) => setError(reason instanceof Error ? reason.message : "피드백을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, statusFilter, endpointFilter, materializableFilter, feedbackSkip, historySkip]);

  // Only the visible, editable rows can be submitted. Never carry hidden selections
  // across pages or filters into a bulk review request.
  const selectedIds = useMemo(
    () =>
      items
        .filter(
          (item) =>
            selected[item.id] &&
            !item.materialized_dataset_version_id &&
            !item.materialization_run_id,
        )
        .map((item) => item.id),
    [items, selected],
  );

  const pagePendingIds = useMemo(
    () =>
      items
        .filter(
          (item) =>
            item.review_status === "PENDING" &&
            !item.materialized_dataset_version_id &&
            !item.materialization_run_id,
        )
        .map((item) => item.id),
    [items],
  );
  const allPendingSelected =
    pagePendingIds.length > 0 && pagePendingIds.every((id) => selected[id]);
  const somePendingSelected = pagePendingIds.some((id) => selected[id]);

  const materializableSelected = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id) && item.materializable),
    [items, selectedIds],
  );

  const review = async (decision: "approved" | "rejected") => {
    if (!projectId || selectedIds.length === 0) return;
    if (
      selectedIds.length > 1 &&
      !window.confirm(
        `선택한 ${selectedIds.length}건을 ${decision === "approved" ? "승인" : "반려"}하시겠습니까?\n검토 결과는 저장되며 감사 기록에 남습니다.`,
      )
    ) {
      return;
    }
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
      setError(reason instanceof Error ? reason.message : "검토 결과를 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const materialize = async () => {
    if (!projectId || materializableSelected.length === 0) return;
    const endpointId = materializableSelected[0].endpoint_id;
    if (!endpointId || materializableSelected.some((item) => item.endpoint_id !== endpointId)) {
      setError("하나의 배포 엔드포인트에서 학습 데이터로 만들 수 있는 승인된 피드백만 선택하세요.");
      return;
    }
    const confirmed = window.confirm(
      [
        `승인된 피드백 ${materializableSelected.length}건으로 새 데이터셋 버전(DatasetVersion)을 생성하시겠습니까?`,
        `배포 엔드포인트 #${endpointId}`,
        `운영 모델 #${materializableSelected[0].model_version_id}`,
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
      setError(reason instanceof Error ? reason.message : "학습 데이터 생성 작업을 시작하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack" data-testid="feedback-review-page">
      <PageHeader
        title="피드백 검토"
        description="예측 결과의 정답(실제값)을 검토해 승인하세요. 승인된 데이터만 새 학습 데이터셋 버전(DatasetVersion)에 반영할 수 있으며, 자동 재학습으로 모델이 곧바로 운영 적용되지는 않습니다."
      />

      <div className="feedback-review-toolbar filter-bar catalog-filter" data-testid="feedback-filters">
        <div className="feedback-filter-controls">
          <label>
            검토 상태
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
              <option value="">전체</option>
              <option value="PENDING">미검토 (PENDING)</option>
              <option value="APPROVED">승인 (APPROVED)</option>
              <option value="REJECTED">반려 (REJECTED)</option>
            </select>
          </label>
          <label>
            배포 엔드포인트 ID
            <input
              value={endpointFilter}
              onChange={(event) => {
                const value = event.target.value;
                setEndpointFilter(value);
                setFeedbackSkip(0);
                syncUrl({ endpoint_id: value, skip: 0 });
              }}
              placeholder="선택 사항"
              data-testid="feedback-endpoint-filter"
            />
          </label>
          <label>
            학습 데이터 생성 가능 여부
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
              <option value="">전체</option>
              <option value="true">가능</option>
              <option value="false">불가능</option>
            </select>
          </label>
        </div>
        {canWrite ? (
          <div className="feedback-selection-actions" data-testid="feedback-selection-actions">
            <span className="feedback-selection-meta muted">
              {selectedIds.length === 0
                ? "검토할 항목을 선택하세요 (전체 선택은 현재 페이지의 미검토 항목만)"
                : `${selectedIds.length}건 선택됨`}
            </span>
            <button
              className="btn"
              disabled={busy || selectedIds.length === 0}
              onClick={() => review("approved")}
              data-testid="feedback-approve"
            >
              승인
            </button>
            <button
              className="btn secondary"
              disabled={busy || selectedIds.length === 0}
              onClick={() => review("rejected")}
              data-testid="feedback-reject"
            >
              반려
            </button>
            <button
              className="btn secondary"
              disabled={busy || materializableSelected.length === 0}
              onClick={materialize}
              data-testid="feedback-materialize"
            >
              학습 데이터셋 버전 생성
            </button>
          </div>
        ) : null}
      </div>

      {error ? <p className="error-text" data-testid="feedback-error">{error}</p> : null}
      {loading ? <Loading label="피드백 불러오는 중" /> : null}

      {!loading && items.length === 0 ? (
        <EmptyState
          title="등록된 피드백이 없습니다"
          description="운영 예측 결과에 정답(실제값)을 등록하면 이 화면에서 검토할 수 있습니다."
        />
      ) : null}

      {!loading && items.length > 0 ? (
        <section className="feedback-queue-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">검토 대기</span>
              <h2>피드백 목록</h2>
            </div>
          </div>
          <div className="panel table-wrap catalog-table" data-testid="feedback-queue">
            <table>
              <thead>
                <tr>
                  {canWrite ? (
                    <th className="catalog-select-col">
                      <label className="catalog-select" title="현재 페이지에서 아직 검토하지 않았고 수정 가능한 항목만 전체 선택합니다.">
                        <input
                          type="checkbox"
                          checked={allPendingSelected}
                          ref={(node) => {
                            if (node) node.indeterminate = somePendingSelected && !allPendingSelected;
                          }}
                          disabled={busy || pagePendingIds.length === 0}
                          aria-label="현재 페이지 미검토 피드백 전체 선택"
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelected((prev) => {
                              const next = { ...prev };
                              for (const id of pagePendingIds) {
                                if (checked) next[id] = true;
                                else delete next[id];
                              }
                              return next;
                            });
                          }}
                          data-testid="feedback-select-page"
                        />
                      </label>
                    </th>
                  ) : null}
                  <th>예측 시각</th>
                  <th>엔드포인트 / 모델</th>
                  <th>예측값</th>
                  <th>정답(실제값)</th>
                  <th>검토 상태</th>
                  <th>입력 데이터 보관</th>
                  <th>학습 데이터 생성</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const locked = Boolean(item.materialized_dataset_version_id || item.materialization_run_id);
                  const endpointLabel =
                    item.endpoint_name || (item.endpoint_id != null ? `#${item.endpoint_id}` : "—");
                  const modelLabel = item.model_name
                    ? `${item.model_name}${item.model_version ? ` v${item.model_version}` : ""}`
                    : item.model_version_id != null
                      ? `#${item.model_version_id}`
                      : "—";
                  return (
                    <tr
                      key={item.id}
                      className={locked ? "feedback-row is-locked" : "feedback-row"}
                      data-testid={`feedback-row-${item.id}`}
                    >
                      {canWrite ? (
                        <td className="catalog-select-col">
                          <label className="catalog-select">
                            <input
                              type="checkbox"
                              checked={Boolean(selected[item.id])}
                              disabled={locked || busy}
                              onChange={(event) =>
                                setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                              }
                              data-testid={`feedback-select-${item.id}`}
                            />
                          </label>
                        </td>
                      ) : null}
                      <td className="catalog-meta-date">
                        {item.predicted_at ? new Date(item.predicted_at).toLocaleString() : "—"}
                      </td>
                      <td>
                        <strong className="feedback-endpoint-label">{endpointLabel}</strong>
                        <small className="table-subtitle mono">{modelLabel}</small>
                      </td>
                      <td className="mono feedback-value-cell">{stringifyValue(item.predicted_value)}</td>
                      <td className="mono feedback-value-cell">{stringifyValue(item.actual_value)}</td>
                      <td><StatusBadge status={item.review_status} /></td>
                      <td data-testid={`feedback-snapshot-${item.id}`}>
                        {item.input_snapshot_available ? (
                          <span className="feedback-snapshot-ok">보관됨</span>
                        ) : (
                          <span className="feedback-snapshot-blocked">
                            생성 불가 — 예측 당시 입력 데이터가 없습니다
                          </span>
                        )}
                      </td>
                      <td className="mono">
                        {item.materialized_dataset_version_id
                          ? `데이터셋 버전 #${item.materialized_dataset_version_id}`
                          : item.materialization_run_id
                            ? `예약된 실행 #${item.materialization_run_id}`
                            : item.materializable
                              ? "준비됨"
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
                className="btn secondary"
                disabled={feedbackSkip <= 0 || loading}
                onClick={() => {
                  const next = Math.max(0, feedbackSkip - PAGE_SIZE);
                  setFeedbackSkip(next);
                  syncUrl({ skip: next });
                }}
                data-testid="feedback-prev"
              >
                이전
              </button>
              <span className="muted">
                {itemTotal === 0
                  ? "0건"
                  : `${itemTotal}건 중 ${feedbackSkip + 1}–${Math.min(feedbackSkip + PAGE_SIZE, itemTotal)}건`}
              </span>
              <button
                type="button"
                className="btn secondary"
                disabled={feedbackSkip + PAGE_SIZE >= itemTotal || loading}
                onClick={() => {
                  const next = feedbackSkip + PAGE_SIZE;
                  setFeedbackSkip(next);
                  syncUrl({ skip: next });
                }}
                data-testid="feedback-next"
              >
                다음
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel feedback-history-section" data-testid="feedback-materialization-history">
        <div className="section-heading">
          <div>
            <span className="eyebrow">이력</span>
            <h2>피드백 학습 데이터 생성 이력</h2>
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="muted">아직 학습 데이터 생성 이력이 없습니다.</p>
        ) : (
          <div className="table-wrap catalog-table">
            <table>
              <thead>
                <tr>
                  <th>실행</th>
                  <th>상태</th>
                  <th>엔드포인트</th>
                  <th>원본 모델</th>
                  <th>기준 버전</th>
                  <th>생성 버전</th>
                  <th>피드백 건수</th>
                  <th>추가된 행</th>
                  <th>완료 시각</th>
                  <th>오류</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} data-testid={`materialization-run-${run.id}`}>
                    <td className="mono">#{run.id}</td>
                    <td><StatusBadge status={run.status} /></td>
                    <td className="mono">#{run.endpoint_id}</td>
                    <td className="mono">#{run.source_model_version_id}</td>
                    <td className="mono">
                      #{run.base_dataset_version_id}
                      {run.base_dataset_version != null ? ` (v${run.base_dataset_version})` : ""}
                    </td>
                    <td>
                      {run.output_dataset_version_id ? (
                        <Link
                          className="catalog-primary-link mono"
                          to={
                            run.output_dataset_version != null
                              ? `/projects/${projectId}/datasets/${run.dataset_id}?version=${run.output_dataset_version}`
                              : `/projects/${projectId}/datasets/${run.dataset_id}`
                          }
                          data-testid={`materialization-output-${run.id}`}
                        >
                          {run.output_dataset_version != null
                            ? `v${run.output_dataset_version}`
                            : `데이터셋 버전 #${run.output_dataset_version_id}`}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="tabular-num">{run.feedback_count}</td>
                    <td className="tabular-num" data-testid={`materialization-rows-added-${run.id}`}>
                      {run.status === "succeeded" ? (run.row_count_added ?? 0) : "—"}
                    </td>
                    <td className="catalog-meta-date">
                      {run.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}
                    </td>
                    <td
                      className={run.status === "failed" ? "danger-text" : undefined}
                      data-testid={`materialization-error-${run.id}`}
                    >
                      {run.status === "failed"
                        ? (run.error_message || "학습 데이터 생성 실패")
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
            className="btn secondary"
            disabled={historySkip <= 0 || loading}
            onClick={() => setHistorySkip((prev) => Math.max(0, prev - HISTORY_PAGE_SIZE))}
            data-testid="materialization-history-prev"
          >
            Previous
          </button>
          <span className="muted">
            {runTotal === 0
              ? "0건"
              : `${runTotal}건 중 ${historySkip + 1}–${Math.min(historySkip + HISTORY_PAGE_SIZE, runTotal)}건`}
          </span>
          <button
            type="button"
            className="btn secondary"
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
