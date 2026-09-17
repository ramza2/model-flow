# Phase 3-C Verification — Unified Run-state, Error, Progress & Lineage UX

Status: **Draft PR verification baseline**

## Core invariant

Pipeline execution state remains backend-owned. Phase 3-C only derives a consistent lifecycle presentation from the persisted historical PipelineVersion graph plus the PipelineRun node states/artifacts.

```text
PipelineVersion graph (historical exact version)
  + PipelineRun.node_states
  + PipelineRun.node_artifacts
  -> shared lifecycle taxonomy
  -> stage progress / failure focus / lineage navigation
```

A Pipeline Run must never be summarized using a newer current Pipeline graph when `pipeline_version_id` points to an older version.

## Status vocabulary

Frontend presentation normalizes runtime aliases into:

- pending
- running
- succeeded
- failed
- skipped
- reused
- cancelled
- unknown

`created`, `queued`, and `not_started` display as pending; `in_progress` as running; `success`/`completed` as succeeded; `cached` as reused; `error` as failed. Backend status values are not mutated.

## Progress semantics

Terminal step states are:

- succeeded
- failed
- skipped
- reused
- cancelled

Progress percentage is `terminal steps / total historical graph steps`.

A failed step is terminal for progress purposes while still driving the stage/run failure cue.

## Coverage matrix

| Requirement | Coverage |
| --- | --- |
| deterministic status normalization | `pipelineRunUx.test.ts` |
| shared Phase 3 lifecycle-stage mapping | `pipelineRunUx.test.ts` + existing `pipelineHelpers` tests |
| reused/skipped/cancelled terminal semantics | `pipelineRunUx.test.ts` |
| failed-node discovery in historical graph order | `pipelineRunUx.test.ts` |
| stage-level failed/reused state | `pipelineRunUx.test.ts` |
| exact DatasetVersion lineage from graph/artifact | `pipelineRunUx.test.ts` |
| Training Job and MLflow Experiment lineage | `pipelineRunUx.test.ts` |
| Model Version artifact marker lineage | `pipelineRunUx.test.ts` |
| Deployment lineage | `pipelineRunUx.test.ts` |
| Builder lifecycle coverage wrapper | `PipelineLifecycleUx.test.tsx` |
| Builder latest-run state only when PipelineVersion matches | `PipelineLifecycleUx.test.tsx` and component contract |
| Pipeline Run terminal progress | `PipelineLifecycleUx.test.tsx` |
| failed-node recovery cue | `PipelineLifecycleUx.test.tsx` |
| Pipeline Run cross-lifecycle links | `PipelineLifecycleUx.test.tsx` |
| existing Pipeline Builder / Run Detail behavior retained | route wrapper composes existing components; full repository verification |

## Failure / recovery behavior

- Existing Pipeline Run Detail continues to auto-select the first failed step.
- Phase 3-C adds a summary-level recovery cue naming that failed node.
- Existing `Rerun from failed` remains the only rerun mutation; no retry semantics are changed.
- Run error, node error, artifacts, attempt count, branch reason, and logs remain rendered by the existing Run Detail.

## Lineage sources

Phase 3-C does not invent new persisted lineage. It reads identifiers already present in:

- Pipeline graph `dataset_load` / `batch_prediction` configuration
- persisted node artifacts
- persisted node-state output summaries

Supported navigation when ids exist:

- DatasetVersion -> Dataset Detail
- Training Job -> Job Detail
- MLflow Run -> Experiment Run Detail
- Model Version -> Model Version Detail
- Endpoint -> Prediction Test
- Batch Inference -> Batch Inference
- Alert -> Alerts
- PipelineVersion / PipelineRun -> Pipeline Builder

## Architecture boundary

No backend API, runtime node, DB schema, migration, retry/reuse rule, scheduling behavior, artifact storage format, or Pipeline execution semantics are changed.

## Merge gate

Before merge:

- targeted frontend tests PASS
- full frontend Vitest PASS
- production build PASS
- Playwright PASS
- repository `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions PASS

Phase 3-C completes only after the PR merges and the resulting `main` CI succeeds.
