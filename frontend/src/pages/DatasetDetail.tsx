import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ApiRequestError,
  api,
  type Dataset,
  type DatasetSplit,
  type DatasetVersion,
  type DatasetVersionLineage,
  type QualityCheck,
  type QualityRule,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  HelpTip,
  Loading,
  PageHeader,
  StatusBadge,
  TermLabel,
  SuccessNotice,
  formatDate,
} from "../components";
import { userCanProject, useProject } from "../ProjectContext";
import { UI_HELP } from "../uiTerminology";

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
  { value: "not_null", label: "필수값 검사 (Not null)" },
  { value: "unique", label: "중복 금지 (Unique)" },
  { value: "range", label: "범위 검사 (Range)" },
  { value: "allowed_values", label: "허용 값 검사 (Allowed values)" },
  { value: "regex", label: "정규식 검사 (Regex)" },
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

/** Display-only severity labels; persisted values stay fail / warning. */
function severityLabel(severity: string) {
  const normalized = String(severity || "").toLowerCase();
  if (normalized === "fail") return "실패 (Fail)";
  if (normalized === "warning") return "경고 (Warning)";
  return severity || "—";
}

/** Display-only check result labels; StatusBadge / API values stay PASS / FAIL. */
function qualityResultLabel(result: string) {
  const normalized = String(result || "").toUpperCase();
  if (normalized === "PASS") return "통과 (PASS)";
  if (normalized === "FAIL") return "실패 (FAIL)";
  return result || "—";
}

/** Display-only dataset source_type labels; persisted values stay English. */
function datasetSourceTypeLabel(sourceType?: string | null) {
  const normalized = String(sourceType || "").toLowerCase();
  if (normalized === "preparation") return "데이터 가공";
  if (normalized === "upload") return "업로드";
  if (normalized === "feedback_materialization") return "피드백 반영";
  return sourceType || "—";
}

/** Display-only run status labels; persisted values stay English. */
function runStatusLabel(status?: string | null) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "succeeded") return "성공";
  if (normalized === "failed") return "실패";
  if (normalized === "running") return "실행 중";
  if (normalized === "created") return "생성됨";
  if (normalized === "queued") return "대기 중";
  return status || "—";
}

function summarizeCondition(rule: Record<string, unknown>) {
  const type = String(rule.type ?? "");
  const column = String(rule.column ?? "—");
  const severity = String(rule.severity ?? "fail");
  return `${column} · ${typeLabel(type)} · ${severityLabel(severity)}`;
}

