import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Endpoint } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, Loading, PageHeader, StatusBadge, SuccessNotice } from "../components";
import { userCanProject, useProject } from "../ProjectContext";
import { buildPredictionSamplePayload } from "../trainingConfig";

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
    api<Endpoint>(`/endpoints/${endpointId}`).then((endpoint) => {
      setEp(endpoint);
      const irisValues: Record<string, number> = {
        "sepal length (cm)": 5.1,
        "sepal width (cm)": 3.5,
        "petal length (cm)": 1.4,
        "petal width (cm)": 0.2,
      };
      const sample = buildPredictionSamplePayload(
        endpoint.feature_schema,
        irisValues,
      );
      setPayload(JSON.stringify(sample, null, 2));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Deployment could not be loaded."));
  }, [endpointId]);

  async function startEndpoint() {
    if (!ep) return;
    setStarting(true);
    setError("");
    setSuccess("");
    try {
      const updated = await api<Endpoint>(`/endpoints/${ep.id}/start`, { method: "POST" });
      setEp(updated);
      setSuccess("Endpoint started and ready for predictions.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Endpoint could not be started.");
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
      if (!Array.isArray(instances) || instances.length === 0) throw new Error("Provide a JSON array containing at least one instance.");
      const res = await api<{ predictions: unknown[]; model_uri: string }>(`/endpoints/${endpointId}/predict`, {
        method: "POST",
        body: JSON.stringify({ instances }),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof SyntaxError ? "Prediction input must be valid JSON." : err instanceof Error ? err.message : "Prediction failed.");
    } finally {
      setBusy(false);
    }
  }

  const stopped = ep?.status === "stopped";

  return (
    <div>
      <PageHeader title="Prediction test" description={ep ? `Send a test request to ${ep.name}.` : "Load deployment schema and test a prediction."} actions={ep && <StatusBadge status={ep.status} />} />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {!ep ? <Loading label="Loading deployment" /> : (
        <div className="predict-layout">
          <form className="panel form form-wide" onSubmit={onSubmit}>
            <div className="panel-title"><div><span className="eyebrow">Request</span><h2>Instances JSON</h2></div></div>
            {stopped && (
              <div className="notice" data-testid="endpoint-stopped-notice">
                <p>This endpoint is stopped. Start the endpoint before running predictions.</p>
                <div className="row-actions">
                  {canDeploy ? (
                    <button className="btn" type="button" disabled={starting} onClick={() => void startEndpoint()} data-testid="start-endpoint">
                      {starting ? "Starting…" : "Start endpoint"}
                    </button>
                  ) : (
                    <Link className="btn secondary" to={`/projects/${projectId}/deployments`}>Back to deployments</Link>
                  )}
                </div>
              </div>
            )}
            <label>Payload<textarea className="code-input predict-input" value={payload} onChange={(event) => setPayload(event.target.value)} data-testid="predict-payload" spellCheck={false} /><small>Expected fields: {ep.feature_schema.map((field) => typeof field === "string" ? field : String(field.name || field.field)).join(", ") || "schema not declared"}</small></label>
            <button className="btn" type="submit" disabled={busy || ep.status !== "ready"} data-testid="predict-submit">{busy ? "Running…" : "Run prediction"}</button>
          </form>
          <section className="panel result-panel">
            <div className="panel-title"><div><span className="eyebrow">Response</span><h2>Prediction result</h2></div></div>
            {result ? <><div className="prediction-value">{String(result.predictions[0])}</div><pre className="json-view" data-testid="predict-result">{JSON.stringify(result, null, 2)}</pre></> : <div className="result-placeholder">Run a prediction to inspect the response.</div>}
          </section>
        </div>
      )}
      <Link to={`/projects/${projectId}/deployments`}>← Back to deployments</Link>
    </div>
  );
}
