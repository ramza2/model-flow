import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type Dataset, type DatasetVersion, type Pipeline } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, Loading, PageHeader } from "../components";
import {
  buildPipelineGraphForDatasetHandoff,
  parsePipelineCreateHandoff,
} from "../pipelineHandoff";
import { userCanProject, useProject } from "../ProjectContext";

export default function PipelineDatasetHandoff() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");
  const handoffState = useMemo(() => parsePipelineCreateHandoff(searchParams), [searchParams]);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [version, setVersion] = useState<DatasetVersion | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(Boolean(handoffState.handoff));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(handoffState.error || "");

  useEffect(() => {
    const handoff = handoffState.handoff;
    if (!handoff || !projectId) {
      setLoading(false);
      setDataset(null);
      setVersion(null);
      setError(handoffState.error || "Dataset handoff is required.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      api<Dataset>(`/projects/${projectId}/datasets/${handoff.datasetId}`),
      api<DatasetVersion[]>(`/projects/${projectId}/datasets/${handoff.datasetId}/versions`),
    ])
      .then(([datasetRow, versions]) => {
        if (cancelled) return;
        const exactVersion = versions.find((row) => row.id === handoff.datasetVersionId) || null;
        if (!exactVersion || exactVersion.dataset_id !== datasetRow.id) {
          setDataset(null);
          setVersion(null);
          setError(
            "The requested DatasetVersion does not belong to this dataset. No latest-version fallback was applied.",
          );
          return;
        }
        setDataset(datasetRow);
        setVersion(exactVersion);
        setName((current) => current || `${datasetRow.name} pipeline`);
      })
      .catch((reason) => {
        if (!cancelled) {
          setDataset(null);
          setVersion(null);
          setError(reason instanceof Error ? reason.message : "Dataset handoff could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [handoffState.error, handoffState.handoff, projectId]);

  async function createPipeline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !handoffState.handoff || !dataset || !version) return;
    setBusy(true);
    setError("");
    try {
      const pipeline = await api<Pipeline>(`/projects/${projectId}/pipelines`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: `Starts from ${dataset.name} v${version.version}.`,
          graph: buildPipelineGraphForDatasetHandoff(handoffState.handoff),
        }),
      });
      navigate(`/projects/${projectId}/pipelines/${pipeline.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pipeline could not be created.");
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Create pipeline from dataset"
        description="Start the pipeline with one exact immutable DatasetVersion."
        actions={
          <Link className="btn secondary" to={`/projects/${projectId}/pipelines`}>
            Back to pipelines
          </Link>
        }
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Loading label="Loading exact dataset version" />
      ) : dataset && version ? (
        <>
          <section className="panel" data-testid="pipeline-handoff-context">
            <span className="eyebrow">Exact input</span>
            <h2>{dataset.name}</h2>
            <p>
              Dataset #{dataset.id} · v{version.version} · DatasetVersion #{version.id}
            </p>
            <p className="form-hint">
              The new Dataset Load node pins DatasetVersion #{version.id}. A newer dataset version
              will not silently replace it.
            </p>
            <div className="row-actions">
              <Link className="btn link" to={`/projects/${projectId}/datasets/${dataset.id}`}>
                Open dataset
              </Link>
            </div>
          </section>
          {canWrite ? (
            <form className="panel form" onSubmit={createPipeline} data-testid="pipeline-handoff-form">
              <label>
                Pipeline name
                <input
                  value={name}
                  required
                  data-testid="pipeline-handoff-name"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                className="btn"
                type="submit"
                disabled={busy || !name.trim()}
                data-testid="pipeline-handoff-create"
              >
                {busy ? "Creating…" : "Create and open builder"}
              </button>
            </form>
          ) : (
            <p className="form-hint" data-testid="pipeline-handoff-readonly">
              You do not have permission to create pipelines in this project.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
