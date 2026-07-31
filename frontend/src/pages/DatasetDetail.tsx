import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  type Dataset,
  type DatasetSplit,
  type DatasetVersion,
  type QualityCheck,
  type QualityRule,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";
import { userCanProject, useProject } from "../ProjectContext";

export default function DatasetDetail() {
  const { projectId, datasetId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [ds, setDs] = useState<Dataset | null>(null);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ columns: string[]; rows: Array<Record<string, unknown>> } | null>(null);
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [checks, setChecks] = useState<QualityCheck[]>([]);
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [ruleName, setRuleName] = useState("Required target");
  const [ruleColumn, setRuleColumn] = useState("target");
  const [ruleType, setRuleType] = useState("not_null");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canWrite = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  const load = useCallback(async () => {
    setError("");
    try {
      const [dataset, versionRows, ruleRows] = await Promise.all([
        api<Dataset>(`/projects/${projectId}/datasets/${datasetId}`),
        api<DatasetVersion[]>(`/projects/${projectId}/datasets/${datasetId}/versions`),
        api<QualityRule[]>(`/projects/${projectId}/quality-rules`),
      ]);
      setDs(dataset);
      setVersions(versionRows);
      setRules(ruleRows);
      setSelectedVersionId((current) => current || versionRows[0]?.id || null);
      if (dataset.columns.includes("target")) setRuleColumn("target");
      else if (dataset.columns[0]) setRuleColumn(dataset.columns[0]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dataset could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [datasetId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const selected = versions.find((version) => version.id === selectedVersionId);
    if (!selected) return;
    setPreview(null);
    Promise.all([
      api<{ columns: string[]; rows: Array<Record<string, unknown>> }>(
        `/projects/${projectId}/datasets/${datasetId}/versions/${selected.version}/preview`,
      ),
      api<QualityCheck[]>(`/projects/${projectId}/quality-checks?dataset_version_id=${selected.id}`),
      api<DatasetSplit[]>(`/projects/${projectId}/dataset-versions/${selected.id}/splits`),
    ])
      .then(([previewRows, checkRows, splitRows]) => {
        setPreview(previewRows);
        setChecks(checkRows);
        setSplits(splitRows);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Version details could not be loaded."));
  }, [datasetId, projectId, selectedVersionId, versions]);

  async function createRule(event: FormEvent) {
    event.preventDefault();
    setBusy("rule");
    setError("");
    try {
      await api(`/projects/${projectId}/quality-rules`, {
        method: "POST",
        body: JSON.stringify({
          name: ruleName,
          rules: [{ type: ruleType, column: ruleColumn, severity: "fail" }],
          block_training_on_fail: true,
        }),
      });
      setSuccess("Quality rule created.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Quality rule could not be created.");
    } finally {
      setBusy("");
    }
  }

  async function runQuality() {
    if (!selectedVersionId) return;
    setBusy("quality");
    setError("");
    try {
      const result = await api<QualityCheck>(
        `/projects/${projectId}/dataset-versions/${selectedVersionId}/quality-checks`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setChecks((rows) => [result, ...rows]);
      setSuccess(`Quality check completed: ${result.result}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Quality check could not run.");
    } finally {
      setBusy("");
    }
  }

  async function createSplit() {
    if (!selectedVersionId) return;
    setBusy("split");
    setError("");
    try {
      const split = await api<DatasetSplit>(
        `/projects/${projectId}/dataset-versions/${selectedVersionId}/splits`,
        {
          method: "POST",
          body: JSON.stringify({ name: `split-${splits.length + 1}`, train_ratio: 0.7, val_ratio: 0.15, test_ratio: 0.15, random_seed: 42 }),
        },
      );
      setSplits((rows) => [split, ...rows]);
      setSuccess("Reproducible 70/15/15 split created.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dataset split could not be created.");
    } finally {
      setBusy("");
    }
  }

  const selected = versions.find((version) => version.id === selectedVersionId);

  return (
    <div>
      <PageHeader
        title={ds?.name ?? "Dataset"}
        description={ds ? `${ds.row_count.toLocaleString()} rows · ${ds.column_count} columns · ${versions.length} version${versions.length === 1 ? "" : "s"}` : "Dataset profile and history."}
        actions={canWrite ? <Link className="btn" to={`/projects/${projectId}/jobs/new?datasetId=${datasetId}`}>▶ Train on this dataset</Link> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {loading ? <Loading label="Loading dataset" /> : (
        <>
          <div className="detail-toolbar">
            <label>Dataset version<select value={selectedVersionId ?? ""} onChange={(event) => setSelectedVersionId(Number(event.target.value))}>
              {versions.map((version) => <option key={version.id} value={version.id}>v{version.version} · {formatDate(version.created_at)}</option>)}
            </select></label>
            {selected && <StatusBadge status={selected.source_type} />}
          </div>
          <div className="grid stats-grid">
            <div className="stat"><div className="label">Rows</div><div className="value">{selected?.row_count.toLocaleString() ?? "—"}</div></div>
            <div className="stat"><div className="label">Columns</div><div className="value">{selected?.column_count ?? "—"}</div></div>
            <div className="stat"><div className="label">Quality checks</div><div className="value">{checks.length}</div></div>
            <div className="stat"><div className="label">Saved splits</div><div className="value">{splits.length}</div></div>
          </div>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">Profile</span><h2>Column statistics</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Column</th><th>Type</th><th>Nulls</th><th>Unique</th><th>Summary</th></tr></thead>
                <tbody>
                  {selected?.columns.map((column) => {
                    const stat = selected.stats[column] || {};
                    const summary = stat.mean !== undefined
                      ? `min ${String(stat.min)} · max ${String(stat.max)} · mean ${Number(stat.mean).toFixed(3)}`
                      : stat.top_values ? JSON.stringify(stat.top_values) : "—";
                    return <tr key={column}><td className="mono">{column}</td><td>{selected.dtypes[column]}</td><td>{String(stat.null_count ?? 0)}</td><td>{String(stat.unique_count ?? 0)}</td><td className="mono muted">{summary}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">Sample</span><h2>Data preview</h2></div></div>
            {!preview ? <Loading label="Loading preview" /> : preview.rows.length === 0 ? <EmptyState title="No preview rows" description="This dataset version does not contain displayable rows." /> : (
              <div className="table-wrap">
                <table><thead><tr>{preview.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                  <tbody>{preview.rows.slice(0, 10).map((row, index) => <tr key={index}>{preview.columns.map((column) => <td key={column}>{String(row[column] ?? "—")}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </section>
          <div className="two-column">
            <section className="panel">
              <div className="panel-title"><div><span className="eyebrow">Trust</span><h2>Data quality</h2></div>{canWrite && <button className="btn secondary" disabled={busy === "quality" || rules.length === 0} onClick={runQuality}>{busy === "quality" ? "Running…" : "Run all checks"}</button>}</div>
              {rules.length === 0 ? <p className="muted">Create a rule before running quality checks.</p> : <p className="muted">{rules.length} rule set{rules.length === 1 ? "" : "s"} configured.</p>}
              {canWrite && <form className="compact-form" onSubmit={createRule}>
                <input aria-label="Rule name" value={ruleName} onChange={(event) => setRuleName(event.target.value)} required />
                <select aria-label="Rule column" value={ruleColumn} onChange={(event) => setRuleColumn(event.target.value)}>{ds?.columns.map((column) => <option key={column}>{column}</option>)}</select>
                <select aria-label="Rule type" value={ruleType} onChange={(event) => setRuleType(event.target.value)}><option value="not_null">Not null</option><option value="unique">Unique</option></select>
                <button className="btn secondary" disabled={busy === "rule"}>Add rule</button>
              </form>}
              <div className="activity-list compact">
                {checks.map((check) => <div key={check.id}><div><strong>Check #{check.id}</strong><small>{formatDate(check.created_at)}</small></div><StatusBadge status={check.result} /></div>)}
              </div>
            </section>
            <section className="panel">
              <div className="panel-title"><div><span className="eyebrow">Reproducibility</span><h2>Data splits</h2></div>{canWrite && <button className="btn secondary" disabled={busy === "split"} onClick={createSplit}>{busy === "split" ? "Creating…" : "Create 70/15/15 split"}</button>}</div>
              {splits.length === 0 ? <EmptyState title="No saved splits" description="Create a deterministic split for repeatable training." /> : (
                <div className="activity-list compact">{splits.map((split) => <div key={split.id}><div><strong>{split.name}</strong><small>seed {split.random_seed}</small></div><span>{Math.round(split.train_ratio * 100)}/{Math.round(split.val_ratio * 100)}/{Math.round(split.test_ratio * 100)}</span></div>)}</div>
              )}
            </section>
          </div>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">History</span><h2>Versions</h2></div></div>
            <div className="activity-list">{versions.map((version) => <button className="activity-button" key={version.id} onClick={() => setSelectedVersionId(version.id)}><div><strong>Version {version.version}</strong><small>{version.original_filename} · {formatDate(version.created_at)}</small></div><span>{version.row_count.toLocaleString()} rows</span></button>)}</div>
          </section>
        </>
      )}
    </div>
  );
}
