import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Run } from "../api";
import { ErrorNotice, HelpTip, Loading, PageHeader, StatusBadge } from "../components";
import { TargetChips } from "../lifecycleComponents";
import {
  parseTargetsFromParams,
  runDisplayName,
  targetColumnsAreIdentical,
} from "../lifecycleHelpers";
import { formatMetricLabel, metricHelpText } from "../metricHelpers";
import { problemTypeLabel, runStatusLabel } from "../uiTerminology";

type Compare = { runs: Run[]; metric_keys: string[]; param_keys: string[] };

function identityRows(runs: Run[]) {
  return [
    {
      label: "실행 이름",
      values: runs.map((run) => runDisplayName(run)),
    },
    {
      label: "상태",
      values: runs.map((run) => run.status),
      badge: true,
    },
    {
      label: "학습 알고리즘",
      values: runs.map((run) => run.params.algorithm || "—"),
    },
    {
      label: "예측 문제 유형",
      values: runs.map((run) =>
        run.params.problem_type ? problemTypeLabel(run.params.problem_type) : "—",
      ),
    },
    {
      label: "예측 대상",
      values: runs.map((run) => parseTargetsFromParams(run.params).join(", ") || "—"),
      chips: true,
    },
  ];
}

export default function RunCompare() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState("");
  const runIds = params.get("run_ids") || "";

  useEffect(() => {
    if (!runIds) {
      setError("비교할 학습 실행을 선택해주세요.");
      return;
    }
    api<Compare>(`/projects/${projectId}/experiments/runs/compare?run_ids=${encodeURIComponent(runIds)}`)
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "학습 실행 비교 결과를 불러오지 못했습니다."),
      );
  }, [projectId, runIds]);

  const targetColumns = useMemo(() => {
    if (!data?.runs.length) return [];
    const perRun = data.runs.map((run) => parseTargetsFromParams(run.params));
    if (!targetColumnsAreIdentical(perRun)) return [];
    return perRun[0] ?? [];
  }, [data]);

  const primaryKeys = useMemo(() => {
    if (!data) return [];
    const preferred = ["val_rmse", "rmse", "val_accuracy", "accuracy", "val_r2", "r2"];
    return [
      ...preferred.filter((key) => data.metric_keys.includes(key)),
      ...data.metric_keys.filter((key) => !preferred.includes(key)),
    ];
  }, [data]);

  return (
    <div>
      <PageHeader
        title="학습 실행 비교"
        description="선택한 학습 실행의 평가 지표와 설정을 나란히 비교합니다. 지표별 도움말을 확인해 결과를 해석하세요."
        actions={
          <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>
            ← 실험 비교로 돌아가기
          </Link>
        }
      />
      <ErrorNotice message={error} />
      {!data && !error ? (
        <Loading label="실험 비교 결과 불러오는 중" />
      ) : data ? (
        <div className="compare-board">
          <div className="compare-header" data-testid="compare-header">
            <div className="compare-header-spacer" aria-hidden="true" />
            {data.runs.map((run) => (
              <div key={run.run_id} className="compare-run-card">
                <strong>{runDisplayName(run)}</strong>
                <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
                <small className="mono">{run.run_id}</small>
              </div>
            ))}
          </div>

          <section className="panel compare-section compare-section-primary">
            <div className="panel-title">
              <div>
                <span className="eyebrow">성능</span>
                <h2>평가 지표 비교 (Metrics)</h2>
              </div>
            </div>
            <div className="table-wrap catalog-table compare-table">
              <table data-testid="compare-metrics-table">
                <thead>
                  <tr>
                    <th>평가 지표</th>
                    {data.runs.map((run) => (
                      <th key={run.run_id}>{runDisplayName(run)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {primaryKeys.map((key, index) => (
                    <tr
                      key={key}
                      className={index === 0 ? "compare-primary-metric-row" : undefined}
                      data-testid={`compare-metric-row-${key}`}
                    >
                      <td>
                        <span className="stat-label-row">
                          <span>{formatMetricLabel(key, targetColumns)}</span>
                          <HelpTip text={metricHelpText(key)} />
                        </span>
                        <div className="mono text-xs">{key}</div>
                      </td>
                      {data.runs.map((run) => (
                        <td key={run.run_id} className="tabular-num mono">
                          {run.metrics[key] === undefined ? "—" : Number(run.metrics[key]).toFixed(4)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel compare-section">
            <div className="panel-title">
              <div>
                <span className="eyebrow">실행 정보</span>
                <h2>학습 실행 정보</h2>
              </div>
            </div>
            <div className="table-wrap catalog-table compare-table">
              <table data-testid="compare-identity-table">
                <thead>
                  <tr>
                    <th>비교 항목</th>
                    {data.runs.map((run) => (
                      <th key={run.run_id}>{runDisplayName(run)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {identityRows(data.runs).map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      {row.values.map((value, index) => (
                        <td key={`${row.label}-${data.runs[index].run_id}`}>
                          {row.badge ? (
                            <StatusBadge status={value} label={runStatusLabel(value)} />
                          ) : row.chips && value !== "—" ? (
                            <TargetChips targets={value.split(", ").filter(Boolean)} />
                          ) : (
                            value
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <details className="panel advanced-json compare-section" data-testid="compare-params-details">
            <summary>
              <span className="eyebrow">설정</span>
              <strong> 실행 설정 비교 (고급)</strong>
            </summary>
            <p className="catalog-empty-meta">
              각 학습 실행에 기록된 설정값입니다. 비교를 위한 원본 정보이며 이 화면에서 수정할 수 없습니다.
            </p>
            <div className="table-wrap catalog-table compare-table engineering-surface">
              <table data-testid="compare-params-table">
                <thead>
                  <tr>
                    <th>설정 키</th>
                    {data.runs.map((run) => (
                      <th key={run.run_id} className="mono">
                        {run.run_id.slice(0, 8)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.param_keys.map((key) => (
                    <tr key={key}>
                      <td className="mono">{key}</td>
                      {data.runs.map((run) => (
                        <td key={run.run_id} className="mono">
                          {run.params[key] ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