export default function DatasetDetail() {
  const { projectId, datasetId } = useParams();
  const [searchParams] = useSearchParams();
  const versionQuery = searchParams.get("version");
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
  const [lineage, setLineage] = useState<DatasetVersionLineage | null>(null);
  const [showSplitForm, setShowSplitForm] = useState(false);
  const [splitName, setSplitName] = useState("split-1");
  const [splitTrainRatio, setSplitTrainRatio] = useState("0.70");
  const [splitValRatio, setSplitValRatio] = useState("0.15");
  const [splitTestRatio, setSplitTestRatio] = useState("0.15");
  const [splitSeed, setSplitSeed] = useState("42");
  const [splitStrategy, setSplitStrategy] = useState<"random" | "time">("random");
  const [splitTimeColumn, setSplitTimeColumn] = useState("");
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
      setSelectedVersionId((current) => {
        if (versionQuery) {
          const matched = versionRows.find(
            (row) => String(row.version) === String(versionQuery),
          );
          if (matched) return matched.id;
        }
        return current || versionRows[0]?.id || null;
      });
      const fallback = dataset.columns.includes("target") ? "target" : dataset.columns[0] || "target";
      setConditions((current) =>
        current.length === 1 && !current[0].column ? [emptyCondition(fallback)] : current.map((row) => ({
          ...row,
          column: row.column || fallback,
        })),
      );
      await loadRules();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "데이터셋을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [datasetId, loadRules, projectId, versionQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const selected = versions.find((version) => version.id === selectedVersionId);
    if (!selected) return;
    setPreview(null);
    setLineage(null);
    Promise.all([
      api<{ columns: string[]; rows: Array<Record<string, unknown>> }>(
        `/projects/${projectId}/datasets/${datasetId}/versions/${selected.version}/preview`,
      ),
      api<QualityCheck[]>(`/projects/${projectId}/quality-checks?dataset_version_id=${selected.id}`),
      api<DatasetSplit[]>(`/projects/${projectId}/dataset-versions/${selected.id}/splits`),
      api<DatasetVersionLineage>(
        `/projects/${projectId}/datasets/${datasetId}/versions/${selected.version}/lineage`,
      ).catch(() => null),
    ])
      .then(([previewRows, checkRows, splitRows, lineageRow]) => {
        setChecks(checkRows);
        setSplits(splitRows);
        setPreview(previewRows);
        setLineage(lineageRow);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "데이터셋 버전 정보를 불러오지 못했습니다."));
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
        setSuccess("품질 규칙을 만들었습니다.");
      } else {
        await api(`/projects/${projectId}/quality-rules/${editingRuleId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setSuccess("품질 규칙을 수정했습니다.");
      }
      resetForm();
      await loadRules();
    } catch (reason) {
      setQualityActionError({
        message: reason instanceof Error ? reason.message : "품질 규칙을 저장하지 못했습니다.",
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
      setSuccess(`품질 검사가 완료되었습니다: ${qualityResultLabel(result.result)}.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "품질 검사를 실행하지 못했습니다.";
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
      setSuccess(rule.is_active ? "품질 규칙을 비활성화했습니다." : "품질 규칙을 활성화했습니다.");
      await loadRules();
    } catch (reason) {
      setQualityActionError({
        message: reason instanceof Error ? reason.message : "규칙 상태를 변경하지 못했습니다.",
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
      setSuccess("품질 규칙을 삭제했습니다.");
      if (editingRuleId === rule.id) resetForm();
      await loadRules();
    } catch (reason) {
      const message =
        reason instanceof ApiRequestError && reason.status === 409
          ? "이 규칙에는 검사 기록이 있어 삭제할 수 없습니다. 대신 비활성화하세요."
          : reason instanceof Error
            ? reason.message
            : "품질 규칙을 삭제하지 못했습니다.";
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
      setSuccess("기존 규칙을 이 데이터셋에 연결하고 활성화했습니다.");
      await loadRules();
    } catch (reason) {
      setQualityActionError({
        message: reason instanceof Error ? reason.message : "기존 규칙을 연결하지 못했습니다.",
        scope: "rule",
        ruleId: rule.id,
      });
    } finally {
      setBusy("");
    }
  }

  function validateSplitForm(): {
    train: number;
    val: number;
    test: number;
    seed: number;
    strategy: "random" | "time";
    timeColumn: string | null;
  } | null {
    const train = Number(splitTrainRatio);
    const val = Number(splitValRatio);
    const test = Number(splitTestRatio);
    const seed = Number(splitSeed);
    if (!Number.isFinite(train) || !Number.isFinite(val) || !Number.isFinite(test)) {
      setSplitFormError("학습/검증/테스트 비율을 숫자로 입력하세요.");
      return null;
    }
    if (!(train > 0 && train < 1 && val > 0 && val < 1 && test > 0 && test < 1)) {
      setSplitFormError("각 비율은 0보다 크고 1보다 작아야 합니다.");
      return null;
    }
    if (Math.abs(train + val + test - 1) > 1e-6) {
      setSplitFormError("학습 + 검증 + 테스트 비율의 합은 1.0이어야 합니다.");
      return null;
    }
    if (!Number.isInteger(seed)) {
      setSplitFormError("난수 시드는 정수여야 합니다.");
      return null;
    }
    if (splitStrategy === "time") {
      const column = splitTimeColumn.trim();
      if (!column) {
        setSplitFormError("시간 순서 분할에 사용할 시간 기준 컬럼을 선택하세요.");
        return null;
      }
      const version = versions.find((row) => row.id === selectedVersionId);
      const versionColumns = version?.columns?.length ? version.columns : (ds?.columns ?? []);
      if (!versionColumns.includes(column)) {
        setSplitFormError("시간 기준 컬럼은 현재 데이터셋 버전에 존재하는 컬럼이어야 합니다.");
        return null;
      }
      setSplitFormError("");
      return { train, val, test, seed, strategy: "time", timeColumn: column };
    }
    setSplitFormError("");
    return { train, val, test, seed, strategy: "random", timeColumn: null };
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
            split_strategy: parsed.strategy,
            time_column: parsed.timeColumn,
          }),
        },
      );
      setSplits((rows) => [split, ...rows.filter((row) => row.id !== split.id)]);
      setShowSplitForm(false);
      const ratios = `${Math.round(split.train_ratio * 100)}/${Math.round(split.val_ratio * 100)}/${Math.round(split.test_ratio * 100)}`;
      const strategyLabel =
        (split.split_strategy || "random") === "time"
          ? `시간 순서 (Time ordered) · ${split.time_column || "—"}`
          : "무작위 (Random)";
      const successDetail =
        (split.split_strategy || "random") === "time"
          ? `${strategyLabel}, ${ratios}`
          : `${strategyLabel}, ${ratios}, 시드 ${split.random_seed}`;
      setSuccess(`데이터 분할 #${split.id}을 저장했습니다. (${successDetail})`);
    } catch (reason) {
      setSplitFormError(reason instanceof Error ? reason.message : "데이터 분할을 저장하지 못했습니다.");
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
              <span className={`badge ${rule.is_active ? "ok" : "warn"}`}>{rule.is_active ? "활성" : "비활성"}</span>
              <span className={`badge ${rule.block_training_on_fail ? "err" : "run"}`}>
                {rule.block_training_on_fail ? "학습 차단" : "비차단"}
              </span>
              {legacy ? <span className="badge warn">데이터셋 연결 필요</span> : null}
              <small>
                {legacy ? "미할당" : rule.dataset_name || `데이터셋 #${rule.dataset_id}`}
                {" · "}
                {`조건 ${conditionLines.length}개`}
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
                  {busy === `run-${rule.id}` ? "검사 중…" : "검사 실행"}
                </button>
              )}
              <button type="button" className="btn secondary" data-testid={`quality-edit-${rule.id}`} disabled={busy !== ""} onClick={() => startEdit(rule)}>
                수정
              </button>
              {!legacy && (
                <button
                  type="button"
                  className="btn secondary"
                  data-testid={`quality-toggle-${rule.id}`}
                  disabled={busy !== ""}
                  onClick={() => void toggleActive(rule)}
                >
                  {rule.is_active ? "비활성화" : "활성화"}
                </button>
              )}
              {legacy ? (
                <button type="button" className="btn secondary" data-testid={`quality-assign-${rule.id}`} disabled={busy !== ""} onClick={() => void assignLegacy(rule)}>
                  데이터셋에 연결
                </button>
              ) : (
                <button type="button" className="btn secondary" data-testid={`quality-delete-${rule.id}`} disabled={busy !== ""} onClick={() => void deleteRule(rule)}>
                  삭제
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
        title={ds?.name ?? "데이터셋"}
        description={ds ? `${ds.row_count.toLocaleString()}행 · ${ds.column_count}컬럼 · ${versions.length}개 버전` : "데이터셋 정보와 버전 이력입니다."}
        actions={canWrite && selectedVersionId != null ? (
          <Link
            className="btn"
            to={`/projects/${projectId}/jobs/new?datasetId=${datasetId}&datasetVersionId=${selectedVersionId}`}
            data-testid="train-on-dataset"
          >
            ▶ 이 데이터셋으로 학습
          </Link>
        ) : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {loading ? <Loading label="데이터셋 불러오는 중" /> : (
        <>
          <div className="detail-toolbar">
            <label>데이터셋 버전<select value={selectedVersionId ?? ""} onChange={(event) => setSelectedVersionId(Number(event.target.value))}>
              {versions.map((version) => <option key={version.id} value={version.id}>v{version.version} · {formatDate(version.created_at)}</option>)}
            </select></label>
            {selected && (
              <StatusBadge
                status={selected.source_type}
                label={datasetSourceTypeLabel(selected.source_type)}
              />
            )}
          </div>
          <div className="grid stats-grid">
            <div className="stat"><div className="label">행</div><div className="value">{selected?.row_count.toLocaleString() ?? "—"}</div></div>
            <div className="stat"><div className="label">컬럼</div><div className="value">{selected?.column_count ?? "—"}</div></div>
            <div className="stat" data-testid="quality-active-count"><div className="label">활성 규칙</div><div className="value">{activeRules.length}</div></div>
            <div className="stat" data-testid="quality-latest-result"><div className="label">최근 품질 결과</div><div className="value">{qualityResultLabel(latestResult)}</div></div>
            <div className="stat" data-testid="quality-check-count"><div className="label">품질 검사</div><div className="value">{checks.length}</div></div>
            <div className="stat"><div className="label">저장된 분할</div><div className="value">{splits.length}</div></div>
          </div>
          <section className="panel" data-testid="dataset-lifecycle-entry">
            <div className="panel-title"><div><span className="eyebrow">학습 흐름</span><h2>이 데이터셋으로 학습 시작</h2></div></div>
            <p className="form-hint">
              데이터셋 → 모델 학습 → 실험 실행 → 모델 버전 → 모델 배포 순서로 이어집니다. ‘이 데이터셋으로 학습’ 버튼을 누르면 현재 선택한 데이터셋 버전이 미리 지정된 학습 생성 화면으로 이동합니다.
            </p>
          </section>
          {lineage?.upstream && (
            <section
              className="panel dataset-upstream-lineage"
              data-testid="dataset-upstream-lineage"
            >
              <div className="panel-title">
                <div>
                  <span className="eyebrow">생성 경로</span>
                  <h2>데이터 가공으로 생성됨</h2>
                </div>
              </div>
              <dl>
                <div>
                  <dt>데이터 가공</dt>
                  <dd>
                    <Link
                      to={`/projects/${projectId}/preparations/${lineage.upstream.preparation.id}`}
                      data-testid="dataset-upstream-preparation-link"
                    >
                      {lineage.upstream.preparation.name}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt>가공 버전</dt>
                  <dd>v{lineage.upstream.preparation_version.version}</dd>
                </div>
                <div>
                  <dt>가공 실행</dt>
                  <dd>
                    #{lineage.upstream.preparation_run.id} ·{" "}
                    <StatusBadge
                      status={lineage.upstream.preparation_run.status}
                      label={runStatusLabel(lineage.upstream.preparation_run.status)}
                    />
                  </dd>
                </div>
              </dl>
              {lineage.upstream.input_versions.length > 0 && (
                <div>
                  <span className="eyebrow">입력 데이터 버전</span>
                  <ul className="dataset-upstream-inputs" data-testid="dataset-upstream-inputs">
                    {lineage.upstream.input_versions.map((input) => (
                      <li key={`${input.node_id}-${input.dataset_version_id}`}>
                        <Link to={`/projects/${projectId}/datasets/${input.dataset_id}`}>
                          {input.dataset_name || `데이터셋 #${input.dataset_id}`}
                        </Link>
                        {input.version != null ? ` · v${input.version}` : ""} · 노드{" "}
                        {input.node_id}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">데이터 정보</span><h2>컬럼 통계</h2></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>컬럼</th><th>자료형</th><th>결측값</th><th>고유값</th><th>요약</th></tr></thead>
                <tbody>
                  {selected?.columns.map((column) => {
                    const stat = selected.stats[column] || {};
                    const summary = stat.mean !== undefined
                      ? `최소값 ${String(stat.min)} · 최대값 ${String(stat.max)} · 평균 ${Number(stat.mean).toFixed(3)}`
                      : stat.top_values ? JSON.stringify(stat.top_values) : "—";
                    return <tr key={column}><td className="mono">{column}</td><td>{selected.dtypes[column]}</td><td>{String(stat.null_count ?? 0)}</td><td>{String(stat.unique_count ?? 0)}</td><td className="mono muted">{summary}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">샘플</span><h2>데이터 미리보기</h2></div></div>
            {!preview ? <Loading label="미리보기 불러오는 중" /> : preview.rows.length === 0 ? <EmptyState title="미리보기 데이터가 없습니다" description="이 데이터셋 버전에는 표시할 수 있는 행이 없습니다." /> : (
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
                <div>
                  <span className="eyebrow">신뢰성</span>
                  <h2>
                    <TermLabel ko="데이터 품질" en="Data quality" help={UI_HELP.dataQuality} />
                  </h2>
                </div>
                {canWrite && (
                  <div className="row-actions">
                    <button className="btn secondary" data-testid="quality-run-all" disabled={busy !== "" || activeRules.length === 0} onClick={() => void runQuality()}>
                      {busy === "quality" ? "검사 중…" : "전체 검사 실행"}
                    </button>
                    <button className="btn secondary" data-testid="quality-create" disabled={busy !== ""} onClick={startCreate}>새 규칙</button>
                  </div>
                )}
              </div>
              {renderQualityActionError("panel", undefined, "quality-action-error")}
              {rules.length === 0 ? (
                <p className="muted">이 데이터셋에 등록된 품질 규칙이 없습니다. 새 규칙을 만들어 데이터 오류를 자동으로 검사할 수 있습니다.</p>
              ) : (
                <div className="quality-rule-list" data-testid="quality-rule-list">
                  {rules.map((rule) => renderRuleCard(rule))}
                </div>
              )}
              {canWrite && showForm && (
                <form className="quality-rule-form" data-testid="quality-rule-form" onSubmit={saveRule}>
                  <div className="panel-title"><div><h3>{editingRuleId == null ? "품질 규칙 만들기" : "품질 규칙 수정"}</h3></div></div>
                  {renderQualityActionError("form", undefined, "quality-form-error")}
                  <label>
                    규칙 이름
                    <input aria-label="규칙 이름" data-testid="quality-rule-name" value={ruleName} onChange={(event) => setRuleName(event.target.value)} required />
                  </label>
                  <div className="quality-form-toggles">
                    <label>
                      <input type="checkbox" data-testid="quality-rule-active" checked={ruleActive} onChange={(event) => setRuleActive(event.target.checked)} />
                      {" "}규칙 활성화
                    </label>
                    <label>
                      <input type="checkbox" data-testid="quality-rule-blocking" checked={ruleBlocking} onChange={(event) => setRuleBlocking(event.target.checked)} />
                      {" "}
                      <TermLabel ko="실패 시 학습 차단" help={UI_HELP.qualityBlocking} />
                    </label>
                  </div>
                  {conditions.map((condition, index) => (
                    <div className="quality-condition-editor" key={`condition-${index}`} data-testid={`quality-condition-${index}`}>
                      <div className="quality-condition-main">
                        <label className="quality-condition-field">
                          <span className="quality-condition-field-label">검사 컬럼</span>
                          <select
                            aria-label={`조건 ${index + 1} 컬럼`}
                            value={condition.column}
                            onChange={(event) => {
                              const next = [...conditions];
                              next[index] = { ...condition, column: event.target.value };
                              setConditions(next);
                            }}
                          >
                            {columns.map((column) => <option key={column} value={column}>{column}</option>)}
                          </select>
                        </label>
                        <label className="quality-condition-field">
                          <span className="quality-condition-field-label">검사 유형</span>
                          <select
                            aria-label={`조건 ${index + 1} 검사 유형`}
                            data-testid={`quality-condition-type-${index}`}
                            value={condition.type}
                            onChange={(event) => {
                              const next = [...conditions];
                              next[index] = { ...condition, type: event.target.value };
                              setConditions(next);
                            }}
                          >
                            {RULE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </label>
                        <label className="quality-condition-field">
                          <span className="quality-condition-field-label">
                            심각도
                            {index === 0 ? <HelpTip text={UI_HELP.qualitySeverity} /> : null}
                          </span>
                          <select
                            aria-label={`조건 ${index + 1} 심각도`}
                            value={condition.severity}
                            onChange={(event) => {
                              const next = [...conditions];
                              next[index] = { ...condition, severity: event.target.value };
                              setConditions(next);
                            }}
                          >
                            <option value="fail">실패 (Fail)</option>
                            <option value="warning">경고 (Warning)</option>
                          </select>
                        </label>
                      </div>
                      {(condition.type === "range"
                        || condition.type === "allowed_values"
                        || condition.type === "regex") && (
                        <div className="quality-condition-extra">
                          {condition.type === "range" ? (
                            <div className="quality-range-fields">
                              <label className="quality-condition-field">
                                <span className="quality-condition-field-label">최소값</span>
                                <input
                                  aria-label={`조건 ${index + 1} 최소값`}
                                  placeholder="최소값"
                                  value={condition.min}
                                  onChange={(event) => {
                                    const next = [...conditions];
                                    next[index] = { ...condition, min: event.target.value };
                                    setConditions(next);
                                  }}
                                />
                              </label>
                              <label className="quality-condition-field">
                                <span className="quality-condition-field-label">최대값</span>
                                <input
                                  aria-label={`조건 ${index + 1} 최대값`}
                                  placeholder="최대값"
                                  value={condition.max}
                                  onChange={(event) => {
                                    const next = [...conditions];
                                    next[index] = { ...condition, max: event.target.value };
                                    setConditions(next);
                                  }}
                                />
                              </label>
                            </div>
                          ) : null}
                          {condition.type === "allowed_values" ? (
                            <label className="quality-condition-field">
                              <span className="quality-condition-field-label">허용 값</span>
                              <input
                                aria-label={`조건 ${index + 1} 허용 값`}
                                data-testid={`quality-condition-values-${index}`}
                                placeholder="허용 값을 쉼표로 구분"
                                value={condition.values}
                                onChange={(event) => {
                                  const next = [...conditions];
                                  next[index] = { ...condition, values: event.target.value };
                                  setConditions(next);
                                }}
                              />
                            </label>
                          ) : null}
                          {condition.type === "regex" ? (
                            <label className="quality-condition-field">
                              <span className="quality-condition-field-label">정규식 패턴</span>
                              <input
                                aria-label={`조건 ${index + 1} 정규식 패턴`}
                                data-testid={`quality-condition-pattern-${index}`}
                                placeholder="정규식 패턴"
                                value={condition.pattern}
                                onChange={(event) => {
                                  const next = [...conditions];
                                  next[index] = { ...condition, pattern: event.target.value };
                                  setConditions(next);
                                }}
                              />
                            </label>
                          ) : null}
                        </div>
                      )}
                      <div className="quality-condition-footer">
                        <button
                          type="button"
                          className="btn secondary"
                          data-testid={`quality-remove-condition-${index}`}
                          disabled={conditions.length === 1}
                          onClick={() => setConditions(conditions.filter((_, itemIndex) => itemIndex !== index))}
                        >
                          조건 삭제
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="row-actions">
                    <button type="button" className="btn secondary" data-testid="quality-add-condition" onClick={() => setConditions([...conditions, emptyCondition(columns[0] || "target")])}>
                      조건 추가
                    </button>
                    <button className="btn" data-testid="quality-save-rule" disabled={busy === "rule"}>{busy === "rule" ? "저장 중…" : "규칙 저장"}</button>
                    <button type="button" className="btn secondary" data-testid="quality-cancel-rule" onClick={() => resetForm()}>취소</button>
                  </div>
                </form>
              )}
              {legacyRules.length > 0 && (
                <div className="legacy-quality-rules" data-testid="legacy-quality-rules">
                  <h3>기존 미할당 규칙</h3>
                  <p className="muted">이전 규칙 중 아직 데이터셋에 연결되지 않은 항목입니다. 데이터셋에 연결하기 전에는 비활성 상태입니다.</p>
                  {legacyRules.map((rule) => renderRuleCard(rule, { legacy: true }))}
                </div>
              )}
              <div className="quality-check-history" data-testid="quality-check-history">
                <h3>검사 기록</h3>
                {checks.length === 0 ? (
                  <p className="muted">이 버전에서 실행한 품질 검사가 없습니다.</p>
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
                          <strong>검사 #{check.id}</strong>
                          <StatusBadge status={check.result} label={qualityResultLabel(check.result)} />
                          <small>{formatDate(check.created_at)}</small>
                        </summary>
                        <div className="quality-check-details">
                          {(check.details || []).map((detail, index) => {
                            const rule = detail.rule || {};
                            return (
                              <div key={`${check.id}-${index}`} className="quality-check-detail" data-testid={`quality-check-detail-${check.id}-${index}`}>
                                <div className="quality-check-detail-heading">
                                  <strong data-testid={`quality-check-rule-name-${check.id}-${index}`}>
                                    {detail.quality_rule_name || `규칙 #${detail.quality_rule_id ?? "—"}`}
                                  </strong>
                                  <small data-testid={`quality-check-condition-${check.id}-${index}`}>
                                    {summarizeCondition(rule)} · {detail.passed ? "통과 (PASS)" : "실패 (FAIL)"}
                                  </small>
                                </div>
                                <div className="muted">{detail.message || "—"}</div>
                                <small>
                                  심각도: {severityLabel(detail.severity || String(rule.severity || "fail"))}
                                  {" · "}
                                  학습 차단: {detail.block_training_on_fail ? "예" : "아니오"}
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
                  <span className="eyebrow">재현성</span>
                  <h2>데이터 분할 (Data splits)</h2>
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
                      setSplitStrategy("random");
                      setSplitTimeColumn("");
                    }}
                  >
                    {showSplitForm ? "취소" : "분할 만들기"}
                  </button>
                )}
              </div>
              {showSplitForm && canWrite && (
                <div className="form" data-testid="create-split-form">
                  <div className="form-grid">
                    <label>
                      이름 (Name)
                      <input
                        value={splitName}
                        onChange={(event) => setSplitName(event.target.value)}
                        data-testid="split-name"
                      />
                    </label>
                    <label>
                      <TermLabel ko="분할 방식" en="Split strategy" help={UI_HELP.dataSplit} />
                      <select
                        value={splitStrategy}
                        onChange={(event) => {
                          setSplitFormError("");
                          const next = event.target.value === "time" ? "time" : "random";
                          setSplitStrategy(next);
                          if (next === "random") setSplitTimeColumn("");
                        }}
                        data-testid="split-strategy"
                      >
                        <option value="random">무작위 (Random)</option>
                        <option value="time">시간 순서 (Time ordered)</option>
                      </select>
                    </label>
                    {splitStrategy === "time" ? (
                      <label>
                        <TermLabel ko="시간 기준 컬럼" en="Time column" help={UI_HELP.timeOrderedSplit} />
                        <select
                          value={splitTimeColumn}
                          onChange={(event) => {
                            setSplitFormError("");
                            setSplitTimeColumn(event.target.value);
                          }}
                          data-testid="split-time-column"
                          required
                        >
                          <option value="">시간 기준 컬럼 선택…</option>
                          {(selected?.columns?.length ? selected.columns : columns).map((column) => (
                            <option key={column} value={column}>
                              {column}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label>
                      학습 비율 (Train ratio)
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
                      검증 비율 (Validation ratio)
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
                      테스트 비율 (Test ratio)
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
                      난수 시드 (Random seed)
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
                  {splitStrategy === "time" ? (
                    <p className="form-hint" data-testid="split-time-seed-hint">
                      시간 순서대로 나누므로 미래 구간을 평가하는 데 적합합니다. 시간 순서 분할에서는 난수 시드가 행 순서를 섞지 않습니다.
                    </p>
                  ) : null}
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
                      {busy === "split" ? "저장 중…" : "분할 저장"}
                    </button>
                  </div>
                </div>
              )}
              {splits.length === 0 ? (
                <EmptyState title="저장된 데이터 분할이 없습니다" description="동일한 학습/검증/테스트 구성을 반복 사용하려면 데이터 분할을 저장하세요." />
              ) : (
                <div className="activity-list compact" data-testid="saved-splits-list">
                  {splits.map((split) => {
                    const strategyLabel =
                      (split.split_strategy || "random") === "time"
                        ? `시간 순서 (Time ordered) · ${split.time_column || "—"}`
                        : "무작위 (Random)";
                    return (
                      <div key={split.id} data-testid={`saved-split-${split.id}`}>
                        <div>
                          <strong>{split.name}</strong>
                          <small>
                            #{split.id} · {strategyLabel}
                            {(split.split_strategy || "random") === "random"
                              ? ` · 시드 ${split.random_seed}`
                              : ""}
                          </small>
                        </div>
                        <span>
                          {Math.round(split.train_ratio * 100)}/{Math.round(split.val_ratio * 100)}/{Math.round(split.test_ratio * 100)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">이력</span><h2>버전</h2></div></div>
            <div className="activity-list">{versions.map((version) => <button className="activity-button" key={version.id} onClick={() => setSelectedVersionId(version.id)}><div><strong>버전 {version.version}</strong><small>{version.original_filename} · {formatDate(version.created_at)}</small></div><span>{version.row_count.toLocaleString()}행</span></button>)}</div>
          </section>
        </>
      )}
    </div>
  );
}
