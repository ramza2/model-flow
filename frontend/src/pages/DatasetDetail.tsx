import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Dataset } from "../api";

export default function DatasetDetail() {
  const { projectId, datasetId } = useParams();
  const [ds, setDs] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Dataset>(`/api/datasets/${datasetId}`).then(setDs).catch((e) => setError(String(e.message || e)));
  }, [datasetId]);

  return (
    <div>
      <h1>{ds?.name ?? "Dataset"}</h1>
      <p className="lead">
        {ds ? `${ds.row_count} rows · ${ds.column_count} columns` : "Loading…"}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="panel row-actions">
        <Link className="btn" to={`/projects/${projectId}/jobs/new?datasetId=${datasetId}`}>
          Train on this dataset
        </Link>
      </div>
      <div className="panel">
        <h2>Column statistics</h2>
        <table>
          <thead>
            <tr><th>Column</th><th>Type</th><th>Nulls</th><th>Unique</th><th>Summary</th></tr>
          </thead>
          <tbody>
            {ds?.columns.map((col) => {
              const s = ds.stats[col] || {};
              const summary =
                s.mean !== undefined
                  ? `min=${s.min} max=${s.max} mean=${Number(s.mean).toFixed?.(4) ?? s.mean}`
                  : s.top_values
                    ? JSON.stringify(s.top_values)
                    : "—";
              return (
                <tr key={col}>
                  <td className="mono">{col}</td>
                  <td>{String(s.dtype ?? "")}</td>
                  <td>{String(s.null_count ?? "")}</td>
                  <td>{String(s.unique_count ?? "")}</td>
                  <td className="mono muted">{summary}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
