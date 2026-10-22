import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type Dataset, type DatasetVersion, type Pipeline } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorNotice, HelpTip, Loading, PageHeader } from "../components";
import {
  buildPipelineGraphForDatasetHandoff,
  parsePipelineCreateHandoff,
} from "../pipelineHandoff";
import { userCanProject, useProject } from "../ProjectContext";
import { UI_HELP } from "../uiTerminology";

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
  const [error, setError] = useState(
    handoffState.error
      ? "데이터셋 전달 정보가 올바르지 않습니다. 데이터 가공 결과 또는 데이터셋 상세에서 정확한 버전을 다시 열어 주세요."
      : "",
  );

  useEffect(() => {
    const handoff = handoffState.handoff;
    if (!handoff || !projectId) {
      setLoading(false);
      setDataset(null);
      setVersion(null);
      setError(
        handoffState.error
          ? "데이터셋 전달 정보가 올바르지 않습니다. 데이터 가공 결과 또는 데이터셋 상세에서 정확한 버전을 다시 열어 주세요."
          : "데이터셋 전달 정보가 필요합니다.",
      );
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
            "요청한 데이터 버전(DatasetVersion)이 이 데이터셋에 속하지 않습니다. 최신 버전으로 자동 대체하지 않았습니다.",
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
          setError(
            reason instanceof Error
              ? reason.message
              : "데이터셋 전달 정보를 불러오지 못했습니다.",
          );
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
      setError(reason instanceof Error ? reason.message : "파이프라인을 만들지 못했습니다.");
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="데이터셋으로 파이프라인 만들기"
        description="선택한 정확한 데이터 버전을 입력으로 사용하는 파이프라인을 시작합니다."
        actions={
          <Link className="btn secondary" to={`/projects/${projectId}/pipelines`}>
            파이프라인 목록으로
          </Link>
        }
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Loading label="선택한 데이터 버전을 불러오는 중…" />
      ) : dataset && version ? (
        <>
          <section className="panel" data-testid="pipeline-handoff-context">
            <span className="eyebrow">사용할 데이터</span>
            <h2>{dataset.name}</h2>
            <p>
              Dataset #{dataset.id} · v{version.version} · DatasetVersion #{version.id}
            </p>
            <p className="form-hint" data-testid="pipeline-handoff-pin-hint">
              선택한 데이터셋 버전을 입력으로 사용하는 파이프라인을 만듭니다. 이후 더 최신 데이터셋
              버전이 생기더라도 자동으로 바뀌지 않습니다.
              <HelpTip text={UI_HELP.datasetVersionPin} />
            </p>
            <p className="form-hint" data-testid="pipeline-handoff-create-hint">
              파이프라인을 만들면 데이터셋 불러오기(Dataset Load) 노드가 먼저 배치됩니다. 학습이나
              데이터 처리가 자동으로 실행되는 것은 아닙니다.
              <HelpTip text={UI_HELP.pipeline} />
            </p>
            <div className="row-actions">
              <Link className="btn link" to={`/projects/${projectId}/datasets/${dataset.id}`}>
                데이터셋 열기
              </Link>
            </div>
          </section>
          {canWrite ? (
            <form className="panel form" onSubmit={createPipeline} data-testid="pipeline-handoff-form">
              <label>
                파이프라인 이름
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
                {busy ? "만드는 중…" : "파이프라인 만들고 편집하기"}
              </button>
            </form>
          ) : (
            <p className="form-hint" data-testid="pipeline-handoff-readonly">
              이 프로젝트에서 파이프라인을 만들 권한이 없습니다.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
