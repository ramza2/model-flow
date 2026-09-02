import { FormEvent, useState } from "react";
import type { Job } from "../api";
import { effectiveTargetColumns } from "../jobHelpers";
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
            <span className="eyebrow">Model Registry</span>
            <h2 id="register-model-title">Register model</h2>
          </div>
        </div>
        <dl className="key-values compact">
          <div><dt>Training job</dt><dd>{job.name}</dd></div>
          <div><dt>Problem type</dt><dd>{job.problem_type}</dd></div>
          <div><dt>Algorithm</dt><dd>{job.algorithm.replaceAll("_", " ")}</dd></div>
          <div><dt>Target{effectiveTargetColumns(job).length > 1 ? "s" : ""}</dt><dd className="mono">{effectiveTargetColumns(job).join(", ")}</dd></div>
        </dl>
        <label>
          Model name *
          <input
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            required
            data-testid="register-model-name"
          />
        </label>
        <div className="row-actions">
          <button className="btn" type="submit" disabled={busy || !modelName.trim()} data-testid="register-model-submit">
            {busy ? "Registering…" : "Register model"}
          </button>
          <button className="btn secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
