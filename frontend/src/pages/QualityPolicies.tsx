import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Endpoint } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
  metric,
} from "../components";
import { DetailSection } from "../lifecycleComponents";
import { useProject, userCanProject } from "../ProjectContext";

const METRICS = [
  "accuracy",
  "precision_macro",
  "recall_macro",
  "f1_macro",
  "mae",
  "rmse",
  "r2",
] as const;

const MAX_RULES = 10;

type QualityRule = {
  metric: string;
  target: string | null;
  comparison: "absolute" | "baseline_delta";
  warning_threshold: number;
  critical_threshold: number;
};

type QualityBaseline = {
  id: number;
  policy_id: number;
  quality_run_id: number;
  endpoint_id: number;
  model_version_id: number;
  metrics: Record<string, unknown>;
  matched_ground_truth_count: number;
  match_rate: number | null;
  created_at?: string | null;
};

type QualityPolicy = {
  id: number;
  project_id: number;
  endpoint_id: number;
  name: string;
  is_active: boolean;
  window_hours: number;
  evaluation_delay_hours: number;
  minimum_matched_samples: number;
  minimum_match_rate: number | null;
  primary_metric: string;
  warning_threshold: number;
  critical_threshold: number;
  consecutive_breaches: number;
  cooldown_hours: number;
  auto_retrain: boolean;
  revision: number;
  rule_logic: string;
  rules: QualityRule[];
  mode: "legacy" | "advanced";
  effective_rules: QualityRule[];
  baseline: QualityBaseline | null;
};

type QualityRun = {
  id: number;
  policy_id: number;
  endpoint_id: number;
  model_version_id: number | null;
  status: string;
  quality_status: string | null;
  matched_ground_truth_count: number;
  prediction_count: number;
  match_rate: number | null;
  finished_at?: string | null;
  policy_revision?: number | null;
};

type RuleForm = {
  metric: string;
  target: string;
  comparison: "absolute" | "baseline_delta";
  warning_threshold: string;
  critical_threshold: string;
};

type PolicyForm = {
  name: string;
  endpoint_id: string;
  window_hours: string;
  evaluation_delay_hours: string;
  minimum_matched_samples: string;
  minimum_match_rate: string;
  consecutive_breaches: string;
  cooldown_hours: string;
  auto_retrain: boolean;
  is_active: boolean;
  rule_logic: "any" | "all";
  rules: RuleForm[];
};

function emptyRule(): RuleForm {
  return {
    metric: "f1_macro",
    target: "",
    comparison: "absolute",
    warning_threshold: "0.7",
    critical_threshold: "0.5",
  };
}

function emptyForm(): PolicyForm {
  return {
    name: "",
    endpoint_id: "",
    window_hours: "24",
    evaluation_delay_hours: "0",
    minimum_matched_samples: "20",
    minimum_match_rate: "",
    consecutive_breaches: "2",
    cooldown_hours: "24",
    auto_retrain: true,
    is_active: true,
    rule_logic: "any",
    rules: [emptyRule()],
  };
}

function rulesFromPolicy(policy: QualityPolicy): RuleForm[] {
  const source = policy.effective_rules?.length
    ? policy.effective_rules
    : policy.rules?.length
      ? policy.rules
      : [
          {
            metric: policy.primary_metric,
            target: null,
            comparison: "absolute" as const,
            warning_threshold: policy.warning_threshold,
            critical_threshold: policy.critical_threshold,
          },
        ];
  return source.map((rule) => ({
    metric: rule.metric,
    target: rule.target || "",
    comparison: rule.comparison === "baseline_delta" ? "baseline_delta" : "absolute",
    warning_threshold: String(rule.warning_threshold),
    critical_threshold: String(rule.critical_threshold),
  }));
}

