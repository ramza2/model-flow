# Phase 3 — End-to-End Pipeline UX

Status: **Implementation plan — Phase 3-D current**  
Baseline: `main@33fdab3955f3a199b25ce0fb37e35c0cb3d0b26a`  
Depends on: Phase 1.5 UX architecture and completed Phase 2 Dataset Preparation

## Purpose

Phase 3 expands the stabilized Pipeline Builder across the product lifecycle without replacing the existing pipeline runtime:

`Source → Transform → Quality → Train → Registry → Deploy → Predict → Monitor`

The functional source of truth remains the existing backend Pipeline node/runtime contracts. Phase 3 primarily improves how those capabilities are authored, understood, navigated, and diagnosed.

## Architectural boundary

Dataset Preparation remains the place for multi-dataset composition and tabular transformations.

A successful Preparation run materializes an immutable rectangular `DatasetVersion`. Pipeline does **not** add a second Preparation execution engine or a `preparation` runtime node. Instead, the existing `dataset_load` step consumes the exact materialized DatasetVersion.

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

**Complete on `main` via PR #46 (`f30a9541c30c8722009e31839e819c30d6d69de9`).**

Delivered:

- aligned Node Library groups with the end-to-end lifecycle rather than implementation-oriented categories
- made the existing `dataset_load` affordance explicitly describe exact DatasetVersion input, including materialized Dataset Preparation outputs
- added shared lifecycle stage helpers so Builder, validation/run-state UI, and future navigation use one taxonomy
- preserved all graph serialization, validation, RBAC, publish/run, scheduling, condition branch, and runtime semantics

Acceptance confirmed:

- every existing runtime node appears exactly once in the lifecycle Node Library
- lifecycle stage mapping is deterministic and unit tested
- searching the Node Library for `Preparation` surfaces Dataset Load
- no backend API, DB schema, migration, or Pipeline execution change

## Phase 3-B — Prepared-data Handoff & Lifecycle Navigation

**Complete on `main` via PR #47 (`ffbe248a999c5fca1f26c54cd03de1d3eaebc643`; merge commit CI PASS).**

Delivered:

- succeeded materialized Preparation runs expose exact DatasetVersion handoff points into Pipeline authoring
- Pipeline creation starts with one `dataset_load` node pinned to the exact selected DatasetVersion
- historical results remain exact even when the Dataset has a newer latest version
- malformed, incomplete, missing, or wrong-dataset handoffs are rejected without latest fallback
- exact input context remains readable for read-only users while Pipeline mutations stay under existing RBAC
- existing Dataset → Training → Experiment/Registry → Deployment → Prediction/Monitoring navigation is reused rather than duplicated

Implementation boundary retained:

- handoff is frontend routing/query state plus existing project-scoped Dataset/Pipeline APIs
- no new Pipeline runtime node
- no backend read endpoint was required
- no automatic Pipeline execution or TrainingJob creation

Acceptance confirmed:

- historical Preparation Run output V1 can create a Pipeline pinned to V1 even if the output Dataset latest is V2+
- generated graph contains one `dataset_load` node with the exact `dataset_id` and `dataset_version_id`
- invalid explicit handoff never resolves to latest
- failed/non-materialized Preparation runs do not expose Pipeline handoff
- users without Pipeline mutation permission do not receive the create action
- downstream lifecycle navigation remains intact

## Phase 3-C — Unified Run-state, Error, Progress & Lineage UX

**Complete on `main` via PR #49 (`33fdab3955f3a199b25ce0fb37e35c0cb3d0b26a`; merge commit CI PASS).**

Delivered:

- shared lifecycle taxonomy for Builder coverage and Pipeline Run execution summaries
- deterministic pending/running/succeeded/failed/skipped/reused/cancelled presentation without changing backend status semantics
- terminal-step and stage-level progress from the persisted historical PipelineVersion graph
- first-failed-node recovery focus while retaining existing failed-node auto-selection and rerun-from-failed behavior
- cross-lifecycle lineage from existing graph configuration and persisted node artifacts: exact DatasetVersion, Training Job, Experiment Run, Model Version, Deployment, Batch Inference, and Alert
- current Builder only borrows latest-run state when that run belongs to the same saved PipelineVersion

Implementation boundary retained:

- presentation wraps the existing Pipeline Builder / Pipeline Run Detail instead of replacing execution UX
- lineage is derived only from existing Pipeline graph configuration, node state output, and persisted node artifacts
- no new backend API, DB schema, migration, runtime state, retry rule, or artifact format
- historical PipelineVersion remains the source of truth for run-stage mapping

Acceptance confirmed:

- Builder and Run summaries use the same lifecycle taxonomy
- runtime status aliases map to one deterministic UI vocabulary with targeted tests
- reused/skipped/cancelled states are terminal for progress while failed nodes still drive recovery focus
- exact DatasetVersion → Training Job → Experiment/Model → Deployment lineage links appear when recorded ids exist
- a run from an older PipelineVersion never borrows the current Pipeline graph for stage mapping

## Phase 3-D — Final Hardening / Browser Regression

**Current final Phase 3 slice.**

- close the remaining unsaved Pipeline navigation gap beyond the existing browser `beforeunload` and Builder-local back-link confirmation
- guard same-origin SPA/sidebar navigation and project switching while Pipeline edits are dirty
- preserve in-page anchors, external links, modified-click behavior, and existing Builder-local back-link confirmation without duplicate prompts
- run browser regression for lifecycle Builder read-only RBAC and responsive drawer behavior
- confirm the expanded lifecycle UI does not introduce horizontal document overflow at the supported drawer breakpoint
- retain all Phase 3-A/B/C unit and integration regressions plus the repository full verification gate

Implementation boundary:

- frontend navigation hardening only; no Pipeline execution, backend API, DB schema, migration, artifact, retry/reuse, or scheduling changes
- existing `useBeforeUnload` remains the hard-refresh/browser-close protection
- the shared app guard covers same-origin SPA links and project-picker navigation while the Pipeline Builder reports unsaved state
- existing read-only role rules remain authoritative

Acceptance:

- dismissing the unsaved confirmation keeps the user on the dirty Pipeline and preserves the dirty state
- accepting the confirmation allows sidebar navigation or project switching
- Viewer can inspect lifecycle coverage and graph configuration but receives no Builder mutation controls
- at drawer viewport width, navigation toggle state/focus behavior remains accessible and lifecycle content remains usable without page-level horizontal overflow
- all existing Phase 3 exact-version, run-state, recovery, lineage, RBAC, and Pipeline runtime regressions remain green
- full repository verification and exact PR HEAD CI pass

Phase 3-D remains incomplete while its Draft PR is open. **Phase 3 completes only after Phase 3-D merges and the resulting `main` CI succeeds.**

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
