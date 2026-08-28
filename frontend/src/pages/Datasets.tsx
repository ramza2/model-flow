import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Dataset } from "../api";
import { useAuth } from "../AuthContext";
import { EmptyState, ErrorNotice, Loading, PageHeader, SuccessNotice, formatDate } from "../components";
import { userCanProject, useProject } from "../ProjectContext";

export default function Datasets() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [items, setItems] = useState<Dataset[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const canWrite = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  const refresh = useCallback(async () => {
    const data = await api<Dataset[]>(`/projects/${projectId}/datasets`);
    setItems(data);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Datasets could not be loaded.");
    });
  }, [refresh]);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    if (!fileInput.files?.[0]) return;
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    const nameInput = form.elements.namedItem("name") as HTMLInputElement;
    const descriptionInput = form.elements.namedItem("description") as HTMLInputElement;
    if (nameInput.value) fd.append("name", nameInput.value);
    if (descriptionInput.value) fd.append("description", descriptionInput.value);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/datasets`, { method: "POST", body: fd });
      form.reset();
      await refresh();
      setShowUpload(false);
      setSuccess("Dataset uploaded and profiled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dataset upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Datasets"
        description="Version, profile, validate, and split the data used by your models."
        actions={canWrite ? <button className="btn" onClick={() => setShowUpload(!showUpload)}>↑ Upload dataset</button> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {showUpload && (
        <form className="panel form" onSubmit={onUpload}>
          <div className="panel-title"><div><span className="eyebrow">New version</span><h2>Upload data</h2></div></div>
          <label>
            File
            <input type="file" name="file" accept=".csv,.json,.parquet,text/csv,application/json" required data-testid="dataset-file" />
            <small>CSV, JSON, or Parquet.</small>
          </label>
          <label>Name (optional)<input name="name" placeholder="Defaults to the file name" /></label>
          <label>Description (optional)<input name="description" placeholder="Source and intended use" /></label>
          <div className="row-actions">
            <button className="btn" type="submit" disabled={busy} data-testid="dataset-upload">
              {busy ? "Uploading…" : "Upload and profile"}
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowUpload(false)}>Cancel</button>
          </div>
        </form>
      )}
      {loading ? <Loading label="Loading datasets" /> : items.length === 0 ? (
        <EmptyState
          title="No datasets"
          description="Upload a data file or import one from a connected data source."
          action={canWrite ? <button className="btn" onClick={() => setShowUpload(true)}>Upload dataset</button> : undefined}
        />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr><th>Dataset</th><th>Version</th><th>Rows</th><th>Columns</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {items.map((dataset) => (
                <tr key={dataset.id}>
                  <td><Link to={`/projects/${projectId}/datasets/${dataset.id}`}><strong>{dataset.name}</strong></Link><small className="table-subtitle">{dataset.description || "Uploaded dataset"}</small></td>
                  <td>v{dataset.latest_version}</td>
                  <td>{dataset.row_count.toLocaleString()}</td>
                  <td>{dataset.column_count}</td>
                  <td>{formatDate(dataset.latest_version_created_at ?? dataset.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
