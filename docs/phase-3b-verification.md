# Phase 3-B Verification — Prepared-data Handoff & Lifecycle Navigation

Status: **Draft PR verification baseline**

## Core invariant

A user-selected materialized Preparation result is an exact immutable `DatasetVersion` handoff. Pipeline authoring must never replace that version with the Dataset's latest version.

```text
Preparation Run
  -> output_dataset_id
  -> output_dataset_version_id (exact historical version)
  -> Pipeline handoff route
  -> Dataset ownership/version verification
  -> Pipeline create
  -> dataset_load(dataset_id, exact dataset_version_id)
```

## Coverage matrix

| Requirement | Coverage |
| --- | --- |
| Parse exact dataset/version handoff | `pipelineHandoff.test.ts` |
| Reject malformed/incomplete/non-positive explicit handoff | `pipelineHandoff.test.ts` |
| Build one exact pinned Dataset Load node | `pipelineHandoff.test.ts` |
| Preserve historical version in handoff URL | `pipelineHandoff.test.ts` |
| Historical V1 selected while Dataset latest is newer | `PipelineDatasetHandoff.test.tsx` |
| No latest fallback for missing/wrong DatasetVersion | `PipelineDatasetHandoff.test.tsx` |
| Exact graph payload sent to Pipeline create API | `PipelineDatasetHandoff.test.tsx` |
| Read-only users can inspect context but cannot create | `PipelineDatasetHandoff.test.tsx` |
| Only succeeded materialized Preparation runs expose handoff | `PreparationLifecyclePage.test.tsx` |
| Historical Preparation Run link carries exact output version | `PreparationLifecyclePage.test.tsx` |
| Pipeline handoff action obeys existing ML Engineer/Admin RBAC | `PreparationLifecyclePage.test.tsx` |
| Existing downstream lifecycle links retained | Existing Phase 1.5 regressions and current Dataset/Job/Model/Deployment screens |

## Existing lifecycle navigation reused

Phase 3-B does not duplicate already-supported navigation:

- Dataset -> Training Job creation with exact selected DatasetVersion
- Training Job -> Dataset / Experiment / Model registration
- Model Version -> Training Job / Experiment / Pipeline Run lineage
- approved/production Model Version -> Deployment creation
- Deployment -> Prediction Test / API usage / Batch inference
- Operations navigation -> Monitoring / Alerts

The new Phase 3-B gap is specifically the Preparation materialized-result -> Pipeline authoring transition.

## Failure boundaries

- Failed or non-materialized Preparation runs do not expose `Use in pipeline`.
- Malformed query parameters are rejected.
- A DatasetVersion id that is absent from the selected Dataset is rejected.
- Explicit invalid handoff never resolves to Dataset latest.
- Pipeline creation is unavailable to roles that lack existing Pipeline mutation permission.

## Architecture boundaries

No backend API, runtime node, DB schema, migration, TrainingJob contract, or Preparation execution semantics are changed.

Dataset Preparation continues to materialize data. Pipeline consumes one exact materialized DatasetVersion through `dataset_load`.

## Merge gate

Before merge:

- targeted frontend tests PASS
- full frontend Vitest PASS
- production build PASS
- Playwright PASS
- repository `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions PASS

Phase 3-B completes only after the PR merges and the resulting `main` CI succeeds.
