import { FormEvent, useState } from "react";
import type { Job } from "../api";
import { HelpTip } from "../components";
import { effectiveTargetColumns } from "../jobHelpers";
import { resolveDisplayProblemType } from "../metricHelpers";
import { modelProblemTypeKo } from "../modelRegistryLabels";
import { defaultModelNameFromJob } from "../registerModelHelpers";

type RegisterModelDialogProps = {
  job: Job;
  busy: boolean;
  onClose: () => void;
  onSubmit: (modelName: string) => Promise<void>;
};

export default function RegisterModelDialog({
  job,
  busy,
  onClose,
  onSubmit,
}: RegisterModelDialogProps) {
  const [modelName, setModelName] = useState(() => defaultModelNameFromJob(job));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onSubmit(modelName.trim());
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="panel modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="register-model-title"
        onSubmit={(event) => void handleSubmit(event)}
        onClick={(event) => event.stopPropagation()}
        data-testid="register-model-dialog"
      >
        <div className="panel-title">
          <div>
            <span className="eyebrow">모델 관리</span>
            <h2 id="register-model-title">학습 결과를 후보 모델로 등록</h2>
          </div>
        </div>
        <dl className="key-values compact">
          <div><dt>학습 작업</dt><dd>{job.name}</dd></div>
          <div data-testid="register-problem-type">
            <dt>예측 유형</dt>
            <dd>{modelProblemTypeKo(resolveDisplayProblemType(job.problem_type, job.metrics))}</dd>
          </div>
          <div><dt>알고리즘</dt><dd>{job.algorithm.replaceAll("_", " ")}</dd></div>
          <div><dt>예측 대상</dt><dd className="mono">{effectiveTargetColumns(job).join(", ")}</dd></div>
        </dl>
        <label>
          모델명 * <HelpTip text="등록할 모델의 이름입니다. 기존 모델과 구분할 수 있도록 설정하세요." />
          <input
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            required
            data-testid="register-model-name"
          />
        </label>
        <div className="row-actions">
          <button className="btn" type="submit" disabled={busy || !modelName.trim()} data-testid="register-model-submit">
            {busy ? "등록 중…" : "후보 모델 등록"}
          </button>
          <button className="btn secondary" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
        </div>
      </form>
    </div>
  );
}
