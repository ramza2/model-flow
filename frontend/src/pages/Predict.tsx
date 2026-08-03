import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Endpoint } from "../api";
import { ErrorNotice, Loading, PageHeader, StatusBadge } from "../components";

export default function Predict() {
  const { projectId, endpointId } = useParams();
  const [ep, setEp] = useState<Endpoint | null>(null);
  const [payload, setPayload] = useState("[]");
  const [result, setResult] = useState<{ predictions: unknown[]; model_uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Endpoint>(`/endpoints/${endpointId}`).then((endpoint) => {
      setEp(endpoint);
      const irisValues: Record<string, number> = {
        "sepal length (cm)": 5.1,
        "sepal width (cm)": 3.5,
        "petal length (cm)": 1.4,
        "petal width (cm)": 0.2,
      };
      const instance = Object.fromEntries(
        endpoint.feature_schema.map((field, index) => {
          const name = typeof field === "string" ? field : String(field.name || field.field || `feature_${index + 1}`);
          return [name, irisValues[name] ?? 0];
        }),
      );
      setPayload(JSON.stringify([instance], null, 2));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Deployment could not be loaded."));
  }, [endpointId]);

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

  return (
    <div>
      <PageHeader title="Prediction test" description={ep ? `Send a test request to ${ep.name}.` : "Load deployment schema and test a prediction."} actions={ep && <StatusBadge status={ep.status} />} />
      <ErrorNotice message={error} />
      {!ep ? <Loading label="Loading deployment" /> : (
        <div className="predict-layout">
          <form className="panel form form-wide" onSubmit={onSubmit}>
            <div className="panel-title"><div><span className="eyebrow">Request</span><h2>Instances JSON</h2></div></div>
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
