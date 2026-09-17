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

- exposed succeeded materialized Preparation runs as exact DatasetVersion handoff points into Pipeline authoring
- created Pipelines with an initial `dataset_load` node preconfigured to the exact selected DatasetVersion
- preserved historical results even when the Dataset had a newer latest version
- rejected malformed, incomplete, missing, or wrong-dataset handoff versions without falling back to latest
- kept exact input context readable for read-only users while withholding mutation actions according to existing Pipeline RBAC
- reused established lifecycle navigation already present in Dataset, Training Job, Experiment, Model Version, Deployment, Prediction, and Monitoring screens

Implementation boundary retained:

- handoff is frontend routing/query state plus existing project-scoped Dataset/Pipeline APIs
- no new Pipeline runtime node
- no backend read endpoint was required because the exact DatasetVersion and ownership are verified with existing Dataset APIs
- no automatic Pipeline execution or TrainingJob creation

Acceptance confirmed:

- a historical succeeded Preparation Run that produced DatasetVersion V1 can create a Pipeline pinned to V1 even if the output Dataset latest is V2+
- the generated graph contains one `dataset_load` node with the exact `dataset_id` and `dataset_version_id`
- invalid explicit handoff input never resolves to latest
- failed/non-materialized Preparation runs do not expose Pipeline handoff
- users without Pipeline mutation permission do not receive the create action
- existing downstream lifecycle navigation remains intact

## Phase 3-C — Unified Run-state, Error, Progress & Lineage UX

**Current implementation slice.**

- use the Phase 3 lifecycle taxonomy for stage-level execution summaries in both Pipeline Builder context and Pipeline Run detail
- normalize runtime state presentation across pending/running/succeeded/failed/skipped/cancelled and derive `reused` only as a UI presentation state when rerun-from-failed retains a successful earlier-attempt artifact
- show terminal-step progress and per-state counts without changing backend execution semantics
- surface the first failed node with its actual error/reason and recovery guidance
- retain the existing Rerun from failed runtime action; successful upstream artifacts remain backend-owned and are not rewritten by the frontend
- expose cross-lifecycle lineage using the exact historical PipelineVersion plus persisted node outputs/artifacts where available: DatasetVersion → Training Job / Experiment → Model Version → Deployment / Batch inference / Alert

Implementation boundary:

- no new runtime status is persisted; `reused` is derived from successful upstream node attempt metadata during a rerun
- no retry, scheduling, branch, cancellation, artifact persistence, or execution semantics change
- no backend API, DB schema, or migration change is required
- existing Pipeline Builder and Pipeline Run detail remain the execution/configuration source UI; Phase 3-C composes a shared lifecycle overview around them

Acceptance:

- Builder context can summarize the latest run by lifecycle stage and link to the run detail
- Pipeline Run shows the same stage taxonomy and normalized status vocabulary
- rerun-from-failed clearly distinguishes retained upstream work from restarted nodes without altering backend node state
- a failed run surfaces the failed node and recovery cue before raw logs
- persisted run outputs produce navigable lineage links when identifiers are available
- legacy node states without labels/attempts remain readable

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
