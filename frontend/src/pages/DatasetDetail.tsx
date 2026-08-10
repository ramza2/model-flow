import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiRequestError,
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

type ConditionDraft = {
  column: string;
  type: string;
  severity: string;
  min: string;
  max: string;
  values: string;
  pattern: string;
};

const RULE_TYPES = [
  { value: "not_null", label: "Not null" },
  { value: "unique", label: "Unique" },
  { value: "range", label: "Range" },
  { value: "allowed_values", label: "Allowed values" },
  { value: "regex", label: "Regex" },
] as const;

type QualityActionError = {
  message: string;
  scope: "panel" | "rule" | "form";
  ruleId?: number;
};

function emptyCondition(column = "target"): ConditionDraft {
  return {
    column,
    type: "not_null",
    severity: "fail",
    min: "",
    max: "",
    values: "",
    pattern: "",
  };
}

function conditionsFromRule(rule: QualityRule, fallbackColumn: string): ConditionDraft[] {
  const rows = Array.isArray(rule.rules) ? rule.rules : [];
  if (rows.length === 0) return [emptyCondition(fallbackColumn)];
  return rows.map((item) => ({
    column: String(item.column ?? fallbackColumn),
    type: String(item.type ?? "not_null"),
    severity: String(item.severity ?? "fail"),
    min: item.min !== undefined && item.min !== null ? String(item.min) : "",
    max: item.max !== undefined && item.max !== null ? String(item.max) : "",
    values: Array.isArray(item.values) ? item.values.map(String).join(", ") : "",
    pattern: item.pattern !== undefined ? String(item.pattern) : "",
  }));
}

