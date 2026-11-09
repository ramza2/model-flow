import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Endpoint } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, HelpTip, Loading, PageHeader, StatusBadge, SuccessNotice } from "../components";
import {
  formatNamedPrediction,
  formatOutputTargetsLabel,
  formatPredictionSummary,
  isScalarPrediction,
} from "../lifecycleHelpers";
import { userCanProject, useProject } from "../ProjectContext";
import { buildPredictionSamplePayload } from "../trainingConfig";
import { UI_HELP } from "../uiTerminology";

function formatPredictionPreview(prediction: unknown): string {
  if (prediction !== null && typeof prediction === "object" && !Array.isArray(prediction)) {
    // Prefer named target keys for multi-output; keep JSON for nested readability in tests/overflow.
    const named = formatNamedPrediction(prediction);
    try {
      return JSON.stringify(prediction, null, 2);
    } catch {
      return named;
    }
  }
  if (Array.isArray(prediction)) {
    return prediction.map((item, index) => `항목 ${index + 1}\n${formatPredictionPreview(item)}`).join("\n\n");
  }
  return String(prediction);
}

function initialPayloadFromEndpoint(endpoint: Endpoint): string {
  if (endpoint.prediction_sample && Object.keys(endpoint.prediction_sample).length > 0) {
    return JSON.stringify([endpoint.prediction_sample], null, 2);
  }
  return JSON.stringify(buildPredictionSamplePayload(endpoint.feature_schema || []), null, 2);
}

function featureFieldNames(endpoint: Endpoint): string {
  return (
    endpoint.feature_schema
      .map((field) => (typeof field === "string" ? field : String(field.name || field.field)))
      .filter(Boolean)
      .join(", ") || "선언된 입력 특성이 없습니다"
  );
}

export default function Predict() {
  const { projectId, endpointId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [ep, setEp] = useState<Endpoint | null>(null);
  const [payload, setPayload] = useState("[]");
  const [result, setResult] = useState<{ predictions: unknown[]; model_uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canDeploy = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  useEffect(() => {
    let cancelled = false;
    api<Endpoint>(`/endpoints/${endpointId}`)
      .then((endpoint) => {
        if (cancelled) return;
        setEp(endpoint);
        setPayload(initialPayloadFromEndpoint(endpoint));
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "배포 정보를 불러오지 못했습니다.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId]);

  async function startEndpoint() {
    if (!ep) return;
    setStarting(true);
    setError("");
    setSuccess("");
    try {
      const updated = await api<Endpoint>(`/endpoints/${ep.id}/start`, { method: "POST" });
      setEp(updated);
      setSuccess("배포를 시작했습니다. 이제 예측을 실행할 수 있습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "배포를 시작하지 못했습니다.");
    } finally {
      setStarting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    setBusy(true);
    try {
      const instances = JSON.parse(payload);
      if (!Array.isArray(instances) || instances.length === 0) {
        throw new Error("입력은 하나 이상의 행이 들어 있는 JSON 배열이어야 합니다.");
      }
      const res = await api<{ predictions: unknown[]; model_uri: string }>(`/endpoints/${endpointId}/predict`, {
        method: "POST",
        body: JSON.stringify({ instances }),
      });
      setResult(res);
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? "입력 데이터가 올바른 JSON 형식이 아닙니다."
          : err instanceof Error
            ? err.message
            : "예측에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  const stopped = ep?.status === "stopped";
  const outputTargets = ep?.output_targets ?? [];
  const firstPrediction = result?.predictions[0];
  const showPreview = firstPrediction !== undefined && !isScalarPrediction(firstPrediction);

  return (
    <div className="page-stack predict-page">
      <PageHeader
        title="예측 테스트"
        description={
          ep
            ? `“${ep.name}” 배포에 샘플 입력을 보내 실시간 예측을 확인합니다.`
            : "배포의 입력 특성(schema)을 확인하고 예측을 테스트합니다."
        }
        actions={ep ? <StatusBadge status={ep.status} /> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {!ep ? (
        <Loading label="배포 정보 불러오는 중" />
      ) : (
        <>
          <div
            className={`builder-state-band predict-state-band${stopped ? " is-blocked" : " is-ready"}`}
            role="status"
          >
            <span className="builder-state-copy">배포</span>
            <StatusBadge status={ep.status} />
            <span className="builder-state-copy mono">
              {ep.model_name} · v{ep.model_version}
            </span>
            <span className="builder-state-copy" data-testid="predict-output-targets">
              {formatOutputTargetsLabel(outputTargets)}
            </span>
          </div>
          <div className="predict-layout">
            <form className="panel form form-wide predict-request-panel" onSubmit={onSubmit}>
              <div className="panel-title">
                <div>
                  <span className="eyebrow">요청</span>
                  <h2>입력 데이터 (JSON)</h2>
                </div>
              </div>
              <p className="form-hint" data-testid="predict-input-help">
                {UI_HELP.predictionPayload} <HelpTip text={UI_HELP.predictionPayload} />
              </p>
              {stopped && (
                <div className="notice predict-stopped-notice" data-testid="endpoint-stopped-notice">
                  <p>이 배포는 중지된 상태입니다. 예측을 실행하려면 먼저 배포를 시작하세요.</p>
                  <div className="row-actions">
                    {canDeploy ? (
                      <button
                        className="btn"
                        type="button"
                        disabled={starting}
                        onClick={() => void startEndpoint()}
                        data-testid="start-endpoint"
                      >
                        {starting ? "시작 중…" : "배포 시작"}
                      </button>
                    ) : (
                      <Link className="btn secondary" to={`/projects/${projectId}/deployments`}>
                        배포 목록으로
                      </Link>
                    )}
                  </div>
                </div>
              )}
              <label>
                입력 JSON
                <textarea
                  className="code-input predict-input engineering-surface"
                  value={payload}
                  onChange={(event) => setPayload(event.target.value)}
                  data-testid="predict-payload"
                  spellCheck={false}
                />
                <small data-testid="predict-expected-fields">
                  기대하는 입력 특성: {featureFieldNames(ep)}
                </small>
              </label>
              <button
                className="btn"
                type="submit"
                disabled={busy || ep.status !== "ready"}
                data-testid="predict-submit"
              >
                {busy ? "예측 중…" : "예측 실행"}
              </button>
            </form>
            <section className="panel result-panel predict-response-panel">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">응답</span>
                  <h2>예측 결과</h2>
                </div>
              </div>
              <p className="form-hint" data-testid="predict-result-help">
                {UI_HELP.predictionResult}
              </p>
              {result ? (
                <>
                  <div className="prediction-summary" data-testid="predict-summary">
                    <span className="eyebrow">요약</span>
                    <pre className="prediction-value prediction-preview named-prediction">
                      {formatPredictionSummary(firstPrediction, outputTargets)}
                    </pre>
                  </div>
                  {showPreview && (
                    <div
                      className="prediction-value prediction-preview engineering-surface"
                      data-testid="predict-preview"
                    >
                      {formatPredictionPreview(firstPrediction)}
                    </div>
                  )}
                  <div className="predict-raw-block">
                    <span className="eyebrow">원본 JSON</span>
                    <pre
                      className="json-view predict-result-json engineering-surface"
                      data-testid="predict-result"
                    >
                      {JSON.stringify(result, null, 2)}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="result-placeholder">예측을 실행하면 여기에 결과가 표시됩니다.</div>
              )}
            </section>
          </div>
        </>
      )}
      <Link to={`/projects/${projectId}/deployments`}>← 배포 목록으로</Link>
    </div>
  );
}
