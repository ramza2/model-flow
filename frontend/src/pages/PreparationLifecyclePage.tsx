import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Dataset, type DatasetPreparationRun } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, StatusBadge, formatDate } from "../components";
import { pipelineCreateUrlForDataset } from "../pipelineHandoff";
import { userCanProject, useProject } from "../ProjectContext";
import PreparationBuilder from "./PreparationBuilder";

function isSucceededMaterializedRun(run: DatasetPreparationRun): boolean {
  return (
    String(run.status).toLowerCase() === "succeeded" &&
    run.output_dataset_id != null &&
    run.output_dataset_version_id != null
  );
}

export default function PreparationLifecyclePage() {
  const { projectId, preparationId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const canCreatePipeline = userCanProject(
    user,
    selectedProject,
    "ML_ENGINEER",
    "PROJECT_ADMIN",
  );
  const [runs, setRuns] = useState<DatasetPreparationRun[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!projectId || !preparationId) return;
    try {
      const [runRows, datasetRows] = await Promise.all([
        api<DatasetPreparationRun[]>(
          `/projects/${projectId}/dataset-preparations/${preparationId}/runs`,
        ),
        api<Dataset[]>(`/projects/${projectId}/datasets`).catch(() => [] as Dataset[]),
      ]);
      setRuns(runRows);
      setDatasets(datasetRows);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Prepared-result lifecycle actions could not be loaded.",
      );
    }
  }, [preparationId, projectId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const materializedRuns = useMemo(
    () => runs.filter(isSucceededMaterializedRun),
    [runs],
  );

  return (
    <>
      <PreparationBuilder />
      <section className="panel" data-testid="preparation-lifecycle-handoff">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Next lifecycle step</span>
            <h2>Use a materialized result in a pipeline</h2>
          </div>
        </div>
        <ErrorNotice message={error} />
        {materializedRuns.length === 0 ? (
          <p className="muted" data-testid="preparation-lifecycle-empty">
            Run this preparation successfully to create an exact DatasetVersion for pipeline use.
          </p>
        ) : (
          <div className="activity-list" data-testid="preparation-lifecycle-results">
            {materializedRuns.map((run) => {
              const datasetId = run.output_dataset_id!;
              const datasetVersionId = run.output_dataset_version_id!;
              const dataset = datasets.find((row) => row.id === datasetId);
              return (
                <div key={run.id} className="source-card" data-testid={`preparation-pipeline-result-${run.id}`}>
                  <div>
                    <strong>{dataset?.name || `Dataset #${datasetId}`}</strong>
                    <small>
                      Run #{run.id} · DatasetVersion #{datasetVersionId} · {formatDate(run.finished_at)}
                    </small>
                  </div>
                  <div className="row-actions">
                    <StatusBadge status={run.status} />
                    <Link className="btn link" to={`/projects/${projectId}/datasets/${datasetId}`}>
                      Open dataset
                    </Link>
                    {canCreatePipeline && (
                      <Link
                        className="btn secondary"
                        data-testid={`preparation-use-in-pipeline-${run.id}`}
                        to={pipelineCreateUrlForDataset(
                          projectId,
                          datasetId,
                          datasetVersionId,
                          "preparation",
                        )}
                      >
                        Use in pipeline
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
