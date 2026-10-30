import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ModelVersion, type Run } from "../api";
import { useAuth } from "../AuthContext";
import { EmptyState, ErrorNotice, HelpTip, Loading, PageHeader, StatusBadge, SuccessNotice, formatDate } from "../components";
import { MODEL_LIFECYCLES, runDisplayName, suggestModelNameFromRun } from "../lifecycleHelpers";
import { formatModelPrimaryMetricKo, modelGateStatusKo, modelLifecycleLabelKo } from "../modelRegistryLabels";
import { userCanProject, useProject } from "../ProjectContext";

export default function Registry() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [modelName, setModelName] = useState("");
  const [showRegister, setShowRegister] = useState(false);
  const [lifecycle, setLifecycle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    const [m, r] = await Promise.all([
      api<ModelVersion[]>(`/projects/${projectId}/models${lifecycle ? `?lifecycle=${lifecycle}` : ""}`),
      api<Run[]>(`/projects/${projectId}/experiments/runs`),
    ]);
    setModels(m);
    setRuns(r);
    setRunId((current) => current || r[0]?.run_id || "");
    setLoading(false);
  }, [lifecycle, projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "모델 목록을 불러오지 못했습니다.");
    });
  }, [refresh]);

  useEffect(() => {
    if (!showRegister || modelName.trim()) return;
    const selected = runs.find((run) => run.run_id === runId);
    if (selected) setModelName(suggestModelNameFromRun(selected));
  }, [modelName, runId, runs, showRegister]);

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMsg("");
    try {
      const res = await api<ModelVersion>(`/projects/${projectId}/models/register`, {
        method: "POST",
        body: JSON.stringify({
          run_id: runId,
          name: modelName,
        }),
      });
      setMsg(`${res.name} v${res.version} 모델을 등록했습니다.`);
      setShowRegister(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "모델 등록에 실패했습니다.");
    }
  }

  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  return (
    <div className="page-stack registry-page">
      <PageHeader
        title="모델 관리"
        description="학습한 모델을 등록하고 검증·승인·운영 상태를 관리합니다."
        actions={
          canWrite ? (
            <button className="btn" onClick={() => setShowRegister(!showRegister)}>
              ＋ 학습 결과로 모델 등록
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={msg} />
      {showRegister && (
        <form className="panel form registry-register-panel" onSubmit={onRegister}>
          <div className="panel-title">
            <div>
              <span className="eyebrow">새 후보 모델</span>
              <h2>학습 결과 등록</h2>
            </div>
          </div>
          <label>
            원본 학습 실행 <HelpTip text="등록할 학습 실행 기록을 선택하세요. 정상적으로 저장된 모델을 후보로 등록합니다." />
            <select
              value={runId}
              onChange={(event) => {
                setRunId(event.target.value);
                const selected = runs.find((run) => run.run_id === event.target.value);
                if (selected) setModelName(suggestModelNameFromRun(selected));
              }}
              required
              data-testid="register-run"
            >
              {runs.map((run) => (
                <option key={run.run_id} value={run.run_id}>
                  {runDisplayName(run)} ({run.status === "FINISHED" ? "완료" : run.status}) · {run.run_id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            모델명 <HelpTip text="모델을 구분할 이름입니다. 자동 추천 이름을 수정할 수 있으며, 기존 등록 모델과 구분되도록 지정하세요." />
            <input
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              required
              data-testid="register-name"
              placeholder="model_name"
            />
          </label>
          <div className="row-actions registry-register-actions">
            <button className="btn" disabled={!runId || !modelName.trim()} data-testid="register-submit">
              모델 등록
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowRegister(false)}>
              취소
            </button>
          </div>
        </form>
      )}
      <div className="workflow-catalog">
        <div className="filter-bar catalog-filter registry-toolbar">
          <label>
            모델 상태
            <select
              value={lifecycle}
              onChange={(event) => setLifecycle(event.target.value)}
              data-testid="registry-lifecycle-filter"
            >
              <option value="">전체 상태</option>
              {MODEL_LIFECYCLES.map((value) => (
                <option key={value} value={value}>
                  {modelLifecycleLabelKo(value)}
                </option>
              ))}
            </select>
          </label>
          <div className="catalog-summary" aria-live="polite">
            <span className="catalog-summary-count">{models.length}</span>
            <span className="catalog-summary-label">
              개 버전
              {lifecycle ? ` · ${modelLifecycleLabelKo(lifecycle)}` : ""}
            </span>
          </div>
        </div>
        {loading ? (
          <Loading label="모델 목록 불러오는 중" />
        ) : models.length === 0 ? (
          <EmptyState
            title="등록된 모델이 없습니다"
            description="완료된 모델 학습 결과를 등록하면 검증과 승인 절차를 진행할 수 있습니다."
            action={
              canWrite ? (
                <button className="btn" onClick={() => setShowRegister(true)}>
                  학습 결과로 모델 등록
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="panel table-wrap catalog-table registry-catalog-table">
            <table>
              <thead>
                <tr>
                  <th>모델명</th>
                  <th>버전</th>
                  <th>모델 상태 <HelpTip text="후보 모델 → 검증 → 승인 → 운영 중 순서로 진행됩니다. 반려·보관 상태도 필터로 조회할 수 있습니다." /></th>
                  <th>검증 결과 <HelpTip text="서버가 모델 파일·입력 구조·단건 예측·응답시간 등을 검사한 결과입니다. 통과만으로 예측 성능을 보장하지는 않습니다." /></th>
                  <th>대표 성능 지표 <HelpTip text="학습 당시 기록된 대표 평가값입니다. 같은 지표와 평가 조건인 경우에만 비교하세요. RMSE·MAE는 낮을수록 좋습니다." /></th>
                  <th>등록일</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <Link
                        className="catalog-primary-link"
                        to={`/projects/${projectId}/models/${model.id}`}
                      >
                        <strong>{model.name}</strong>
                      </Link>
                      <small className="table-subtitle mono">
                        {model.mlflow_run_id?.slice(0, 12) || "—"}
                      </small>
                    </td>
                    <td>
                      <span className="version-chip">v{model.version}</span>
                    </td>
                    <td>
                      <StatusBadge status={model.lifecycle} label={modelLifecycleLabelKo(model.lifecycle)} />
                    </td>
                    <td>
                      <StatusBadge status={model.gates_passed ? "passed" : "pending"} label={modelGateStatusKo(model.gates_passed)} />
                    </td>
                    <td className="tabular-num">
                      {formatModelPrimaryMetricKo(model.metrics, {
                        problemType:
                          typeof model.metadata?.problem_type === "string"
                            ? model.metadata.problem_type
                            : undefined,
                        targetColumns: Array.isArray(model.metadata?.target_columns)
                          ? model.metadata.target_columns.map(String)
                          : [],
                      })}
                    </td>
                    <td className="catalog-meta-date">{formatDate(model.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
