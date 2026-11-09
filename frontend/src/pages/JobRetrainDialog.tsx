import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type DatasetSplit, type DatasetVersion, type Job } from "../api";
import { effectiveTargetColumns, isMultiOutputJob } from "../jobHelpers";
import { ErrorNotice, Notice, TermLabel } from "../components";
import { Drawer } from "../Drawer";
import { problemTypeLabel, UI_HELP } from "../uiTerminology";

type Props = {
  projectId: string;
  sourceJob: Job;
  onClose: () => void;
  onCreated: (job: Job) => void;
};

export default function JobRetrainDialog({ projectId, sourceJob, onClose, onCreated }: Props) {
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [datasetVersionId, setDatasetVersionId] = useState<number | "">("");
  const [splitId, setSplitId] = useState<number | "">("");
  const [name, setName] = useState(`${sourceJob.name} (retrain)`);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const versionSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${sourceJob.dataset_id}/versions`)
      .then((rows) => {
        setVersions(rows);
        const preferred =
          rows.find((row) => row.id === sourceJob.dataset_version_id)?.id ?? rows[0]?.id ?? "";
        setDatasetVersionId(preferred);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : "데이터셋 버전 목록을 불러오지 못했습니다.");
      })
      .finally(() => setLoading(false));
  }, [projectId, sourceJob.dataset_id, sourceJob.dataset_version_id]);

  useEffect(() => {
    if (!datasetVersionId) {
      setSplits([]);
      setSplitId("");
      return;
    }
    api<DatasetSplit[]>(
      `/projects/${projectId}/dataset-versions/${datasetVersionId}/splits`,
    )
      .then((rows) => {
        setSplits(rows);
        setSplitId("");
      })
      .catch(() => setSplits([]));
  }, [datasetVersionId, projectId]);

  useEffect(() => {
    if (!loading) versionSelectRef.current?.focus();
  }, [loading]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!datasetVersionId) {
      setError("재학습할 데이터셋 버전을 선택하세요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const job = await api<Job>(
        `/projects/${projectId}/jobs/${sourceJob.id}/retrain`,
        {
          method: "POST",
          body: JSON.stringify({
            dataset_version_id: Number(datasetVersionId),
            split_id: splitId === "" ? null : Number(splitId),
            name: name.trim(),
          }),
        },
      );
      onCreated(job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "전체 재학습을 시작하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const sourceVersion = versions.find(
    (version) => version.id === sourceJob.dataset_version_id,
  );
  const hasNewerVersion = Boolean(
    sourceVersion && versions.some((version) => version.version > sourceVersion.version),
  );

  return (
    <Drawer
      open
      title={`전체 재학습 (Full retrain) · 학습 작업 #${sourceJob.id}`}
      onClose={onClose}
      closeLabel="닫기"
      closeDisabled={busy}
      testId="job-retrain-dialog"
      size="large"
    >
      <p className="form-hint">
        기존 학습 설정을 복사하여 선택한 데이터셋 버전으로 모델을 처음부터 새로 학습합니다.
        이어서 학습하는 방식이 아니며, 현재 운영 모델은 자동으로 교체되지 않습니다.
      </p>
      {error && <ErrorNotice message={error} />}
      {loading ? (
        <p role="status">데이터셋 버전을 불러오는 중…</p>
      ) : (
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <label>
            <TermLabel ko="학습 데이터셋 버전" en="Dataset version" help="새로 반영한 피드백으로 학습하려면 해당 데이터셋 버전을 선택하세요." />
            <select
              ref={versionSelectRef}
              data-drawer-initial-focus
              value={datasetVersionId}
              onChange={(event) => setDatasetVersionId(Number(event.target.value))}
              required
              data-testid="retrain-dataset-version"
            >
              <option value="" disabled>데이터셋 버전 선택…</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version} · {version.original_filename} · {version.row_count}행
                  {version.id === sourceJob.dataset_version_id
                    ? " (기존 학습)"
                    : version.source_type === "feedback_materialization" ? " (피드백 반영)" : ""}
                </option>
              ))}
            </select>
          </label>
          {hasNewerVersion && datasetVersionId === sourceJob.dataset_version_id && (
            <Notice
              variant="warning"
              message="현재 기존 학습 데이터 버전이 선택되어 있습니다. 새 피드백을 반영하려면 위에서 새로운 버전을 선택하세요."
            />
          )}
          <label>
            <TermLabel ko="데이터 분할" en="Data split" help={UI_HELP.dataSplit} />
            <select
              value={splitId}
              onChange={(event) =>
                setSplitId(event.target.value === "" ? "" : Number(event.target.value))
              }
              data-testid="retrain-split"
            >
              <option value="">실행 시 분할 (원본 학습 비율 및 시드 사용)</option>
              {splits.map((split) => (
                <option key={split.id} value={split.id}>
                  {split.name} · {Math.round(split.train_ratio * 100)}/
                  {Math.round(split.val_ratio * 100)}/
                  {Math.round(split.test_ratio * 100)}
                </option>
              ))}
            </select>
          </label>
          <label>
            새 학습 작업 이름
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              data-testid="retrain-name"
            />
          </label>
          <div className="form-actions row-actions">
            <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
              취소
            </button>
            <button type="submit" className="btn" disabled={busy} data-testid="retrain-submit">
              {busy ? "학습 작업 생성 중…" : "전체 재학습 시작"}
            </button>
          </div>
          <details className="panel advanced-json">
            <summary>원본 학습 설정 보기 (고급)</summary>
            <dl className="key-values" data-testid="retrain-source-summary">
              <div>
                <dt>{isMultiOutputJob(sourceJob) ? "예측 대상 (Targets)" : "예측 대상 (Target)"}</dt>
                <dd className="mono" data-testid="retrain-targets">{effectiveTargetColumns(sourceJob).join(", ")}</dd>
              </div>
              <div><dt>예측 문제 유형</dt><dd>{problemTypeLabel(sourceJob.problem_type)}</dd></div>
              <div><dt>학습 알고리즘</dt><dd>{sourceJob.algorithm.replaceAll("_", " ")}</dd></div>
              <div><dt>입력 항목</dt><dd>{sourceJob.feature_columns.join(", ") || "—"}</dd></div>
              <div><dt>데이터셋</dt><dd>#{sourceJob.dataset_id}</dd></div>
            </dl>
            <pre className="json-view">{JSON.stringify(sourceJob.hyperparameters, null, 2)}</pre>
          </details>
        </form>
      )}
    </Drawer>
  );
}