function serializeConditions(conditions: ConditionDraft[]) {
  return conditions.map((condition) => {
    const base: Record<string, unknown> = {
      type: condition.type,
      column: condition.column,
      severity: condition.severity,
    };
    if (condition.type === "range") {
      if (condition.min !== "") base.min = Number(condition.min);
      if (condition.max !== "") base.max = Number(condition.max);
    }
    if (condition.type === "allowed_values") {
      base.values = condition.values
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (condition.type === "regex") {
      base.pattern = condition.pattern;
    }
    return base;
  });
}

function typeLabel(type: string) {
  return RULE_TYPES.find((item) => item.value === type)?.label ?? type;
}

function summarizeCondition(rule: Record<string, unknown>) {
  const type = String(rule.type ?? "");
  const column = String(rule.column ?? "—");
  const severity = String(rule.severity ?? "fail");
  return `${column} · ${typeLabel(type)} · ${severity}`;
}

export default function DatasetDetail() {
  const { projectId, datasetId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [ds, setDs] = useState<Dataset | null>(null);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ columns: string[]; rows: Array<Record<string, unknown>> } | null>(null);
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [legacyRules, setLegacyRules] = useState<QualityRule[]>([]);
  const [checks, setChecks] = useState<QualityCheck[]>([]);
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [showSplitForm, setShowSplitForm] = useState(false);
  const [splitName, setSplitName] = useState("split-1");
  const [splitTrainRatio, setSplitTrainRatio] = useState("0.70");
  const [splitValRatio, setSplitValRatio] = useState("0.15");
  const [splitTestRatio, setSplitTestRatio] = useState("0.15");
  const [splitSeed, setSplitSeed] = useState("42");
  const [splitFormError, setSplitFormError] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [ruleName, setRuleName] = useState("Required target");
  const [ruleActive, setRuleActive] = useState(true);
  const [ruleBlocking, setRuleBlocking] = useState(true);
  const [conditions, setConditions] = useState<ConditionDraft[]>([emptyCondition()]);
  const [expandedChecks, setExpandedChecks] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [qualityActionError, setQualityActionError] = useState<QualityActionError | null>(null);
  const [success, setSuccess] = useState("");
  const canWrite = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  const numericDatasetId = Number(datasetId);
  const activeRules = useMemo(() => rules.filter((rule) => rule.is_active), [rules]);
  const latestResult = checks[0]?.result ?? "—";

  function clearQualityActionError() {
    setQualityActionError(null);
  }

  function renderQualityActionError(
    scope: QualityActionError["scope"],
    ruleId?: number,
    testId = "quality-action-error",
  ) {
    if (!qualityActionError || qualityActionError.scope !== scope) return null;
    if (scope === "rule" && qualityActionError.ruleId !== ruleId) return null;
    return (
      <div className="error quality-action-error" role="alert" data-testid={testId}>
        {qualityActionError.message}
      </div>
    );
  }

  const loadRules = useCallback(async () => {
    const [scoped, legacy] = await Promise.all([
      api<QualityRule[]>(
        `/projects/${projectId}/quality-rules?dataset_id=${datasetId}&include_inactive=true&include_unassigned=false`,
      ),
      api<QualityRule[]>(
        `/projects/${projectId}/quality-rules?include_inactive=true&include_unassigned=true`,
      ),
    ]);
    setRules(scoped.filter((rule) => rule.dataset_id === numericDatasetId));
    setLegacyRules(legacy.filter((rule) => rule.dataset_id == null));
  }, [datasetId, numericDatasetId, projectId]);

  const load = useCallback(async () => {
    setError("");
    try {
      const [dataset, versionRows] = await Promise.all([
        api<Dataset>(`/projects/${projectId}/datasets/${datasetId}`),
        api<DatasetVersion[]>(`/projects/${projectId}/datasets/${datasetId}/versions`),
      ]);
      setDs(dataset);
      setVersions(versionRows);
      setSelectedVersionId((current) => current || versionRows[0]?.id || null);
      const fallback = dataset.columns.includes("target") ? "target" : dataset.columns[0] || "target";
      setConditions((current) =>
        current.length === 1 && !current[0].column ? [emptyCondition(fallback)] : current.map((row) => ({
          ...row,
          column: row.column || fallback,
        })),
      );
      await loadRules();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dataset could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [datasetId, loadRules, projectId]);

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
        setChecks(checkRows);
        setSplits(splitRows);
        setPreview(previewRows);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Version details could not be loaded."));
  }, [datasetId, projectId, selectedVersionId, versions]);

  function resetForm(fallbackColumn?: string) {
    const column = fallbackColumn
      || (ds?.columns.includes("target") ? "target" : ds?.columns[0])
      || "target";
    setEditingRuleId(null);
    setRuleName("Required target");
    setRuleActive(true);
    setRuleBlocking(true);
    setConditions([emptyCondition(column)]);
    setShowForm(false);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  function startEdit(rule: QualityRule) {
    const fallback = ds?.columns[0] || "target";
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleActive(rule.is_active);
    setRuleBlocking(rule.block_training_on_fail);
    setConditions(conditionsFromRule(rule, fallback));
    setShowForm(true);
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    setBusy("rule");
    clearQualityActionError();
    setSuccess("");
    const payload = {
      name: ruleName,
      dataset_id: numericDatasetId,
      is_active: ruleActive,
      block_training_on_fail: ruleBlocking,
      rules: serializeConditions(conditions),
    };
    try {
      if (editingRuleId == null) {
        await api(`/projects/${projectId}/quality-rules`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setSuccess("Quality rule created.");
      } else {
        await api(`/projects/${projectId}/quality-rules/${editingRuleId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setSuccess("Quality rule updated.");
      }
      resetForm();
      await loadRules();
    } catch (reason) {
      setQualityActionError({
        message: reason instanceof Error ? reason.message : "Quality rule could not be saved.",
        scope: "form",
      });
    } finally {
      setBusy("");
    }
  }

  async function runQuality(ruleId?: number) {
    if (!selectedVersionId) return;
    setBusy(ruleId ? `run-${ruleId}` : "quality");
    clearQualityActionError();
    setSuccess("");
    try {
      const body = ruleId == null ? {} : { quality_rule_id: ruleId };
      const result = await api<QualityCheck>(
        `/projects/${projectId}/dataset-versions/${selectedVersionId}/quality-checks`,
        { method: "POST", body: JSON.stringify(body) },
      );
      const [checkRows] = await Promise.all([
        api<QualityCheck[]>(`/projects/${projectId}/quality-checks?dataset_version_id=${selectedVersionId}`),
        loadRules(),
      ]);
      setChecks(checkRows);
      setExpandedChecks((current) => ({ ...current, [result.id]: true }));
      setSuccess(`Quality check completed: ${result.result}.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Quality check could not run.";
      if (ruleId == null) {
        setQualityActionError({ message, scope: "panel" });
      } else {
        setQualityActionError({ message, scope: "rule", ruleId });
      }
    } finally {
      setBusy("");
    }
  }

  async function toggleActive(rule: QualityRule) {
    setBusy(`active-${rule.id}`);
    clearQualityActionError();
    setSuccess("");
    try {
      await api(`/projects/${projectId}/quality-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !rule.is_active }),
      });
      setSuccess(rule.is_active ? "Rule deactivated." : "Rule activated.");
      await loadRules();
    } catch (reason) {
      setQualityActionError({
        message: reason instanceof Error ? reason.message : "Rule status could not be updated.",
        scope: "rule",
        ruleId: rule.id,
      });
    } finally {
      setBusy("");
    }
  }

  async function deleteRule(rule: QualityRule) {
    setBusy(`delete-${rule.id}`);
    clearQualityActionError();
    setSuccess("");
    try {
      await api(`/projects/${projectId}/quality-rules/${rule.id}`, { method: "DELETE" });
      setSuccess("Quality rule deleted.");
      if (editingRuleId === rule.id) resetForm();
      await loadRules();
    } catch (reason) {
      const message =
        reason instanceof ApiRequestError && reason.status === 409
          ? "This rule has check history. Deactivate it instead."
          : reason instanceof Error
            ? reason.message
            : "Quality rule could not be deleted.";
      setQualityActionError({ message, scope: "rule", ruleId: rule.id });
    } finally {
      setBusy("");
    }
  }

  async function assignLegacy(rule: QualityRule) {
    setBusy(`legacy-${rule.id}`);
    clearQualityActionError();
    setSuccess("");
    try {
      await api(`/projects/${projectId}/quality-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ dataset_id: numericDatasetId, is_active: true }),
      });
      setSuccess("Legacy rule assigned to this dataset and activated.");
      await loadRules();
    } catch (reason) {
      setQualityActionError({
        message: reason instanceof Error ? reason.message : "Legacy rule could not be assigned.",
        scope: "rule",
        ruleId: rule.id,
      });
    } finally {
      setBusy("");
    }
  }

  function validateSplitForm(): { train: number; val: number; test: number; seed: number } | null {
    const train = Number(splitTrainRatio);
    const val = Number(splitValRatio);
    const test = Number(splitTestRatio);
    const seed = Number(splitSeed);
    if (!Number.isFinite(train) || !Number.isFinite(val) || !Number.isFinite(test)) {
      setSplitFormError("Enter numeric train, validation, and test ratios.");
      return null;
    }
    if (!(train > 0 && train < 1 && val > 0 && val < 1 && test > 0 && test < 1)) {
      setSplitFormError("Each ratio must be greater than 0 and less than 1.");
      return null;
    }
    if (Math.abs(train + val + test - 1) > 1e-6) {
      setSplitFormError("Train + validation + test ratios must equal 1.0.");
      return null;
    }
    if (!Number.isInteger(seed)) {
      setSplitFormError("Random seed must be an integer.");
      return null;
    }
    setSplitFormError("");
    return { train, val, test, seed };
  }

  async function createSplit() {
    if (!selectedVersionId) return;
    const parsed = validateSplitForm();
    if (!parsed) return;
    setBusy("split");
    setError("");
    setSplitFormError("");
    try {
      const split = await api<DatasetSplit>(
        `/projects/${projectId}/dataset-versions/${selectedVersionId}/splits`,
        {
          method: "POST",
          body: JSON.stringify({
            name: splitName.trim() || `split-${splits.length + 1}`,
            train_ratio: parsed.train,
            val_ratio: parsed.val,
            test_ratio: parsed.test,
            random_seed: parsed.seed,
          }),
        },
      );
      setSplits((rows) => [split, ...rows.filter((row) => row.id !== split.id)]);
      setShowSplitForm(false);
      setSuccess(
        split.config_signature
          ? `Saved split #${split.id} ready (${Math.round(split.train_ratio * 100)}/${Math.round(split.val_ratio * 100)}/${Math.round(split.test_ratio * 100)}, seed ${split.random_seed}).`
          : `Saved split #${split.id} ready.`,
      );
    } catch (reason) {
      setSplitFormError(reason instanceof Error ? reason.message : "Dataset split could not be created.");
    } finally {
      setBusy("");
    }
  }

  const selected = versions.find((version) => version.id === selectedVersionId);
  const columns = ds?.columns ?? [];

  function renderRuleCard(rule: QualityRule, { legacy = false }: { legacy?: boolean } = {}) {
    const conditionLines = (Array.isArray(rule.rules) ? rule.rules : []).map((item) => summarizeCondition(item));
    return (
      <div className="quality-rule-card" key={rule.id} data-testid={`quality-rule-${rule.id}`}>
        <div className="quality-rule-head">
          <div>
            <strong>{rule.name}</strong>
            <div className="quality-rule-meta">
              <span className={`badge ${rule.is_active ? "ok" : "warn"}`}>{rule.is_active ? "Active" : "Inactive"}</span>
              <span className={`badge ${rule.block_training_on_fail ? "err" : "run"}`}>
                {rule.block_training_on_fail ? "Blocking" : "Non-blocking"}
              </span>
              {legacy ? <span className="badge warn">Needs dataset assignment</span> : null}
              <small>
                {legacy ? "Unassigned" : rule.dataset_name || `Dataset #${rule.dataset_id}`}
                {" · "}
                {conditionLines.length} condition{conditionLines.length === 1 ? "" : "s"}
              </small>
            </div>
          </div>
          {canWrite && (
            <div className="row-actions">
              {!legacy && (
                <button
                  type="button"
                  className="btn secondary"
                  data-testid={`quality-run-${rule.id}`}
                  disabled={busy !== "" || !rule.is_active}
                  onClick={() => void runQuality(rule.id)}
                >
                  {busy === `run-${rule.id}` ? "Running…" : "Run"}
                </button>
              )}
              <button type="button" className="btn secondary" data-testid={`quality-edit-${rule.id}`} disabled={busy !== ""} onClick={() => startEdit(rule)}>
                Edit
              </button>
              {!legacy && (
                <button
                  type="button"
                  className="btn secondary"
                  data-testid={`quality-toggle-${rule.id}`}
                  disabled={busy !== ""}
                  onClick={() => void toggleActive(rule)}
                >
                  {rule.is_active ? "Deactivate" : "Activate"}
                </button>
              )}
              {legacy ? (
                <button type="button" className="btn secondary" data-testid={`quality-assign-${rule.id}`} disabled={busy !== ""} onClick={() => void assignLegacy(rule)}>
                  Assign to dataset
                </button>
              ) : (
                <button type="button" className="btn secondary" data-testid={`quality-delete-${rule.id}`} disabled={busy !== ""} onClick={() => void deleteRule(rule)}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
        {renderQualityActionError("rule", rule.id, `quality-rule-error-${rule.id}`)}
        <ul className="quality-condition-list">
          {conditionLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
    );
  }

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
            <div className="stat" data-testid="quality-active-count"><div className="label">Active rules</div><div className="value">{activeRules.length}</div></div>
            <div className="stat" data-testid="quality-latest-result"><div className="label">Latest quality result</div><div className="value">{latestResult}</div></div>
            <div className="stat" data-testid="quality-check-count"><div className="label">Quality checks</div><div className="value">{checks.length}</div></div>
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
            <section className="panel" data-testid="quality-panel">
              <div className="panel-title">
                <div><span className="eyebrow">Trust</span><h2>Data quality</h2></div>
                {canWrite && (
                  <div className="row-actions">
                    <button className="btn secondary" data-testid="quality-run-all" disabled={busy !== "" || activeRules.length === 0} onClick={() => void runQuality()}>
                      {busy === "quality" ? "Running…" : "Run all checks"}
                    </button>
                    <button className="btn secondary" data-testid="quality-create" disabled={busy !== ""} onClick={startCreate}>New rule</button>
                  </div>
                )}
              </div>
              {renderQualityActionError("panel", undefined, "quality-action-error")}
              {rules.length === 0 ? (
                <p className="muted">No quality rules are assigned to this dataset yet.</p>
              ) : (
                <div className="quality-rule-list" data-testid="quality-rule-list">
                  {rules.map((rule) => renderRuleCard(rule))}
                </div>
              )}
              {canWrite && showForm && (
                <form className="quality-rule-form" data-testid="quality-rule-form" onSubmit={saveRule}>
                  <div className="panel-title"><div><h3>{editingRuleId == null ? "Create rule" : "Edit rule"}</h3></div></div>
                  {renderQualityActionError("form", undefined, "quality-form-error")}
                  <label>
                    Rule name
                    <input aria-label="Rule name" data-testid="quality-rule-name" value={ruleName} onChange={(event) => setRuleName(event.target.value)} required />
                  </label>
                  <div className="quality-form-toggles">
                    <label><input type="checkbox" data-testid="quality-rule-active" checked={ruleActive} onChange={(event) => setRuleActive(event.target.checked)} /> Active</label>
                    <label><input type="checkbox" data-testid="quality-rule-blocking" checked={ruleBlocking} onChange={(event) => setRuleBlocking(event.target.checked)} /> Block training on fail</label>
                  </div>
                  {conditions.map((condition, index) => (
                    <div className="quality-condition-editor" key={`condition-${index}`} data-testid={`quality-condition-${index}`}>
                      <select aria-label={`Condition ${index + 1} column`} value={condition.column} onChange={(event) => {
                        const next = [...conditions];
                        next[index] = { ...condition, column: event.target.value };
                        setConditions(next);
                      }}>
                        {columns.map((column) => <option key={column} value={column}>{column}</option>)}
                      </select>
                      <select aria-label={`Condition ${index + 1} type`} data-testid={`quality-condition-type-${index}`} value={condition.type} onChange={(event) => {
                        const next = [...conditions];
                        next[index] = { ...condition, type: event.target.value };
                        setConditions(next);
                      }}>
                        {RULE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                      <select aria-label={`Condition ${index + 1} severity`} value={condition.severity} onChange={(event) => {
                        const next = [...conditions];
                        next[index] = { ...condition, severity: event.target.value };
                        setConditions(next);
                      }}>
                        <option value="fail">Fail</option>
                        <option value="warning">Warning</option>
                      </select>
                      {condition.type === "range" && (
                        <>
                          <input aria-label={`Condition ${index + 1} min`} placeholder="Min" value={condition.min} onChange={(event) => {
                            const next = [...conditions];
                            next[index] = { ...condition, min: event.target.value };
                            setConditions(next);
                          }} />
                          <input aria-label={`Condition ${index + 1} max`} placeholder="Max" value={condition.max} onChange={(event) => {
                            const next = [...conditions];
                            next[index] = { ...condition, max: event.target.value };
                            setConditions(next);
                          }} />
                        </>
                      )}
                      {condition.type === "allowed_values" && (
                        <input
                          aria-label={`Condition ${index + 1} values`}
                          data-testid={`quality-condition-values-${index}`}
                          placeholder="Comma-separated values"
                          value={condition.values}
                          onChange={(event) => {
                            const next = [...conditions];
                            next[index] = { ...condition, values: event.target.value };
                            setConditions(next);
                          }}
                        />
                      )}
                      {condition.type === "regex" && (
                        <input
                          aria-label={`Condition ${index + 1} pattern`}
                          data-testid={`quality-condition-pattern-${index}`}
                          placeholder="Pattern"
                          value={condition.pattern}
                          onChange={(event) => {
                            const next = [...conditions];
                            next[index] = { ...condition, pattern: event.target.value };
                            setConditions(next);
                          }}
                        />
                      )}
                      <button
                        type="button"
                        className="btn secondary"
                        data-testid={`quality-remove-condition-${index}`}
                        disabled={conditions.length === 1}
                        onClick={() => setConditions(conditions.filter((_, itemIndex) => itemIndex !== index))}
                      >
                        Remove condition
                      </button>
                    </div>
                  ))}
                  <div className="row-actions">
                    <button type="button" className="btn secondary" data-testid="quality-add-condition" onClick={() => setConditions([...conditions, emptyCondition(columns[0] || "target")])}>
                      Add condition
                    </button>
                    <button className="btn" data-testid="quality-save-rule" disabled={busy === "rule"}>{busy === "rule" ? "Saving…" : "Save rule"}</button>
                    <button type="button" className="btn secondary" data-testid="quality-cancel-rule" onClick={() => resetForm()}>Cancel</button>
                  </div>
                </form>
              )}
              {legacyRules.length > 0 && (
                <div className="legacy-quality-rules" data-testid="legacy-quality-rules">
                  <h3>Legacy unassigned rules</h3>
                  <p className="muted">Needs dataset assignment · Inactive until assigned.</p>
                  {legacyRules.map((rule) => renderRuleCard(rule, { legacy: true }))}
                </div>
              )}
              <div className="quality-check-history" data-testid="quality-check-history">
                <h3>Check history</h3>
                {checks.length === 0 ? (
                  <p className="muted">No quality checks have been run for this version.</p>
                ) : (
                  checks.map((check) => {
                    const open = expandedChecks[check.id] ?? false;
                    return (
                      <details
                        key={check.id}
                        className="quality-check-item"
                        data-testid={`quality-check-${check.id}`}
                        open={open}
                        onToggle={(event) => {
                          const nextOpen = (event.target as HTMLDetailsElement).open;
                          setExpandedChecks((current) => ({ ...current, [check.id]: nextOpen }));
                        }}
                      >
                        <summary>
                          <strong>Check #{check.id}</strong>
                          <StatusBadge status={check.result} />
                          <small>{formatDate(check.created_at)}</small>
                        </summary>
                        <div className="quality-check-details">
                          {(check.details || []).map((detail, index) => {
                            const rule = detail.rule || {};
                            return (
                              <div key={`${check.id}-${index}`} className="quality-check-detail" data-testid={`quality-check-detail-${check.id}-${index}`}>
                                <div className="quality-check-detail-heading">
                                  <strong data-testid={`quality-check-rule-name-${check.id}-${index}`}>
                                    {detail.quality_rule_name || `Rule #${detail.quality_rule_id ?? "—"}`}
                                  </strong>
                                  <small data-testid={`quality-check-condition-${check.id}-${index}`}>
                                    {summarizeCondition(rule)} · {detail.passed ? "PASS" : "FAIL"}
                                  </small>
                                </div>
                                <div className="muted">{detail.message || "—"}</div>
                                <small>
                                  Severity: {detail.severity || String(rule.severity || "fail")}
                                  {" · "}
                                  Blocks training: {detail.block_training_on_fail ? "Yes" : "No"}
                                </small>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    );
                  })
                )}
              </div>
            </section>
            <section className="panel">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Reproducibility</span>
                  <h2>Data splits</h2>
                </div>
                {canWrite && (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy === "split"}
                    data-testid="open-create-split"
                    onClick={() => {
                      setShowSplitForm((open) => !open);
                      setSplitFormError("");
                      setSplitName(`split-${splits.length + 1}`);
                      setSplitTrainRatio("0.70");
                      setSplitValRatio("0.15");
                      setSplitTestRatio("0.15");
                      setSplitSeed("42");
                    }}
                  >
                    {showSplitForm ? "Cancel" : "Create split"}
                  </button>
                )}
              </div>
              {showSplitForm && canWrite && (
                <div className="form" data-testid="create-split-form">
                  <div className="form-grid">
                    <label>
                      Name
                      <input
                        value={splitName}
                        onChange={(event) => setSplitName(event.target.value)}
                        data-testid="split-name"
                      />
                    </label>
                    <label>
                      Train ratio
                      <input
                        value={splitTrainRatio}
                        onChange={(event) => {
                          setSplitFormError("");
                          setSplitTrainRatio(event.target.value);
                        }}
                        data-testid="split-train-ratio"
                      />
                    </label>
                    <label>
                      Validation ratio
                      <input
                        value={splitValRatio}
                        onChange={(event) => {
                          setSplitFormError("");
                          setSplitValRatio(event.target.value);
                        }}
                        data-testid="split-val-ratio"
                      />
                    </label>
                    <label>
                      Test ratio
                      <input
                        value={splitTestRatio}
                        onChange={(event) => {
                          setSplitFormError("");
                          setSplitTestRatio(event.target.value);
                        }}
                        data-testid="split-test-ratio"
                      />
                    </label>
                    <label>
                      Random seed
                      <input
                        value={splitSeed}
                        onChange={(event) => {
                          setSplitFormError("");
                          setSplitSeed(event.target.value);
                        }}
                        data-testid="split-seed"
                      />
                    </label>
                  </div>
                  {splitFormError ? (
                    <div className="error" role="alert" data-testid="split-form-error">
                      {splitFormError}
                    </div>
                  ) : null}
                  <div className="row-actions form-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy === "split"}
                      onClick={createSplit}
                      data-testid="create-split-submit"
                    >
                      {busy === "split" ? "Creating…" : "Save split"}
                    </button>
                  </div>
                </div>
              )}
              {splits.length === 0 ? (
                <EmptyState title="No saved splits" description="Create a deterministic split for repeatable training." />
              ) : (
                <div className="activity-list compact" data-testid="saved-splits-list">
                  {splits.map((split) => (
                    <div key={split.id} data-testid={`saved-split-${split.id}`}>
                      <div>
                        <strong>{split.name}</strong>
                        <small>#{split.id} · seed {split.random_seed}</small>
                      </div>
                      <span>
                        {Math.round(split.train_ratio * 100)}/{Math.round(split.val_ratio * 100)}/{Math.round(split.test_ratio * 100)}
                      </span>
                    </div>
                  ))}
                </div>
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