function formFromPolicy(policy: QualityPolicy): PolicyForm {
  return {
    name: policy.name,
    endpoint_id: String(policy.endpoint_id),
    window_hours: String(policy.window_hours),
    evaluation_delay_hours: String(policy.evaluation_delay_hours ?? 0),
    minimum_matched_samples: String(policy.minimum_matched_samples),
    minimum_match_rate:
      policy.minimum_match_rate == null ? "" : String(policy.minimum_match_rate),
    consecutive_breaches: String(policy.consecutive_breaches),
    cooldown_hours: String(policy.cooldown_hours),
    auto_retrain: policy.auto_retrain,
    is_active: policy.is_active,
    rule_logic: policy.rule_logic === "all" ? "all" : "any",
    rules: rulesFromPolicy(policy),
  };
}

function parseOptionalRate(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number(trimmed);
}

function buildRulesPayload(rules: RuleForm[]) {
  return rules.map((rule) => ({
    metric: rule.metric,
    target: rule.target.trim() ? rule.target.trim() : null,
    comparison: rule.comparison,
    warning_threshold: Number(rule.warning_threshold),
    critical_threshold: Number(rule.critical_threshold),
  }));
}

function endpointLabel(endpoints: Endpoint[], endpointId: number): string {
  const match = endpoints.find((row) => row.id === endpointId);
  return match ? match.name : `Endpoint #${endpointId}`;
}

function isBaselineEligible(
  run: QualityRun,
  policy: QualityPolicy,
  endpoints: Endpoint[],
): boolean {
  // Cross-policy bootstrap: a baseline_delta policy cannot produce its own ok run
  // until a baseline exists, so candidates may come from any same-endpoint policy.
  if (run.endpoint_id !== policy.endpoint_id) return false;
  if (run.status !== "succeeded") return false;
  if (run.quality_status !== "ok") return false;
  const endpoint = endpoints.find((row) => row.id === policy.endpoint_id);
  const currentModelId = endpoint?.model_version_id ?? null;
  if (currentModelId == null || run.model_version_id !== currentModelId) return false;
  if (run.matched_ground_truth_count < policy.minimum_matched_samples) return false;
  if (policy.minimum_match_rate != null) {
    const rate = run.match_rate ?? 0;
    if (rate < policy.minimum_match_rate) return false;
  }
  return true;
}

/** Preserve legacy API shape when the edited policy is still a single absolute rule. */
function shouldSubmitAsLegacy(
  policyMode: "legacy" | "advanced" | undefined,
  rules: RuleForm[],
): boolean {
  if (policyMode === "advanced") {
    // Already advanced — keep sending rules unless reduced back to one absolute aggregate rule
    // while intentionally clearing advanced mode. Prefer staying advanced once configured.
    return false;
  }
  if (rules.length !== 1) return false;
  const rule = rules[0];
  if (rule.comparison !== "absolute") return false;
  if (rule.target.trim() !== "") return false;
  return true;
}

