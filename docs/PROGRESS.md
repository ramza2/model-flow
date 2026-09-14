# Progress

## Current phase

**Enhancement Phase 2-E — Group By Aggregation** is the current implementation phase.

Phase **2-A — Dataset Preparation Foundation** is complete on `main` (merged via PR #38; merge commit `4b3146a1550938ca1bc143ec88e852c422be09b4`).

Phase **2-B — Visual Dataset Preparation + Sample Preview** is complete on `main` (merged via PR #39; merge commit `3c6db3c4c4d4771ed03c67ecad6406fd43dc8cfd`).

Phase **2-C — Transformation & Materialization** is complete on `main` (merged via PR #40; merge commit `bd0e8db3319a88d57411be6ad67204f4d77b6d77`).

Phase **2-D — Training Integration** is complete on `main` (merged via PR #41; merge commit `50de4dc08657e7432699652465a42b1564c327d0`).

Phase 2-C delivered:

- full Dataset Preparation worker execution
- deterministic transforms (select/drop/rename/filter/cast/deduplicate/fill_constant/derived_column)
- Parquet materialization into derived DatasetVersions
- output Dataset create/assign + Run output pin
- run history / execute queue UX
- upstream Dataset lineage for preparation-produced versions

Phase 2-D delivered:

- **Train this result** from Preparation Builder (success CTA + historical succeeded runs)
- exact prepared `output_dataset_version_id` handoff into Job Create
- version-aware Job Create (schema / targets / features / problem-type from selected DatasetVersion)
- Dataset Detail **Train on dataset** pins the currently selected DatasetVersion
- prepared Parquet DatasetVersion → TrainingJob integration (existing single `dataset_version_id` pin; no multi-input TrainingJob)

Phase 2-E scope (this implementation):

- `group_by` Preparation transform (SUM / AVG / MIN / MAX / COUNT)
- explicit aggregation output aliases; SQL-like null group retention + non-null COUNT
- Preview sample-derived aggregate warning when Group By is on the preview target path
- GroupByInspector + shared `execute_preparation_graph()` Preview/Run path

Not in this Phase 2-E slice (still on the Phase 2 roadmap, not marked complete):

- Pivot
- Unpivot

**Enhancement Phase 1.5 — UX Architecture & Frontend UX Refactoring** remains complete on `main`.

Phase 1.5 implementation baseline documents remain on `main`:

- [`phase-1.5-ux-architecture.md`](./phase-1.5-ux-architecture.md)
- [`phase-1.5-frontend-design-spec.md`](./phase-1.5-frontend-design-spec.md)

Phase **1.5-A — Shell & shared design system** is complete on `main`.

Phase **1.5-B — Pipeline UX** is complete on `main` (merged via PR #34).

Phase **1.5-C — ML lifecycle UX** is complete on `main` (merged via PR #35; production browser smoke PASS).

Phase **1.5-D — Operations & overview UX** is complete on `main` (merged via PR #36; merge commit `13cb5f43ed0f21c00d542eadd9043d091f8c7fa2`; production browser smoke PASS).

The implementation strategy was direct incremental refactoring of the existing React frontend. Figma is optional, not a required handoff step.

## Current baseline

- Branch baseline: `main`
- Phase 2-D merge (PR #41): `50de4dc08657e7432699652465a42b1564c327d0`
- Phase 2-C merge (PR #40): `bd0e8db3319a88d57411be6ad67204f4d77b6d77`
- Phase 2-B merge (PR #39): `3c6db3c4c4d4771ed03c67ecad6406fd43dc8cfd`
- Phase 2-A foundation merge (PR #38): `4b3146a1550938ca1bc143ec88e852c422be09b4`
- Phase 1.5 completion merge (PR #36): `13cb5f43ed0f21c00d542eadd9043d091f8c7fa2`
- Git tag: `v1.0.0-rc.1` (unchanged)
- Production domain: `modelflow.openlink.kr`

## Completed enhancement phases

### Phase 1 — Scheduling / Automation

Complete.

- DB-backed worker scheduler
- cron/timezone schedules
- data import, batch inference, pipeline run targets
- concurrency and retry policy
- run-now and schedule history UX

### Phase 1.1 — Retraining Foundation

Complete.

- canonical full-retraining flow
- explicit retrain lineage
- inherited configuration with fresh estimator and MLflow run
- retraining frontend flow and production smoke

### Phase 1.2 — Multi-output Regression

Complete implementation and deployed to production.

- multi-target regression training
- aggregate/per-target metrics
- MLflow/registry metadata
- named online multi-output predictions
- multi-column batch prediction output
- retrain/clone/retry compatibility
- production smoke follow-up fixes merged in PR #31

PR #31 also addressed:

- authenticated batch-result download
- model registration naming UX
- multi-output metric labels
- regression primary-metric selection logic
- prediction preview overflow
- approval comment preservation behavior
- Experiment Run detail
- deploy/runtime Git SHA propagation

## Latest verification baseline

### Phase 1.5 completion baseline (PR #36)

| Suite | Result |
| --- | ---: |
| Backend pytest | **252 passed** |
| Frontend Vitest | **203 passed** |
| Playwright E2E | **21 passed** |
| `./scripts/verify.sh` | **PASS** |
| GitHub Actions | **PASS** |

### Integrated regression confirmation

Phase 1.5 full integrated regression PASS on production/`main`, covering:

**ML lifecycle**

Dataset → Training Job → Experiment Run → Model Registry → Candidate → Pending Approval → Approved → Production → Deployment → Prediction → Monitoring

**Automation**

- Published Pipeline → Manual Run → Alert
- Published Pipeline → Disabled Schedule → Run now (manual) → Schedule History → Pipeline Run → Notification → Alert

**Additional revalidation (no longer pending)**

- blank approval comment preserves the existing request comment
- first prediction correctly contributes to p95 latency
- info unread alerts count toward Unread, but not Needs attention

### Historical PR #31 baseline (retained for lineage)

| Suite | Result |
| --- | ---: |
| Backend pytest | **243 passed** |
| Frontend Vitest | **131 passed** |
| Playwright E2E | **21 passed** |
| `./scripts/verify.sh` | **PASS** |
| GitHub Actions | **PASS** |

## Phase 1.5 implementation order

### 1.5-A — Shell & shared design system

Complete on `main`.

- grouped information architecture
- AppShell / Sidebar / Breadcrumb cleanup
- shared Page Header, status, action, form, table, and notice patterns
- existing dark engineering UI token normalization

### 1.5-B — Pipeline UX

Complete on `main` (merged via PR #34).

- Node Library / Canvas / Inspector
- graph-readable condition branches while preserving `true` / `false` / `always`
- Validation Panel and dirty-state protection
- exact historical PipelineVersion graph support for Pipeline Run where needed
- graph-based execution view
- rerun-from-failed / reused-step presentation

### 1.5-C — ML lifecycle UX

Complete on `main` (merged via PR #35).

- Dataset / Job / Experiment / Model / Deployment detail consistency
- lineage links
- full model lifecycle presentation
- multi-output target/metric presentation
- Prediction Test refinement
- production browser smoke PASS (including endpoint p95 latency flush fix)

### 1.5-D — Operations & overview UX

Complete on `main` (merged via PR #36; production browser smoke PASS).

- Workspace Home attention / next-action hierarchy
- Project Overview lifecycle control center
- Schedules catalog + Create/Edit Drawer + contextual pipeline scheduling
- Monitoring Service/Data/Model triage
- Alerts actionable inbox polish
- responsive refinements for the above screens

## Phase 1.5 implementation rules

- Existing backend/API/auth/RBAC/runtime behavior is the functional source of truth.
- Phase 1.5 UX documents are the presentation/IA source of truth.
- Do not replace the frontend wholesale.
- Do not invent later-phase features.
- Use feature branches and Draft PRs.
- Run targeted tests and the full verification gate before merge.
- Browser review with realistic data is part of the UX acceptance process.

## Blockers

No architecture blocker is currently known.

Historical PipelineVersion graph lookup for Pipeline Run is implemented in Phase 1.5-B as a minimal read-only endpoint:
`GET /projects/{project_id}/pipeline-versions/{pipeline_version_id}`.

## Next step

Implement **Phase 2-E — Group By Aggregation** (`group_by` transform end-to-end on Dataset Preparation). Next planned Phase 2 item after that: **Phase 2-F — Pivot / Unpivot Reshape** (not started; do not mark complete here). Multi-dataset composition stays in Dataset Preparation; TrainingJob continues to consume one pinned rectangular DatasetVersion (see D-035).

Known limitation of Phase 2-C (still applies): Pandas in-memory execution only (no Spark/Dask/distributed/chunked processing).

Known UX debt retained from Phase 1.5 (not in scope for Phase 1.5 cleanup):

- full SPA / sidebar / project-switch unsaved navigation guard
- Pipeline node drag/reposition (tracked for Phase 3 — End-to-End Pipeline UX backlog)
