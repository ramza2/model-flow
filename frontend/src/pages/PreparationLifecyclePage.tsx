import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Dataset, type DatasetPreparationRun } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, StatusBadge, formatDate } from "../components";
import { pipelineCreateUrlForDataset } from "../pipelineHandoff";
import { userCanProject, useProject } from "../ProjectContext";
import { jobStatusLabel } from "../uiTerminology";
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
        reason instanceof Error
          ? reason.message
          : "처리된 결과 활용 단계를 불러오지 못했습니다.",
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
            <span className="eyebrow">다음 단계</span>
            <h2>처리된 데이터셋을 파이프라인에서 사용</h2>
          </div>
        </div>
        <ErrorNotice message={error} />
        {materializedRuns.length === 0 ? (
          <p className="muted" data-testid="preparation-lifecycle-empty">
            이 준비를 성공적으로 실행하면 파이프라인에서 사용할 정확한 데이터셋 버전(DatasetVersion)이
            만들어집니다.
          </p>
        ) : (
          <div className="activity-list" data-testid="preparation-lifecycle-results">
            {materializedRuns.map((run) => {
              const datasetId = run.output_dataset_id!;
              const datasetVersionId = run.output_dataset_version_id!;
              const dataset = datasets.find((row) => row.id === datasetId);
              return (
                <div
                  key={run.id}
                  className="source-card preparation-lifecycle-result"
                  data-testid={`preparation-pipeline-result-${run.id}`}
                >
                  <div className="preparation-lifecycle-result-main">
                    <strong>{dataset?.name || `데이터셋 #${datasetId}`}</strong>
                    <small>
                      실행 #{run.id} · 데이터셋 버전 #{datasetVersionId} ·{" "}
                      {formatDate(run.finished_at)}
                    </small>
                  </div>
                  <div className="row-actions preparation-lifecycle-result-actions">
                    <StatusBadge status={run.status} label={jobStatusLabel(run.status)} />
                    <Link className="btn link" to={`/projects/${projectId}/datasets/${datasetId}`}>
                      데이터셋 열기
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
                        파이프라인에 사용
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
