# Phase 3 — End-to-End Pipeline UX

Status: **Implementation plan — Phase 3-C current**  
Baseline: `main@ffbe248a999c5fca1f26c54cd03de1d3eaebc643`  
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

**Current implementation slice.**

- use the shared lifecycle taxonomy for Builder coverage and Pipeline Run execution summaries
- normalize pending/running/succeeded/failed/skipped/reused/cancelled status presentation without changing backend status semantics
- show terminal-step progress and stage-level state from the persisted historical PipelineVersion graph
- surface the first failed node as the recovery focus while retaining existing failed-node auto-selection and rerun-from-failed behavior
- expose cross-lifecycle lineage recorded in graph configuration and persisted node artifacts: exact DatasetVersion, Training Job, Experiment Run, Model Version, Deployment, Batch Inference, and Alert
- keep runtime retry/reuse, branch execution, artifacts, logging, and polling backend-owned

Implementation boundary:

- presentation is frontend-only and wraps the existing Pipeline Builder / Pipeline Run Detail instead of replacing execution UX
- lineage is derived only from existing Pipeline graph configuration, node state output, and persisted node artifacts
- no new backend API, DB schema, migration, runtime state, retry rule, or artifact format
- historical PipelineVersion remains the source of truth for run-stage mapping

Acceptance:

- the same lifecycle taxonomy is used in Builder and Run summaries
- runtime status aliases map to one deterministic UI vocabulary with targeted tests
- stage progress is computed from the historical graph and node states, including reused/skipped states as terminal
- failed runs identify the first failed node and provide an explicit recovery cue without changing rerun semantics
- exact DatasetVersion → Training Job → Experiment/Model → Deployment lineage links appear when those ids exist in persisted output/artifacts
- a run from an older PipelineVersion never borrows the current Pipeline graph for stage mapping

Phase 3-C remains incomplete while its Draft PR is open. It completes only after merge and the resulting `main` CI succeeds.

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
