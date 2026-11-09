import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, type Endpoint, type ModelVersion } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  metric,
} from "../components";
import { userCanProject, useProject } from "../ProjectContext";
import { UI_HELP } from "../uiTerminology";

type SwapTarget = {
  endpoint: Endpoint;
  modelVersionId: string;
};

/** Previous-model fields are recorded; does not guarantee a successful rollback load. */
function hasPreviousModel(endpoint: Endpoint): boolean {
  if (typeof endpoint.can_rollback === "boolean") return endpoint.can_rollback;
  return Boolean(endpoint.previous_model_version && endpoint.previous_model_uri);
}

export default function Endpoints() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const location = useLocation() as { state?: { modelVersionId?: number } };
  const [items, setItems] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [name, setName] = useState("prediction-service");
  const [modelVersionId, setModelVersionId] = useState(String(location.state?.modelVersionId || ""));
  const [showCreate, setShowCreate] = useState(Boolean(location.state?.modelVersionId));
  const [swapTarget, setSwapTarget] = useState<SwapTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canDeploy = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const refresh = useCallback(async () => {
    const [e, m] = await Promise.all([
      api<Endpoint[]>(`/projects/${projectId}/endpoints`),
      api<ModelVersion[]>(`/projects/${projectId}/models`),
    ]);
    setItems(e);
    const deployable = m.filter((model) => ["APPROVED", "PRODUCTION"].includes(model.lifecycle));
    setModels(deployable);
    setModelVersionId((current) => current || String(deployable[0]?.id || ""));
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "모델 배포 목록을 불러오지 못했습니다.");
    });
  }, [refresh]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy("create");
    try {
      await api(`/projects/${projectId}/endpoints`, {
        method: "POST",
        body: JSON.stringify({ name, model_version_id: Number(modelVersionId) }),
      });
      await refresh();
      setShowCreate(false);
      setSuccess("배포가 준비되었습니다. 예측 테스트로 확인할 수 있습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "배포를 만들지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function endpointAction(endpoint: Endpoint, action: "start" | "stop") {
    if (
      action === "stop" &&
      !confirmAction(`“${endpoint.name}” 배포를 중지할까요?\n예측 요청을 받을 수 없게 됩니다.`)
    ) {
      return;
    }
    setBusy(`${action}-${endpoint.id}`);
    setError("");
    try {
      await api(`/endpoints/${endpoint.id}/${action}`, { method: "POST" });
      setSuccess(action === "start" ? "배포를 시작했습니다." : "배포를 중지했습니다.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `배포를 ${action === "start" ? "시작" : "중지"}하지 못했습니다.`);
    } finally {
      setBusy("");
    }
  }

  function openSwap(endpoint: Endpoint) {
    setError("");
    setSuccess("");
    setSwapTarget({
      endpoint,
      modelVersionId: "",
    });
  }

  function closeSwap() {
    if (busy.startsWith("swap-")) return;
    setSwapTarget(null);
  }

  async function confirmSwap(event: FormEvent) {
    event.preventDefault();
    if (!swapTarget) return;
    const nextId = Number(swapTarget.modelVersionId);
    if (!nextId) {
      setError("교체할 모델을 선택하세요.");
      return;
    }
    const nextModel = models.find((model) => model.id === nextId);
    const current = swapTarget.endpoint;
    const stoppedWarning =
      current.status === "stopped"
        ? "이 배포는 현재 중지 상태입니다. 전환이 성공하면 배포 상태가 ready로 변경됩니다."
        : null;
    const confirmed = confirmAction(
      [
        `“${current.name}”의 운영 모델을 전환할까요?`,
        "",
        `현재: ${current.model_name} · v${current.model_version}`,
        `변경: ${nextModel ? `${nextModel.name} · v${nextModel.version}` : `모델 #${nextId}`}`,
        "",
        "현재 모델 정보는 이전 모델로 보관됩니다. 모델 승인 상태는 바뀌지 않습니다.",
        "이전 모델 정보가 있다고 해서 이후 복구 성공이 보장되지는 않습니다.",
        ...(stoppedWarning ? ["", stoppedWarning] : []),
      ].join("\n"),
    );
    if (!confirmed) return;

    setBusy(`swap-${current.id}`);
    setError("");
    try {
      await api(`/endpoints/${current.id}/swap`, {
        method: "POST",
        body: JSON.stringify({ model_version_id: nextId }),
      });
      setSwapTarget(null);
      setSuccess(
        `운영 모델을 ${nextModel ? `${nextModel.name} v${nextModel.version}` : `#${nextId}`}(으)로 전환했습니다.`,
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "운영 모델 전환에 실패했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function rollbackEndpoint(endpoint: Endpoint) {
    if (!hasPreviousModel(endpoint)) return;
    const confirmed = confirmAction(
      [
        `“${endpoint.name}”을(를) 이전 모델로 복구할까요?`,
        "",
        `현재: ${endpoint.model_name} · v${endpoint.model_version}`,
        `이전 모델: v${endpoint.previous_model_version}`,
        "",
        "이전 모델 정보가 기록되어 있을 뿐이며, 로드 실패 시 복구는 실패할 수 있습니다.",
        "복구 시도 후 지금 모델은 다시 이전 모델 자리로 보관됩니다.",
      ].join("\n"),
    );
    if (!confirmed) return;

    setBusy(`rollback-${endpoint.id}`);
    setError("");
    try {
      await api(`/endpoints/${endpoint.id}/rollback`, { method: "POST" });
      setSuccess(`이전 모델 v${endpoint.previous_model_version}(으)로 복구했습니다.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "이전 모델 복구에 실패했습니다.");
    } finally {
      setBusy("");
    }
  }

  const swapAlternatives = swapTarget
    ? models.filter((model) => model.id !== swapTarget.endpoint.model_version_id)
    : [];

  return (
    <div className="page-stack deployments-page">
      <PageHeader
        title="모델 배포"
        description="승인된 모델을 온라인으로 서빙하고, 운영 모델 전환·이전 모델 복구 시도와 예측 테스트를 관리합니다."
        actions={
          canDeploy ? (
            <div className="row-actions">
              <Link className="btn secondary" to={`/projects/${projectId}/deployments/batch`}>
                배치 예측
              </Link>
              <button className="btn" onClick={() => setShowCreate(!showCreate)}>
                ＋ 새 배포
              </button>
            </div>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {canDeploy && showCreate && (
        <form className="panel form deployment-create-panel" onSubmit={onCreate}>
          <div className="panel-title">
            <div>
              <span className="eyebrow">온라인 예측</span>
              <h2>배포 만들기</h2>
            </div>
          </div>
          {models.length === 0 && (
            <div className="notice">배포하려면 먼저 모델을 승인하거나 운영(PRODUCTION)으로 승격하세요.</div>
          )}
          <label>
            배포 이름
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              data-testid="endpoint-name"
            />
          </label>
          <label>
            승인된 모델
            <select
              value={modelVersionId}
              onChange={(event) => setModelVersionId(event.target.value)}
              required
              data-testid="endpoint-model"
            >
              <option value="">모델 선택</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} · v{model.version} · {model.lifecycle.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <div className="row-actions">
            <button
              className="btn"
              disabled={!modelVersionId || busy === "create"}
              data-testid="endpoint-create"
            >
              {busy === "create" ? "만드는 중…" : "배포 만들기"}
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>
              취소
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <Loading label="배포 목록 불러오는 중" />
      ) : items.length === 0 ? (
        <EmptyState
          title="배포가 없습니다"
          description="등록·승인된 모델로 예측 서비스를 만드세요."
          action={
            canDeploy ? (
              <button className="btn" onClick={() => setShowCreate(true)}>
                배포 만들기
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="deployment-grid">
          {items.map((endpoint) => (
            <article
              className={`deployment-card status-${endpoint.status || "unknown"}`}
              key={endpoint.id}
            >
              <header>
                <div>
                  <span className="eyebrow">온라인 서비스</span>
                  <h2>{endpoint.name}</h2>
                </div>
                <StatusBadge status={endpoint.status} />
              </header>
              <p className="deployment-model-meta">
                <span className="muted">현재 모델</span>{" "}
                <span className="mono">{endpoint.model_name}</span>
                <span className="version-chip">v{endpoint.model_version}</span>
              </p>
              {hasPreviousModel(endpoint) ? (
                <p className="deployment-previous-model" data-testid={`endpoint-previous-${endpoint.id}`}>
                  <span className="muted">이전 모델 있음</span>{" "}
                  <span className="version-chip">v{endpoint.previous_model_version}</span>
                  <span className="muted"> · 복구 성공이 보장되지는 않습니다</span>
                </p>
              ) : (
                <p className="muted deployment-previous-model" data-testid={`endpoint-previous-empty-${endpoint.id}`}>
                  기록된 이전 모델이 없습니다.
                </p>
              )}
              <div className="deployment-metrics">
                <div className="metric-card">
                  <strong className="tabular-num">{endpoint.request_count.toLocaleString()}</strong>
                  <span>요청</span>
                </div>
                <div className="metric-card">
                  <strong className="tabular-num">
                    {endpoint.success_rate === null
                      ? "—"
                      : `${metric(endpoint.success_rate * 100, 1)}%`}
                  </strong>
                  <span>성공률</span>
                </div>
                <div className="metric-card">
                  <strong className="tabular-num">
                    {endpoint.average_latency_ms === null
                      ? "—"
                      : `${metric(endpoint.average_latency_ms, 1)} ms`}
                  </strong>
                  <span>평균 응답</span>
                </div>
                <div className="metric-card">
                  <strong className="tabular-num">{metric(endpoint.latency_p95_ms, 1)} ms</strong>
                  <span>p95 응답</span>
                </div>
              </div>
              <footer className="deployment-card-actions">
                <Link
                  className="btn"
                  to={`/projects/${projectId}/deployments/${endpoint.id}/predict`}
                  data-testid={`endpoint-predict-${endpoint.id}`}
                >
                  예측 테스트
                </Link>
                <Link
                  className="btn secondary"
                  to={`/projects/${projectId}/deployments/${endpoint.id}/api`}
                  data-testid={`endpoint-api-usage-${endpoint.id}`}
                >
                  API 사용법
                </Link>
                {canDeploy && (
                  <>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={Boolean(busy) || models.every((model) => model.id === endpoint.model_version_id)}
                      onClick={() => openSwap(endpoint)}
                      data-testid={`endpoint-swap-${endpoint.id}`}
                      title={UI_HELP.endpointModelSwap}
                    >
                      운영 모델 전환
                    </button>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={Boolean(busy) || !hasPreviousModel(endpoint)}
                      onClick={() => void rollbackEndpoint(endpoint)}
                      data-testid={`endpoint-rollback-${endpoint.id}`}
                      title={UI_HELP.endpointModelRollback}
                    >
                      {busy === `rollback-${endpoint.id}` ? "복구 시도 중…" : "이전 모델로 복구"}
                    </button>
                    {endpoint.status === "ready" ? (
                      <button
                        className="btn secondary"
                        disabled={Boolean(busy)}
                        onClick={() => endpointAction(endpoint, "stop")}
                      >
                        중지
                      </button>
                    ) : (
                      <button
                        className="btn secondary"
                        disabled={Boolean(busy)}
                        onClick={() => endpointAction(endpoint, "start")}
                      >
                        시작
                      </button>
                    )}
                  </>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
      {swapTarget && (
        <div className="modal-backdrop" role="presentation" onClick={closeSwap}>
          <form
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="endpoint-swap-title"
            onSubmit={(event) => void confirmSwap(event)}
            onClick={(event) => event.stopPropagation()}
            data-testid="endpoint-swap-dialog"
          >
            <div className="panel-title">
              <div>
                <span className="eyebrow">운영 모델</span>
                <h2 id="endpoint-swap-title">운영 모델 전환 확인</h2>
              </div>
            </div>
            <p className="form-hint">{UI_HELP.endpointModelSwap}</p>
            {swapTarget.endpoint.status === "stopped" && (
              <div className="notice" data-testid="endpoint-swap-stopped-notice">
                이 배포는 중지 상태입니다. 전환이 성공하면 기존 API 동작에 따라 배포 상태가 ready로
                변경됩니다.
              </div>
            )}
            <dl className="key-values compact">
              <div>
                <dt>배포</dt>
                <dd>{swapTarget.endpoint.name}</dd>
              </div>
              <div data-testid="endpoint-swap-status">
                <dt>현재 상태</dt>
                <dd>{swapTarget.endpoint.status}</dd>
              </div>
              <div data-testid="endpoint-swap-current">
                <dt>현재 모델</dt>
                <dd className="mono">
                  {swapTarget.endpoint.model_name} · v{swapTarget.endpoint.model_version}
                </dd>
              </div>
              {hasPreviousModel(swapTarget.endpoint) && (
                <div data-testid="endpoint-swap-previous">
                  <dt>기록된 이전 모델</dt>
                  <dd>v{swapTarget.endpoint.previous_model_version}</dd>
                </div>
              )}
            </dl>
            <label>
              전환할 모델
              <select
                value={swapTarget.modelVersionId}
                onChange={(event) =>
                  setSwapTarget((current) =>
                    current ? { ...current, modelVersionId: event.target.value } : current,
                  )
                }
                required
                data-testid="endpoint-swap-model"
                data-drawer-initial-focus
              >
                <option value="">모델을 선택하세요</option>
                {swapAlternatives.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · v{model.version} · {model.lifecycle.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            {swapAlternatives.length === 0 && (
              <div className="notice">전환 가능한 다른 승인/운영 모델이 없습니다.</div>
            )}
            <div className="row-actions">
              <button
                className="btn"
                type="submit"
                disabled={!swapTarget.modelVersionId || busy === `swap-${swapTarget.endpoint.id}`}
                data-testid="endpoint-swap-confirm"
              >
                {busy === `swap-${swapTarget.endpoint.id}` ? "전환 중…" : "전환 확인"}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={closeSwap}
                disabled={busy === `swap-${swapTarget.endpoint.id}`}
                data-testid="endpoint-swap-cancel"
              >
                취소
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
