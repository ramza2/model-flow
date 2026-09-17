# Phase 3 — End-to-End Pipeline UX

Status: **Implementation plan — Phase 3-A current**  
Baseline: `main@b847f658f2f8bf78c9c5ad878750730da711775c`  
Depends on: Phase 1.5 UX architecture and completed Phase 2 Dataset Preparation

## Purpose

Phase 3 expands the stabilized Pipeline Builder across the product lifecycle without replacing the existing pipeline runtime:

`Source → Transform → Quality → Train → Registry → Deploy → Predict → Monitor`

The functional source of truth remains the existing backend Pipeline node/runtime contracts. Phase 3 primarily improves how those capabilities are authored, understood, navigated, and diagnosed.

## Architectural boundary

Dataset Preparation remains the place for multi-dataset composition and tabular transformations.

A successful Preparation run materializes an immutable rectangular `DatasetVersion`. Pipeline does **not** add a second Preparation execution engine or a `preparation` runtime node in Phase 3-A. Instead, the existing `dataset_load` step consumes the exact materialized DatasetVersion.

```text
Dataset(s)
   ↓
Dataset Preparation
   ↓
materialized DatasetVersion
   ↓
Pipeline Dataset Load (exact DatasetVersion)
   ↓
Quality → Train → Registry → Deploy → Predict → Monitor
```

This preserves the established exact-version reproducibility rule and keeps Pipeline execution independent from mutable Preparation graph state.

## Lifecycle stages

The Pipeline Builder presents the existing runtime node catalog using seven lifecycle stages.

| Stage | Existing Pipeline node types |
| --- | --- |
| Source & Transform | `dataset_load`, `preprocessing`, `split` |
| Quality | `quality_check` |
| Train | `training`, `evaluation` |
| Registry & Governance | `condition`, `model_registration`, `approval_request` |
| Deploy | `endpoint_deployment` |
| Predict | `batch_prediction` |
| Monitor | `notification` |

No backend node type is added or renamed by this taxonomy.

## Phase 3-A — Lifecycle Pipeline UX Foundation

Current slice.

- align Node Library groups with the end-to-end lifecycle rather than implementation-oriented categories
- make the existing `dataset_load` affordance explicitly describe exact DatasetVersion input, including materialized Dataset Preparation outputs
- add shared lifecycle stage helpers so Builder, validation/run-state UI, and future navigation use one taxonomy
- preserve all graph serialization, validation, RBAC, publish/run, scheduling, condition branch, and runtime semantics

Acceptance:

- every existing runtime node appears exactly once in the lifecycle Node Library
- lifecycle stage mapping is deterministic and unit tested
- searching the Node Library for `Preparation` surfaces Dataset Load
- no backend API, DB schema, migration, or Pipeline execution change

## Phase 3-B — Prepared-data Handoff & Lifecycle Navigation

Planned after 3-A.

- explicit user handoff from a succeeded materialized Preparation result into Pipeline authoring
- create/open Pipeline flow preconfigured to reference the exact prepared DatasetVersion where practical
- lifecycle-oriented next-action links between Preparation, Dataset, Pipeline, Training/Model, Deployment, Prediction, and Monitoring screens using existing resource relationships
- preserve historical exact-version selection; never resolve a user-selected historical result to latest

This slice may add small frontend routing/query-state helpers. A backend read endpoint is allowed only when persisted lineage cannot otherwise be represented correctly.

## Phase 3-C — Unified Run-state, Error, Progress & Lineage UX

Planned after 3-B.

- use the lifecycle taxonomy for run-state summaries across Pipeline Builder and Pipeline Run
- consistent pending/running/succeeded/failed/skipped/reused presentation
- node-aware error focus and recovery cues
- improve cross-lifecycle lineage visibility from exact DatasetVersion through Training/Model/Deployment where existing APIs expose relationships

Runtime retry/reuse semantics remain backend-owned.

## Phase 3-D — Final Hardening / Browser Regression

Final Phase 3 slice.

- end-to-end browser regression for representative lifecycle workflows
- RBAC/read-only verification
- unsaved-change/navigation regression
- responsive/accessibility checks for the expanded Pipeline UX
- full integrated verification gate and Phase 3 completion documentation

## Explicitly out of scope for Phase 3

- a second Dataset Preparation engine inside Pipeline
- a new `preparation` Pipeline runtime node unless a later architecture decision explicitly requires it
- automatic training immediately after Preparation completion
- TrainingJob many-to-many dataset inputs
- connector expansion (Phase 4)
- closed-loop automatic retraining changes (Phase 5)
- time-series transforms/models (Phase 6)
- LLM-generated pipeline execution (Phase 7)
- Kubernetes/enterprise scale work (Phase 8)
- product-wide final visual redesign (Phase 9)

## Verification rule

Each Phase 3 slice ships as an independent Draft PR from the latest `main`, with targeted regression tests plus the repository full verification gate. Phase 3 is complete only after Phase 3-D merges and the resulting `main` CI succeeds.
