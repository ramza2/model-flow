import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, Endpoint } from "../api";

const SAMPLE = `[
  {
    "sepal length (cm)": 5.1,
    "sepal width (cm)": 3.5,
    "petal length (cm)": 1.4,
    "petal width (cm)": 0.2
  }
]`;

export default function Predict() {
  const { projectId, endpointId } = useParams();
  const [ep, setEp] = useState<Endpoint | null>(null);
  const [payload, setPayload] = useState(SAMPLE);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Endpoint>(`/api/endpoints/${endpointId}`).then(setEp).catch((e) => setError(String(e.message || e)));
  }, [endpointId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      const instances = JSON.parse(payload);
      const res = await api<{ predictions: unknown[]; model_uri: string }>(`/api/endpoints/${endpointId}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instances }),
      });
      setResult(JSON.stringify(res, null, 2));
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  }

  return (
    <div>
      <h1>Inference test</h1>
      <p className="lead">
        {ep ? `Endpoint “${ep.name}” · ${ep.model_uri}` : "Loading endpoint…"}
      </p>
      {error && <div className="error">{error}</div>}
      <form className="panel form" onSubmit={onSubmit} style={{ maxWidth: 720 }}>
        <label>
          Instances JSON
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} data-testid="predict-payload" />
        </label>
        <button className="btn" type="submit" data-testid="predict-submit">Run prediction</button>
      </form>
      {result && (
        <div className="panel">
          <h2>Result</h2>
          <pre className="logs" data-testid="predict-result">{result}</pre>
        </div>
      )}
      <p className="muted">Project {projectId}</p>
    </div>
  );
}