export default function QualityPolicies() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const canWrite = userCanProject(
    user,
    selectedProject,
    "DATA_SCIENTIST",
    "ML_ENGINEER",
    "PROJECT_ADMIN",
  );

  const [policies, setPolicies] = useState<QualityPolicy[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [baselineCandidates, setBaselineCandidates] = useState<QualityRun[]>([]);
  const [baselineTotal, setBaselineTotal] = useState(0);
  const [baselineSkip, setBaselineSkip] = useState(0);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<PolicyForm>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [targetOptions, setTargetOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const BASELINE_PAGE_SIZE = 10;

  const selectedPolicy = useMemo(
    () => policies.find((row) => row.id === selectedId) || null,
    [policies, selectedId],
  );

  const needsBaseline = form.rules.some((rule) => rule.comparison === "baseline_delta");

  const load = () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    Promise.all([
      api<QualityPolicy[]>(`/projects/${projectId}/model-quality/policies`),
      api<Endpoint[]>(`/projects/${projectId}/endpoints`),
    ])
      .then(([policyRows, endpointRows]) => {
        setPolicies(policyRows);
        setEndpoints(endpointRows);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Quality policies could not be loaded."),
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selectedPolicy) {
      setBaselineCandidates([]);
      setBaselineTotal(0);
      return;
    }
    const endpoint = endpoints.find((row) => row.id === selectedPolicy.endpoint_id);
    const modelVersionId = endpoint?.model_version_id;
    if (modelVersionId == null) {
      setBaselineCandidates([]);
      setBaselineTotal(0);
      return;
    }
    let cancelled = false;
    setBaselineLoading(true);
    const params = new URLSearchParams({
      paged: "true",
      endpoint_id: String(selectedPolicy.endpoint_id),
      model_version_id: String(modelVersionId),
      quality_status: "ok",
      status: "succeeded",
      skip: String(baselineSkip),
      limit: String(BASELINE_PAGE_SIZE),
    });
    api<{ items: QualityRun[]; total: number }>(
      `/projects/${projectId}/model-quality/runs?${params.toString()}`,
    )
      .then((page) => {
        if (cancelled) return;
        const items = Array.isArray(page.items) ? page.items : [];
        setBaselineCandidates(
          items.filter((run) => isBaselineEligible(run, selectedPolicy, endpoints)),
        );
        setBaselineTotal(Number(page.total || 0));
      })
      .catch(() => {
        if (!cancelled) {
          setBaselineCandidates([]);
          setBaselineTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setBaselineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedPolicy, endpoints, baselineSkip]);

  useEffect(() => {
    setBaselineSkip(0);
  }, [selectedId]);

  useEffect(() => {
    if (!projectId || !form.endpoint_id) {
      setTargetOptions([]);
      return;
    }
    let cancelled = false;
    api<Endpoint>(`/projects/${projectId}/endpoints/${form.endpoint_id}`)
      .then((endpoint) => {
        if (cancelled) return;
        setTargetOptions(Array.isArray(endpoint.output_targets) ? endpoint.output_targets : []);
      })
      .catch(() => {
        if (!cancelled) setTargetOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.endpoint_id, projectId]);

  const startCreate = () => {
    setEditingId(null);
    setSelectedId(null);
    setForm(emptyForm());
    setShowForm(true);
    setSuccess("");
    setError("");
  };

  const startEdit = (policy: QualityPolicy) => {
    setEditingId(policy.id);
    setSelectedId(policy.id);
    setForm(formFromPolicy(policy));
    setShowForm(true);
    setSuccess("");
    setError("");
  };

  const updateRule = (index: number, patch: Partial<RuleForm>) => {
    setForm((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  };

  const addRule = () => {
    setForm((prev) => {
      if (prev.rules.length >= MAX_RULES) return prev;
      return { ...prev, rules: [...prev.rules, emptyRule()] };
    });
  };

  const removeRule = (index: number) => {
    setForm((prev) => ({
      ...prev,
      rules: prev.rules.length <= 1 ? prev.rules : prev.rules.filter((_, i) => i !== index),
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !canWrite) return;
    setBusy(true);
    setError("");
    setSuccess("");
    const editingPolicy = editingId != null ? policies.find((row) => row.id === editingId) : null;
    const useLegacy = shouldSubmitAsLegacy(editingPolicy?.mode, form.rules);
    const rulesPayload = buildRulesPayload(form.rules);
    const firstRule = rulesPayload[0];
    const basePayload: Record<string, unknown> = {
      name: form.name.trim(),
      endpoint_id: Number(form.endpoint_id),
      window_hours: Number(form.window_hours),
      evaluation_delay_hours: Number(form.evaluation_delay_hours),
      minimum_matched_samples: Number(form.minimum_matched_samples),
      minimum_match_rate: parseOptionalRate(form.minimum_match_rate),
      consecutive_breaches: Number(form.consecutive_breaches),
      cooldown_hours: Number(form.cooldown_hours),
      auto_retrain: form.auto_retrain,
      is_active: form.is_active,
      rule_logic: form.rule_logic,
    };
    const payload: Record<string, unknown> = useLegacy
      ? {
          ...basePayload,
          primary_metric: firstRule?.metric || form.rules[0]?.metric || "f1_macro",
          warning_threshold: firstRule?.warning_threshold ?? Number(form.rules[0]?.warning_threshold),
          critical_threshold:
            firstRule?.critical_threshold ?? Number(form.rules[0]?.critical_threshold),
        }
      : {
          ...basePayload,
          rules: rulesPayload,
          primary_metric: firstRule?.metric,
          warning_threshold: firstRule?.warning_threshold,
          critical_threshold: firstRule?.critical_threshold,
        };
    try {
      if (editingId == null) {
        const created = await api<QualityPolicy>(`/projects/${projectId}/model-quality/policies`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setSuccess(`Created policy “${created.name}” (revision ${created.revision}).`);
        setSelectedId(created.id);
        setEditingId(created.id);
        setForm(formFromPolicy(created));
      } else {
        const updateBody = { ...payload };
        delete updateBody.endpoint_id;
        // Explicitly clear advanced rules when returning to legacy via PATCH.
        const patchBody = useLegacy ? { ...updateBody, rules: [] } : updateBody;
        const updated = await api<QualityPolicy>(
          `/projects/${projectId}/model-quality/policies/${editingId}`,
          { method: "PATCH", body: JSON.stringify(patchBody) },
        );
        setSuccess(`Updated policy “${updated.name}” (revision ${updated.revision}).`);
        setForm(formFromPolicy(updated));
      }
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Policy could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (policy: QualityPolicy) => {
    if (!projectId || !canWrite) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api<QualityPolicy>(
        `/projects/${projectId}/model-quality/policies/${policy.id}`,
        { method: "PATCH", body: JSON.stringify({ is_active: !policy.is_active }) },
      );
      setSuccess(
        updated.is_active
          ? `Enabled “${updated.name}”.`
          : `Disabled “${updated.name}”.`,
      );
      if (editingId === policy.id) {
        setForm((prev) => ({ ...prev, is_active: updated.is_active }));
      }
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Policy could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const setBaseline = async (runId: number) => {
    if (!projectId || !canWrite || !selectedPolicy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/model-quality/policies/${selectedPolicy.id}/baseline`, {
        method: "POST",
        body: JSON.stringify({ quality_run_id: runId }),
      });
      setSuccess(`Baseline set to quality run #${runId}.`);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Baseline could not be set.");
    } finally {
      setBusy(false);
    }
  };

  const clearBaseline = async () => {
    if (!projectId || !canWrite || !selectedPolicy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/model-quality/policies/${selectedPolicy.id}/baseline`, {
        method: "DELETE",
      });
      setSuccess("Baseline cleared.");
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Baseline could not be cleared.");
    } finally {
      setBusy(false);
    }
  };

  const eligibleRuns = baselineCandidates;

  const policyNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const policy of policies) {
      map.set(policy.id, policy.name);
    }
    return map;
  }, [policies]);

  const showBaselineWarning =
    needsBaseline &&
    (editingId == null || !selectedPolicy?.baseline);

  return (
    <div className="page-stack" data-testid="quality-policies-page">
      <PageHeader
        title="Quality Policies"
        description="Configure production quality evaluation rules, baselines, and closed-loop retrain triggers. Automation still stops at CANDIDATE."
        actions={
          canWrite ? (
            <button type="button" className="btn" onClick={startCreate} data-testid="create-policy-btn">
              New policy
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />

      {loading ? (
        <Loading label="Loading quality policies" />
      ) : (
        <>
          <DetailSection eyebrow="Policies" title="Configured policies" testId="quality-policy-list">
            {policies.length === 0 ? (
              <EmptyState
                title="No quality policies"
                description="Create a policy to evaluate prediction vs ground-truth with absolute or baseline-delta rules."
                action={
                  canWrite ? (
                    <button type="button" className="btn" onClick={startCreate}>
                      Create policy
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Endpoint</th>
                      <th>Revision</th>
                      <th>Mode</th>
                      <th>Active</th>
                      <th>Rules</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((policy) => (
                      <tr
                        key={policy.id}
                        data-testid={`policy-row-${policy.id}`}
                        className={selectedId === policy.id ? "is-selected" : undefined}
                      >
                        <td>
                          <button
                            type="button"
                            className="btn link"
                            data-testid={`select-policy-${policy.id}`}
                            onClick={() => {
                              setSelectedId(policy.id);
                              setShowForm(false);
                            }}
                          >
                            {policy.name}
                          </button>
                        </td>
                        <td>{endpointLabel(endpoints, policy.endpoint_id)}</td>
                        <td>{policy.revision}</td>
                        <td>
                          <StatusBadge status={policy.mode} />
                        </td>
                        <td>{policy.is_active ? "Yes" : "No"}</td>
                        <td>{policy.effective_rules?.length ?? policy.rules?.length ?? 0}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => startEdit(policy)}
                              data-testid={`edit-policy-${policy.id}`}
                            >
                              {canWrite ? "Edit" : "View"}
                            </button>
                            {canWrite ? (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={busy}
                                onClick={() => toggleActive(policy)}
                                data-testid={`toggle-policy-${policy.id}`}
                              >
                                {policy.is_active ? "Disable" : "Enable"}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="row-actions">
              <Link to={`/projects/${projectId}/monitoring`}>Open Monitoring</Link>
            </div>
          </DetailSection>

          {showForm ? (
            <DetailSection
              eyebrow={editingId == null ? "Create" : "Edit"}
              title={editingId == null ? "New quality policy" : `Edit policy #${editingId}`}
              testId="quality-policy-form-section"
              actions={
                editingId != null ? (
                  <span className="muted" data-testid="policy-revision">
                    Revision {policies.find((row) => row.id === editingId)?.revision ?? "—"}
                  </span>
                ) : undefined
              }
            >
              <form className="stack-gap" onSubmit={submit} data-testid="quality-policy-form">
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      required
                      value={form.name}
                      onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                      disabled={!canWrite}
                      data-testid="policy-name"
                    />
                  </label>
                  <label>
                    Endpoint
                    <select
                      required
                      value={form.endpoint_id}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, endpoint_id: event.target.value }))
                      }
                      disabled={!canWrite || editingId != null}
                      data-testid="policy-endpoint"
                    >
                      <option value="">Select endpoint</option>
                      {endpoints.map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>
                          {endpoint.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Window hours
                    <input
                      type="number"
                      min={1}
                      required
                      value={form.window_hours}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, window_hours: event.target.value }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-window-hours"
                    />
                  </label>
                  <label>
                    Evaluation delay hours
                    <input
                      type="number"
                      min={0}
                      required
                      value={form.evaluation_delay_hours}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          evaluation_delay_hours: event.target.value,
                        }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-evaluation-delay"
                    />
                  </label>
                  <label>
                    Minimum matched samples
                    <input
                      type="number"
                      min={1}
                      required
                      value={form.minimum_matched_samples}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          minimum_matched_samples: event.target.value,
                        }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-min-matched"
                    />
                  </label>
                  <label>
                    Minimum match rate
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step="0.01"
                      value={form.minimum_match_rate}
                      placeholder="optional 0–1"
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          minimum_match_rate: event.target.value,
                        }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-min-match-rate"
                    />
                  </label>
                  <label>
                    Consecutive breaches
                    <input
                      type="number"
                      min={1}
                      required
                      value={form.consecutive_breaches}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          consecutive_breaches: event.target.value,
                        }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-consecutive-breaches"
                    />
                  </label>
                  <label>
                    Cooldown hours
                    <input
                      type="number"
                      min={0}
                      required
                      value={form.cooldown_hours}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, cooldown_hours: event.target.value }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-cooldown"
                    />
                  </label>
                  <label>
                    Rule logic
                    <select
                      value={form.rule_logic}
                      onChange={(event) =>
                        setForm((prev) => ({
                          ...prev,
                          rule_logic: event.target.value === "all" ? "all" : "any",
                        }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-rule-logic"
                    >
                      <option value="any">ANY (breach if any rule fails)</option>
                      <option value="all">ALL (breach only if all rules fail)</option>
                    </select>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.auto_retrain}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, auto_retrain: event.target.checked }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-auto-retrain"
                    />
                    Auto-retrain on critical breach
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.is_active}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, is_active: event.target.checked }))
                      }
                      disabled={!canWrite}
                      data-testid="policy-is-active"
                    />
                    Active
                  </label>
                </div>

                <div className="stack-gap">
                  <div className="row-actions">
                    <strong>Rules</strong>
                    {canWrite ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={addRule}
                        disabled={form.rules.length >= MAX_RULES}
                        data-testid="add-rule"
                      >
                        Add rule
                      </button>
                    ) : null}
                  </div>
                  {form.rules.map((rule, index) => (
                    <div
                      className="panel nested-panel"
                      key={`rule-${index}`}
                      data-testid={`rule-row-${index}`}
                    >
                      <div className="form-grid">
                        <label>
                          Metric
                          <select
                            value={rule.metric}
                            onChange={(event) => updateRule(index, { metric: event.target.value })}
                            disabled={!canWrite}
                            data-testid={`rule-metric-${index}`}
                          >
                            {METRICS.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Target
                          <select
                            value={rule.target}
                            onChange={(event) => updateRule(index, { target: event.target.value })}
                            disabled={!canWrite}
                            data-testid={`rule-target-${index}`}
                          >
                            <option value="">Overall (optional)</option>
                            {targetOptions.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Comparison
                          <select
                            value={rule.comparison}
                            onChange={(event) =>
                              updateRule(index, {
                                comparison:
                                  event.target.value === "baseline_delta"
                                    ? "baseline_delta"
                                    : "absolute",
                              })
                            }
                            disabled={!canWrite}
                            data-testid={`rule-comparison-${index}`}
                          >
                            <option value="absolute">absolute</option>
                            <option value="baseline_delta">baseline_delta</option>
                          </select>
                        </label>
                        <label>
                          Warning threshold
                          <input
                            type="number"
                            step="any"
                            required
                            value={rule.warning_threshold}
                            onChange={(event) =>
                              updateRule(index, { warning_threshold: event.target.value })
                            }
                            disabled={!canWrite}
                            data-testid={`rule-warning-${index}`}
                          />
                        </label>
                        <label>
                          Critical threshold
                          <input
                            type="number"
                            step="any"
                            required
                            value={rule.critical_threshold}
                            onChange={(event) =>
                              updateRule(index, { critical_threshold: event.target.value })
                            }
                            disabled={!canWrite}
                            data-testid={`rule-critical-${index}`}
                          />
                        </label>
                      </div>
                      {rule.comparison === "baseline_delta" ? (
                        <p className="muted" data-testid={`baseline-delta-help-${index}`}>
                          Positive delta means the production metric became worse than the pinned
                          baseline.
                        </p>
                      ) : null}
                      {canWrite && form.rules.length > 1 ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => removeRule(index)}
                          data-testid={`remove-rule-${index}`}
                        >
                          Remove rule
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {showBaselineWarning ? (
                  <div
                    className="notice notice-warning"
                    role="status"
                    data-testid="baseline-required-warning"
                  >
                    <p className="notice-message">
                      Baseline required — at least one rule uses baseline_delta and no baseline is
                      pinned yet.
                    </p>
                  </div>
                ) : null}

                {canWrite ? (
                  <div className="row-actions">
                    <button type="submit" className="btn" disabled={busy} data-testid="save-policy">
                      {editingId == null ? "Create policy" : "Save changes"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowForm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </form>
            </DetailSection>
          ) : null}

          {selectedPolicy ? (
            <DetailSection
              eyebrow="Baseline"
              title={`Baseline for ${selectedPolicy.name}`}
              testId="baseline-section"
            >
              {selectedPolicy.baseline ? (
                <dl className="key-values" data-testid="baseline-summary">
                  <div>
                    <dt>Quality run</dt>
                    <dd>#{selectedPolicy.baseline.quality_run_id}</dd>
                  </div>
                  <div>
                    <dt>Model version</dt>
                    <dd>#{selectedPolicy.baseline.model_version_id}</dd>
                  </div>
                  <div>
                    <dt>Matched samples</dt>
                    <dd>{selectedPolicy.baseline.matched_ground_truth_count}</dd>
                  </div>
                  <div>
                    <dt>Match rate</dt>
                    <dd>
                      {selectedPolicy.baseline.match_rate == null
                        ? "—"
                        : `${metric(selectedPolicy.baseline.match_rate * 100, 1)}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>Pinned at</dt>
                    <dd>{formatDate(selectedPolicy.baseline.created_at)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted">No baseline pinned for this policy.</p>
              )}
              {canWrite ? (
                <div className="row-actions">
                  {selectedPolicy.baseline ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={clearBaseline}
                      data-testid="clear-baseline-btn"
                    >
                      Clear baseline
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="table-wrap" style={{ marginTop: "1rem" }}>
                <table data-testid="baseline-candidate-table">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Source policy</th>
                      <th>Status</th>
                      <th>Matched</th>
                      <th>Finished</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {baselineLoading ? (
                      <tr>
                        <td colSpan={6}><Loading label="Loading baseline candidates" /></td>
                      </tr>
                    ) : null}
                    {!baselineLoading
                      ? eligibleRuns.map((run) => (
                      <tr key={run.id} data-testid={`baseline-run-${run.id}`}>
                        <td>#{run.id}</td>
                        <td data-testid={`baseline-run-source-${run.id}`}>
                          {policyNameById.get(run.policy_id) || `Policy #${run.policy_id}`}
                          <span className="muted"> #{run.policy_id}</span>
                        </td>
                        <td>
                          <StatusBadge status={run.quality_status || run.status} />
                        </td>
                        <td>{run.matched_ground_truth_count}</td>
                        <td>{run.finished_at ? formatDate(run.finished_at) : "—"}</td>
                        <td>
                          {canWrite ? (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={busy}
                              onClick={() => setBaseline(run.id)}
                              data-testid="set-baseline-btn"
                            >
                              Use as baseline
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))
                      : null}
                  </tbody>
                </table>
              </div>
              <div className="row-actions" data-testid="baseline-candidate-pagination">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={baselineSkip <= 0 || baselineLoading}
                  onClick={() => setBaselineSkip((prev) => Math.max(0, prev - BASELINE_PAGE_SIZE))}
                  data-testid="baseline-candidates-prev"
                >
                  Previous
                </button>
                <span className="muted">
                  {baselineTotal === 0
                    ? "0 candidates"
                    : `${baselineSkip + 1}–${Math.min(baselineSkip + BASELINE_PAGE_SIZE, baselineTotal)} of ${baselineTotal}`}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={baselineSkip + BASELINE_PAGE_SIZE >= baselineTotal || baselineLoading}
                  onClick={() => setBaselineSkip((prev) => prev + BASELINE_PAGE_SIZE)}
                  data-testid="baseline-candidates-next"
                >
                  Next
                </button>
              </div>
              {!baselineLoading && eligibleRuns.length === 0 ? (
                <p className="muted">
                  Eligible baseline runs must share this policy&apos;s endpoint and current model,
                  be succeeded with quality_status=ok, and meet sample / match-rate minimums.
                  Runs from other policies on the same endpoint are allowed for first-time baseline
                  bootstrap.
                </p>
              ) : null}
            </DetailSection>
          ) : null}
        </>
      )}
    </div>
  );
}
