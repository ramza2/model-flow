import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiRequestError, api, type DatasetPreparation } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SuccessNotice,
  formatDate,
} from "../components";
import { emptyPreparationGraph } from "../preparationHelpers";
import { userCanProject, useProject } from "../ProjectContext";

export default function Preparations() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [items, setItems] = useState<DatasetPreparation[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canWrite = userCanProject(
    user,
    selectedProject,
    "DATA_SCIENTIST",
    "ML_ENGINEER",
    "PROJECT_ADMIN",
  );

  const refresh = useCallback(async () => {
    const data = await api<DatasetPreparation[]>(
      `/projects/${projectId}/dataset-preparations`,
    );
    setItems(data);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Preparations could not be loaded.");
    });
  }, [refresh]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const created = await api<DatasetPreparation>(
        `/projects/${projectId}/dataset-preparations`,
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            graph: emptyPreparationGraph(),
          }),
        },
      );
      navigate(`/projects/${projectId}/preparations/${created.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preparation could not be created.");
      setBusy(false);
    }
  }

  async function onDelete(preparation: DatasetPreparation) {
    if (!canWrite) return;
    if (!window.confirm(`Delete preparation “${preparation.name}”?`)) return;
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/dataset-preparations/${preparation.id}`, {
        method: "DELETE",
      });
      setSuccess(`Deleted “${preparation.name}”.`);
      await refresh();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "Preparation could not be deleted.");
      }
    }
  }

  return (
    <div>
      <PageHeader
        title="Preparations"
        description="Combine and inspect datasets before training."
        actions={
          canWrite ? (
            <button
              className="btn"
              type="button"
              data-testid="preparation-create-toggle"
              onClick={() => setShowCreate(!showCreate)}
            >
              ＋ New preparation
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {canWrite && showCreate && (
        <form className="panel form" onSubmit={onCreate} data-testid="preparation-create-form">
          <div className="panel-title">
            <div>
              <span className="eyebrow">New preparation</span>
              <h2>Create graph</h2>
            </div>
          </div>
          <label>
            Name
            <input
              name="name"
              value={name}
              required
              placeholder="Customer features join"
              data-testid="preparation-name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Description (optional)
            <input
              name="description"
              value={description}
              placeholder="What this preparation produces"
              data-testid="preparation-description"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="row-actions">
            <button className="btn" type="submit" disabled={busy} data-testid="preparation-create">
              {busy ? "Creating…" : "Create and open builder"}
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <Loading label="Loading preparations" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No preparations"
          description="Create a visual graph to join or union datasets before training."
          action={
            canWrite ? (
              <button className="btn" type="button" onClick={() => setShowCreate(true)}>
                New preparation
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="panel table-wrap">
          <table data-testid="preparations-table">
            <thead>
              <tr>
                <th>Preparation</th>
                <th>Latest version</th>
                <th>Output dataset</th>
                <th>Created</th>
                <th>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((preparation) => (
                <tr key={preparation.id} data-testid={`preparation-row-${preparation.id}`}>
                  <td>
                    <Link to={`/projects/${projectId}/preparations/${preparation.id}`}>
                      <strong>{preparation.name}</strong>
                    </Link>
                    <small className="table-subtitle">
                      {preparation.description || "Dataset preparation"}
                    </small>
                  </td>
                  <td>v{preparation.latest_version}</td>
                  <td>
                    {preparation.output_dataset_id == null
                      ? "Not configured"
                      : `#${preparation.output_dataset_id}`}
                  </td>
                  <td>{formatDate(preparation.created_at)}</td>
                  <td>
                    {canWrite ? (
                      <button
                        type="button"
                        className="btn link danger-text"
                        data-testid={`preparation-delete-${preparation.id}`}
                        onClick={() => void onDelete(preparation)}
                      >
                        Delete
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
