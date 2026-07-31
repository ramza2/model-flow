import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, Dataset } from "../api";

export default function Datasets() {
  const { projectId } = useParams();
  const [items, setItems] = useState<Dataset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const data = await api<Dataset[]>(`/api/projects/${projectId}/datasets`);
    setItems(data);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
  }, [projectId]);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    if (!fileInput.files?.[0]) return;
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/datasets`, { method: "POST", body: fd });
      form.reset();
      await refresh();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Datasets</h1>
      <p className="lead">Upload CSV files. Columns and basic statistics are computed automatically.</p>
      {error && <div className="error">{error}</div>}
      <form className="panel form" onSubmit={onUpload}>
        <label>
          CSV file
          <input type="file" name="file" accept=".csv,text/csv" required data-testid="dataset-file" />
        </label>
        <button className="btn" type="submit" disabled={busy} data-testid="dataset-upload">
          {busy ? "Uploading…" : "Upload dataset"}
        </button>
      </form>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Rows</th><th>Columns</th><th>Created</th></tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id}>
                <td><Link to={`/projects/${projectId}/datasets/${d.id}`}>{d.name}</Link></td>
                <td>{d.row_count}</td>
                <td>{d.column_count}</td>
                <td className="mono">{new Date(d.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="muted">No datasets uploaded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
