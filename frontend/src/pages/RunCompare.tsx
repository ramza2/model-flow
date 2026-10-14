import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type Run } from "../api";
import { ErrorNotice, Loading, PageHeader, StatusBadge } from "../components";
import { TargetChips } from "../lifecycleComponents";
import {
  parseTargetsFromParams,
  runDisplayName,
  targetColumnsAreIdentical,
} from "../lifecycleHelpers";
import { formatMetricLabel } from "../metricHelpers";

type Compare = { runs: Run[]; metric_keys: string[]; param_keys: string[] };

function identityRows(runs: Run[]) {
  return [
    {
      label: "Run",
      values: runs.map((run) => runDisplayName(run)),
    },
    {
      label: "Status",
      values: runs.map((run) => run.status),
      badge: true,
    },
    {
      label: "Algorithm",
      values: runs.map((run) => run.params.algorithm || "—"),
    },
    {
      label: "Problem type",
      values: runs.map((run) => run.params.problem_type || "—"),
    },
    {
      label: "Targets",
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
      setError("Select at least two runs to compare.");
      return;
    }
    api<Compare>(`/projects/${projectId}/experiments/runs/compare?run_ids=${encodeURIComponent(runIds)}`)
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Runs could not be compared."));
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
        title="Compare runs"
        description="Primary metrics first, then run context and technical parameters."
        actions={
          <Link className="btn secondary" to={`/projects/${projectId}/experiments`}>
            ← Back to experiments
          </Link>
        }
      />
      <ErrorNotice message={error} />
      {!data && !error ? (
        <Loading label="Comparing runs" />
      ) : data ? (
        <div className="compare-board">
          <div className="compare-header" data-testid="compare-header">
            <div className="compare-header-spacer" aria-hidden="true" />
            {data.runs.map((run) => (
              <div key={run.run_id} className="compare-run-card">
                <strong>{runDisplayName(run)}</strong>
                <StatusBadge status={run.status} />
                <small className="mono">{run.run_id}</small>
              </div>
            ))}
          </div>

          <section className="panel compare-section compare-section-primary">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Performance</span>
                <h2>Metrics</h2>
              </div>
            </div>
            <div className="table-wrap catalog-table compare-table">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    {data.runs.map((run) => (
                      <th key={run.run_id}>{runDisplayName(run)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {primaryKeys.map((key, index) => (
                    <tr key={key} className={index === 0 ? "compare-primary-metric-row" : undefined}>
                      <td>
                        <span>{formatMetricLabel(key, targetColumns)}</span>
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
                <span className="eyebrow">Identity</span>
                <h2>Run context</h2>
              </div>
            </div>
            <div className="table-wrap catalog-table compare-table">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
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
                            <StatusBadge status={value} />
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

          <details className="panel advanced-json compare-section">
            <summary>
              <span className="eyebrow">Configuration</span>
              <strong> Parameters (technical)</strong>
            </summary>
            <div className="table-wrap catalog-table compare-table engineering-surface">
              <table>
                <thead>
                  <tr>
                    <th>Param</th>
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
