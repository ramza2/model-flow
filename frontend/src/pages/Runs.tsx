import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Run } from "../api";
import { EmptyState, ErrorNotice, Loading, PageHeader, StatusBadge, formatDate } from "../components";
import { parseTargetsFromParams, runDisplayName } from "../lifecycleHelpers";
import { formatMetricLabel, formatPrimaryMetric } from "../metricHelpers";
import { TargetChips } from "../lifecycleComponents";
import { runStatusLabel } from "../uiTerminology";

function targetColumnsFromRun(run: Run): string[] {
  return parseTargetsFromParams(run.params);
}

export default function Runs() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    api<Run[]>(`/projects/${projectId}/experiments/runs${query}`)
      .then((rows) => {
        setRuns(rows);
        const requested = params.get("run");
        if (requested && rows.some((run) => run.run_id === requested)) setSelected([requested]);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "실험 실행 목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
  }, [params, projectId, search]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const filtered = useMemo(() => runs, [runs]);
  const canCompare = selected.length >= 2;

  return (
    <div>
      <PageHeader
        title="실험 비교"
        description="학습 실행 결과를 확인하고, 2개 이상 선택해 성능 지표와 설정을 비교할 수 있습니다."
        actions={
          <Link
            className={`btn compare-cta${canCompare ? "" : " is-disabled"}`}
            to={`/projects/${projectId}/experiments/compare?run_ids=${selected.join(",")}`}
            aria-disabled={!canCompare}
            onClick={(event) => !canCompare && event.preventDefault()}
            data-testid="compare-selected"
          >
            선택한 실행 비교 ({selected.length}개)
          </Link>
        }
      />
      <ErrorNotice message={error} />
      <div className="workflow-catalog">
        <div className="filter-bar catalog-filter">
          <label>
            실험 실행 검색
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="실행 이름 또는 ID"
            />
          </label>
          <div className="catalog-summary" aria-live="polite">
            <span className="catalog-summary-count">{selected.length}</span>
            <span className="catalog-summary-label">
              개 선택됨 · 2개 이상 선택하면 비교할 수 있습니다.
            </span>
          </div>
        </div>
        {loading ? (
          <Loading label="실험 실행 목록 불러오는 중" />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="실험 실행 기록이 없습니다"
            description="모델 학습을 시작하면 실행 결과가 이곳에 자동으로 기록됩니다."
            action={<Link className="btn" to={`/projects/${projectId}/jobs/new`}>새 모델 학습</Link>}
          />
        ) : (
          <div className="panel table-wrap catalog-table">
            <table data-testid="runs-table">
              <thead>
                <tr>
                  <th className="catalog-select-col" aria-label="Select" />
                  <th>실행 이름</th>
                  <th>상태</th>
                  <th>학습 알고리즘</th>
                  <th>예측 대상</th>
                  <th>주요 평가 지표</th>
                  <th>시작 시각</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((run) => {
                  const targets = targetColumnsFromRun(run);
                  const problemType = run.params.problem_type || run.params.task;
                  const isSelected = selected.includes(run.run_id);
                  return (
                    <tr
                      key={run.run_id}
                      className={isSelected ? "selected-row" : undefined}
                      data-testid={`run-row-${run.run_id}`}
                    >
                      <td className="catalog-select-col">
                        <label className="catalog-select">
                          <input
                            aria-label={`실행 선택: ${runDisplayName(run)}`}
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggle(run.run_id)}
                          />
                        </label>
                      </td>
                      <td>
                        <Link
                          className="catalog-primary-link"
                          to={`/projects/${projectId}/experiments/runs/${run.run_id}`}
                        >
                          <strong>{runDisplayName(run)}</strong>
                        </Link>
                        <small className="table-subtitle mono">{run.run_id}</small>
                      </td>
                      <td>
                        <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
                      </td>
                      <td className="catalog-secondary-text">
                        {(run.params.algorithm || "—").replaceAll("_", " ")}
                      </td>
                      <td><TargetChips targets={targets} /></td>
                      <td
                        className="tabular-num"
                        title={Object.keys(run.metrics).map((key) => formatMetricLabel(key, targets)).join(", ")}
                      >
                        {formatPrimaryMetric(run.metrics, { problemType, targetColumns: targets })}
                      </td>
                      <td className="catalog-meta-date">{formatDate(run.start_time)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
