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
import { operationalStatusLabel } from "../uiTerminology";

const METRICS = [
  "accuracy",
  "precision_macro",
  "recall_macro",
  "f1_macro",
  "mae",
  "rmse",
  "r2",
] as const;

const METRIC_LABELS: Record<(typeof METRICS)[number], string> = {
  accuracy: "정확도 (Accuracy)",
  precision_macro: "정밀도 평균 (Precision Macro)",
  recall_macro: "재현율 평균 (Recall Macro)",
  f1_macro: "F1 점수 평균 (F1 Macro)",
  mae: "평균 절대 오차 (MAE)",
  rmse: "평균 제곱근 오차 (RMSE)",
  r2: "설명력 (R²)",
};

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
  return match ? match.name : `배포 #${endpointId}`;
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
        setError(reason instanceof Error ? reason.message : "품질 정책을 불러오지 못했습니다."),
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
        setSuccess(`“${created.name}” 품질 정책을 생성했습니다. (수정 번호 ${created.revision})`);
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
        setSuccess(`“${updated.name}” 품질 정책을 수정했습니다. (수정 번호 ${updated.revision})`);
        setForm(formFromPolicy(updated));
      }
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "품질 정책을 저장하지 못했습니다.");
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
          ? `“${updated.name}” 품질 정책을 활성화했습니다.`
          : `“${updated.name}” 품질 정책을 비활성화했습니다.`,
      );
      if (editingId === policy.id) {
        setForm((prev) => ({ ...prev, is_active: updated.is_active }));
      }
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "품질 정책을 변경하지 못했습니다.");
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
      setSuccess(`품질 평가 #${runId}을(를) 기준값으로 지정했습니다.`);
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "기준값을 지정하지 못했습니다.");
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
      setSuccess("기준값 지정을 해제했습니다.");
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "기준값 지정을 해제하지 못했습니다.");
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
    <div className="page-stack ops-page quality-policies-page" data-testid="quality-policies-page">
      <PageHeader
        title="품질 정책"
        description="운영 모델의 품질 평가 규칙과 기준값, 재학습 요청 조건을 관리합니다. 자동 재학습은 후보(CANDIDATE) 모델 생성까지만 진행됩니다."
        actions={
          canWrite ? (
            <button type="button" className="btn" onClick={startCreate} data-testid="create-policy-btn">
              새 정책
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />

      {loading ? (
        <Loading label="품질 정책 불러오는 중" />
      ) : (
        <>
          <div
            className={[
              "quality-policies-layout",
              policies.length === 0 && !showForm ? "is-empty" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
          <DetailSection eyebrow="정책 목록" title="등록된 품질 정책" testId="quality-policy-list">
            {policies.length === 0 ? (
              <EmptyState
                title="등록된 품질 정책이 없습니다"
                description="모델 예측값과 실제 정답을 비교하는 기준값·절대값 규칙을 설정해 보세요."
                action={
                  canWrite ? (
                    <button type="button" className="btn" onClick={startCreate}>
                      정책 만들기
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="table-wrap catalog-table">
                <table>
                  <thead>
                    <tr>
                      <th>정책 이름</th>
                      <th>배포</th>
                      <th>수정 번호</th>
                      <th>설정 방식</th>
                      <th>활성 상태</th>
                      <th>규칙 수</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((policy) => (
                      <tr
                        key={policy.id}
                        data-testid={`policy-row-${policy.id}`}
                        className={[
                          selectedId === policy.id ? "is-selected" : "",
                          policy.is_active ? "" : "is-inactive",
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined}
                      >
                        <td>
                          <button
                            type="button"
                            className="btn link catalog-primary-link"
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
                        <td>
                          <span className="version-chip">r{policy.revision}</span>
                        </td>
                        <td>
                          <StatusBadge status={policy.mode} label={operationalStatusLabel(policy.mode)} />
                        </td>
                        <td>{policy.is_active ? "예" : "아니요"}</td>
                        <td className="tabular-num">
                          {policy.effective_rules?.length ?? policy.rules?.length ?? 0}
                        </td>
                        <td>
                          <div className="row-actions catalog-row-actions">
                            <button
                              type="button"
                              className="btn secondary"
                              onClick={() => startEdit(policy)}
                              data-testid={`edit-policy-${policy.id}`}
                            >
                              {canWrite ? "수정" : "보기"}
                            </button>
                            {canWrite ? (
                              <button
                                type="button"
                                className="btn secondary"
                                disabled={busy}
                                onClick={() => toggleActive(policy)}
                                data-testid={`toggle-policy-${policy.id}`}
                              >
                                {policy.is_active ? "비활성화" : "활성화"}
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
              <Link to={`/projects/${projectId}/monitoring`}>모니터링으로 이동</Link>
            </div>
          </DetailSection>

          <div className="quality-policies-detail">

          {showForm ? (
            <DetailSection
              eyebrow={editingId == null ? "새 정책" : "정책 수정"}
              title={editingId == null ? "새 품질 정책" : `품질 정책 #${editingId} 수정`}
              testId="quality-policy-form-section"
              actions={
                editingId != null ? (
                  <span className="muted" data-testid="policy-revision">
                    수정 번호 {policies.find((row) => row.id === editingId)?.revision ?? "—"}
                  </span>
                ) : undefined
              }
            >
              <form className="stack-gap" onSubmit={submit} data-testid="quality-policy-form">
                <div className="form-grid">
                  <label>
                    정책 이름
                    <input
                      required
                      value={form.name}
                      onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                      disabled={!canWrite}
                      data-testid="policy-name"
                    />
                  </label>
                  <label>
                    모델 배포
                    <select
                      required
                      value={form.endpoint_id}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, endpoint_id: event.target.value }))
                      }
                      disabled={!canWrite || editingId != null}
                      data-testid="policy-endpoint"
                    >
                      <option value="">배포를 선택하세요</option>
                      {endpoints.map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>
                          {endpoint.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    평가 기간(시간)
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
                    평가 지연(시간)
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
                    최소 정답 연결 건수
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
                    최소 정답 연결 비율
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step="0.01"
                      value={form.minimum_match_rate}
                      placeholder="선택 입력 (0~1)"
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
                    연속 기준 위반 횟수
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
                    재알림 대기 시간(시간)
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
                    규칙 결합 방식
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
                      <option value="any">하나라도 위반하면 판정 (ANY)</option>
                      <option value="all">모두 위반해야 판정 (ALL)</option>
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
                    심각 기준 위반 시 자동 재학습 요청
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
                    정책 활성화
                  </label>
                </div>

                <div className="stack-gap">
                  <div className="row-actions">
                    <strong>평가 규칙</strong>
                    {canWrite ? (
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={addRule}
                        disabled={form.rules.length >= MAX_RULES}
                        data-testid="add-rule"
                      >
                        규칙 추가
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
                          평가 지표
                          <select
                            value={rule.metric}
                            onChange={(event) => updateRule(index, { metric: event.target.value })}
                            disabled={!canWrite}
                            data-testid={`rule-metric-${index}`}
                          >
                            {METRICS.map((name) => (
                              <option key={name} value={name}>
                                {METRIC_LABELS[name]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          예측 대상
                          <select
                            value={rule.target}
                            onChange={(event) => updateRule(index, { target: event.target.value })}
                            disabled={!canWrite}
                            data-testid={`rule-target-${index}`}
                          >
                            <option value="">전체 (선택 입력)</option>
                            {targetOptions.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          비교 방식
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
                            <option value="absolute">절대 기준값 (absolute)</option>
                            <option value="baseline_delta">기준값 대비 변화 (baseline_delta)</option>
                          </select>
                        </label>
                        <label>
                          경고 기준값
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
                          심각 기준값
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
                          기준값 대비 변화가 양수이면 운영 모델의 품질이 지정한 기준값보다 나빠진 것입니다.
                        </p>
                      ) : null}
                      {canWrite && form.rules.length > 1 ? (
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => removeRule(index)}
                          data-testid={`remove-rule-${index}`}
                        >
                          규칙 삭제
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
                      기준값 지정 필요 — 기준값 대비 변화(baseline_delta) 규칙이 있지만 기준 평가가 아직 지정되지 않았습니다.
                    </p>
                  </div>
                ) : null}

                {canWrite ? (
                  <div className="row-actions">
                    <button type="submit" className="btn" disabled={busy} data-testid="save-policy">
                      {editingId == null ? "정책 만들기" : "변경 사항 저장"}
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setShowForm(false)}
                    >
                      취소
                    </button>
                  </div>
                ) : null}
              </form>
            </DetailSection>
          ) : null}

          {selectedPolicy ? (
            <DetailSection
              eyebrow="기준값"
              title={`${selectedPolicy.name}의 품질 기준값`}
              testId="baseline-section"
            >
              {selectedPolicy.baseline ? (
                <dl className="key-values" data-testid="baseline-summary">
                  <div>
                    <dt>품질 평가</dt>
                    <dd>#{selectedPolicy.baseline.quality_run_id}</dd>
                  </div>
                  <div>
                    <dt>모델 버전</dt>
                    <dd>#{selectedPolicy.baseline.model_version_id}</dd>
                  </div>
                  <div>
                    <dt>정답 연결 건수</dt>
                    <dd>{selectedPolicy.baseline.matched_ground_truth_count}</dd>
                  </div>
                  <div>
                    <dt>정답 연결 비율</dt>
                    <dd>
                      {selectedPolicy.baseline.match_rate == null
                        ? "—"
                        : `${metric(selectedPolicy.baseline.match_rate * 100, 1)}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>기준값 지정 시각</dt>
                    <dd>{formatDate(selectedPolicy.baseline.created_at)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted">이 정책에 지정된 기준값이 없습니다.</p>
              )}
              {canWrite ? (
                <div className="row-actions">
                  {selectedPolicy.baseline ? (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={clearBaseline}
                      data-testid="clear-baseline-btn"
                    >
                      기준값 지정 해제
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="table-wrap catalog-table" style={{ marginTop: "1rem" }}>
                <table data-testid="baseline-candidate-table">
                  <thead>
                    <tr>
                      <th>평가 번호</th>
                      <th>원본 정책</th>
                      <th>상태</th>
                      <th>정답 연결</th>
                      <th>완료 시각</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {baselineLoading ? (
                      <tr>
                        <td colSpan={6}><Loading label="기준값 후보 불러오는 중" /></td>
                      </tr>
                    ) : null}
                    {!baselineLoading
                      ? eligibleRuns.map((run) => (
                      <tr key={run.id} data-testid={`baseline-run-${run.id}`}>
                        <td>#{run.id}</td>
                        <td data-testid={`baseline-run-source-${run.id}`}>
                          {policyNameById.get(run.policy_id) || `정책 #${run.policy_id}`}
                          <span className="muted"> #{run.policy_id}</span>
                        </td>
                        <td>
                          <StatusBadge status={run.quality_status || run.status} label={operationalStatusLabel(run.quality_status || run.status)} />
                        </td>
                        <td>{run.matched_ground_truth_count}</td>
                        <td>{run.finished_at ? formatDate(run.finished_at) : "—"}</td>
                        <td>
                          {canWrite ? (
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              onClick={() => setBaseline(run.id)}
                              data-testid="set-baseline-btn"
                            >
                              기준값으로 지정
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
                  className="btn secondary"
                  disabled={baselineSkip <= 0 || baselineLoading}
                  onClick={() => setBaselineSkip((prev) => Math.max(0, prev - BASELINE_PAGE_SIZE))}
                  data-testid="baseline-candidates-prev"
                >
                  이전
                </button>
                <span className="muted">
                  {baselineTotal === 0
                    ? "후보 0건"
                    : `${baselineTotal}건 중 ${baselineSkip + 1}–${Math.min(baselineSkip + BASELINE_PAGE_SIZE, baselineTotal)}건`}
                </span>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={baselineSkip + BASELINE_PAGE_SIZE >= baselineTotal || baselineLoading}
                  onClick={() => setBaselineSkip((prev) => prev + BASELINE_PAGE_SIZE)}
                  data-testid="baseline-candidates-next"
                >
                  다음
                </button>
              </div>
              {!baselineLoading && eligibleRuns.length === 0 ? (
                <p className="muted">
                  기준값 후보는 이 정책과 같은 배포 및 현재 모델을 사용하고, 품질 평가가 정상(ok)으로 완료되어야 하며,
                  최소 정답 연결 건수·비율을 충족해야 합니다. 기준값을 처음 지정할 때는 같은 배포의 다른 정책에서
                  실행한 정상 평가도 사용할 수 있습니다.
                </p>
              ) : null}
            </DetailSection>
          ) : null}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
