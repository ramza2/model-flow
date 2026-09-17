# Phase 3-C Verification — Unified Run-state, Error, Progress & Lineage UX

Status: **Draft PR verification baseline**

## Core invariant

Phase 3-C is presentation hardening. The backend remains the source of truth for Pipeline execution, retry, branch, cancellation, artifact persistence, and node state.

The frontend may normalize status labels and derive a `reused` presentation state for a successful upstream node retained during rerun-from-failed, but it must not persist or invent a new runtime state.

```text
historical PipelineVersion
        +
PipelineRun.node_states / node_artifacts
        ↓
normalized node views
        ↓
lifecycle stage summary + progress + failed-node recovery + lineage
```

## Status contract

The UI normalizes compatible aliases into a stable presentation vocabulary:

- pending: created / queued / waiting / pending
- running: running / in_progress
- succeeded: success / succeeded / completed / complete
- failed: failure / failed / error
- skipped: skip / skipped
- cancelled: cancelled / canceled
- reused: UI-derived only when a node remains succeeded from an earlier attempt while downstream nodes are on a later rerun attempt

`reused` does not modify `PipelineRun.node_states` and does not alter rerun semantics.

## Coverage matrix

| Requirement | Coverage |
| --- | --- |
| Runtime alias normalization | `pipelineRunUx.test.ts` |
| Lifecycle stage mapping from historical graph / node metadata | `pipelineRunUx.test.ts` |
| Rerun retained upstream step shown as derived reused | `pipelineRunUx.test.ts` |
| Terminal progress calculation | `pipelineRunUx.test.ts` |
| First failed node selection | `pipelineRunUx.test.ts` |
| Exact DatasetVersion lineage from Dataset Load config/output | `pipelineRunUx.test.ts` |
| Training Job / Experiment / Model / Deployment lineage extraction | `pipelineRunUx.test.ts` |
| Builder keeps existing UX and adds latest-run overview | `PipelineLifecyclePages.test.tsx` |
| Run Detail keeps existing UX and adds recovery + lineage overview | `PipelineLifecyclePages.test.tsx` |
| Existing historical graph / attempt / legacy state regressions | existing `Pipelines.test.tsx` |
| Existing rerun-from-failed backend semantics | existing backend Pipeline engine tests |

## Recovery semantics

The recovery cue describes existing backend behavior only:

- failed node and descendants are restarted
- restarted node attempts increment
- successful upstream artifacts are retained
- raw node error/reason remains visible
- the existing `rerun-from-failed` API remains the only mutation action

No frontend retry orchestration is introduced.

## Lineage sources

Phase 3-C uses only relationships already persisted by the Pipeline runtime:

- exact Dataset / DatasetVersion from `dataset_load` graph config and node output
- `training_job_id`
- `mlflow_run_id`
- `model_version_id`
- `endpoint_id`
- `batch_job_id`
- `alert_id`

Node state output is preferred as runtime evidence; persisted node artifacts are also searched for compatibility. Links are shown only when a concrete identifier is available.

## Request / polling boundary

The existing Pipeline Builder and Pipeline Run Detail continue to own their current data loading and execution detail behavior.

The lifecycle wrapper fetches only the summary inputs it needs. Completed runs are not continuously polled; active-run overview refresh is limited to the execution window. Duplicate request cleanup, if still useful after browser regression, belongs to Phase 3-D hardening rather than changing runtime contracts here.

## Architecture boundary

No backend Pipeline node type, execution rule, API contract, DB schema, migration, Dataset Preparation semantics, TrainingJob contract, or model/deployment lifecycle transition is changed in Phase 3-C.

## Merge gate

Before merge:

- targeted frontend helper/component tests PASS
- existing Pipeline Builder / Run Detail regressions PASS
- full frontend Vitest PASS
- production build PASS
- Playwright PASS
- repository `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions PASS

Phase 3-C completes only after the PR merges and the resulting `main` CI succeeds.
