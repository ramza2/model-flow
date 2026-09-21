# Progress

## Current phase

**Enhancement Phase 4-D — Oracle Connector** is the current implementation phase.

Phase **4-A — Connector Foundation + REST API Source** is complete on `main` (merged via PR #52; merge commit `09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1`; post-merge CI #254 PASS).

Phase **4-B — MySQL / MariaDB Connector** is complete on `main` (merged via PR #54; merge commit `aa6bae2428390f3c49ff39693abeb3bf169faab4`; post-merge CI #259 PASS).

AGENTS.md connector-architecture update is on `main` (PR #53; `9c92a4d8e692ef93188e3a880ae21da206a8b573`; post-merge CI #262 PASS).

Phase **4-C — Microsoft SQL Server Connector** is complete on `main` (merged via PR #55; merge commit `e8c5af7db26affd29c312f3739fb4b76db366ad6`; post-merge CI #268 PASS).

Phase 4-D starts from `main@e8c5af7db26affd29c312f3739fb4b76db366ad6`.

Phase 3 remains complete on `main`.

Phase **2-A — Dataset Preparation Foundation** is complete on `main` (merged via PR #38; merge commit `4b3146a1550938ca1bc143ec88e852c422be09b4`).

Phase **2-B — Visual Dataset Preparation + Sample Preview** is complete on `main` (merged via PR #39; merge commit `3c6db3c4c4d4771ed03c67ecad6406fd43dc8cfd`).

Phase **2-C — Transformation & Materialization** is complete on `main` (merged via PR #40; merge commit `bd0e8db3319a88d57411be6ad67204f4d77b6d77`).

Phase **2-D — Training Integration** is complete on `main` (merged via PR #41; merge commit `50de4dc08657e7432699652465a42b1564c327d0`).

Phase **2-E — Group By Aggregation** is complete on `main` (merged via PR #42; merge commit `bb8df0212641f70308ca1dfa77cddc8e3aff5f77`).

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

Phase 2-E delivered:

- `group_by` Preparation transform (SUM / AVG / MIN / MAX / COUNT)
- explicit aggregation output aliases; SQL-like null group retention + non-null COUNT
- Preview sample-derived aggregate warning when Group By is on the preview target path
- GroupByInspector + shared `execute_preparation_graph()` Preview/Run path

Phase **2-F1 — Unpivot Reshape** is complete on `main` (merged via PR #43; merge commit `e848a9c7a53bc9e791294e60ec4e6baf95409f37`).

Phase 2-F1 delivered:

- `unpivot` Preparation transform (explicit `id_columns` + `value_columns` wide → long)
- deterministic row/column order; null value rows retained; unlisted source columns omitted
- UnpivotInspector + shared `execute_preparation_graph()` Preview/Run path

Phase **2-F2 — Pivot Reshape** is complete on `main` (merged via PR #44; merge commit `d44fffa1ffde80e604c01d38f5dbee9664251057`).

Phase 2-F2 delivered:

- `pivot` Preparation transform (explicit `index_columns` + `columns_column` + `value_column` + `aggregation` + `pivot_values` long → wide)
- Group By aggregation ops reused (`sum` / `avg` / `min` / `max` / `count`); no automatic pivot-value discovery
- stable Preview/Full schemas from configured outputs; null index groups retained; first-seen index order
- PivotInspector + shared `execute_preparation_graph()` Preview/Run path

Phase **2-F — Pivot / Unpivot Reshape** is complete on `main`.

Phase **2-G — Final Hardening / End-to-End Regression** is complete on `main` (merged via PR #45; merge commit `b847f658f2f8bf78c9c5ad878750730da711775c`; merge commit CI PASS).

Phase 2-G delivered:

- final Phase 2 coverage audit and regression consolidation
- representative multi-source Preparation full-data path: Join → Filter → Derived Column → Group By → Unpivot → Pivot → Output
- Run 1 exact source pins + Parquet output DatasetVersion V1 + lineage
- source `latest` update followed by Run 2 output DatasetVersion V2
- historical V1 immutability after V2 exists
- TrainingJob explicitly pinned to historical V1 while output Dataset latest is V2
- TrainingRunner exact V1 artifact consumption; no fallback to V2/latest
- existing frontend historical **Train this result**, Dataset Detail, and JobCreate exact-version regressions retained instead of duplicating UX

**Enhancement Phase 2 — Dataset Preparation is complete on `main`.**

Verification coverage for the final Phase 2 hardening is documented in [`phase-2g-verification.md`](./phase-2g-verification.md).

Phase **3-A — Lifecycle Pipeline UX Foundation** is complete on `main` (merged via PR #46; merge commit `f30a9541c30c8722009e31839e819c30d6d69de9`; merge commit CI PASS).

Phase 3-A delivered:

- lifecycle-aligned Pipeline Node Library: Source & Transform → Quality → Train → Registry & Governance → Deploy → Predict → Monitor
- shared lifecycle stage helpers and deterministic catalog coverage tests
- Dataset Load copy that explicitly accepts an exact DatasetVersion, including a materialized Dataset Preparation output
- existing Pipeline runtime contract preserved; no new `preparation` runtime node, backend API, DB schema, or migration

Phase **3-B — Prepared-data Handoff & Lifecycle Navigation** is complete on `main` (merged via PR #47; merge commit `ffbe248a999c5fca1f26c54cd03de1d3eaebc643`; merge commit CI PASS).

Phase 3-B delivered:

- succeeded materialized Preparation runs expose exact historical DatasetVersion inputs for Pipeline authoring
- Pipeline creation pins the initial `dataset_load` node to the exact selected DatasetVersion
- malformed, missing, or wrong-dataset handoffs are rejected without resolving to latest
- readable exact-version context is preserved for read-only users while Pipeline mutation actions remain RBAC-gated
- existing Dataset → Training → Experiment/Registry → Deployment → Prediction/Monitoring links are reused rather than duplicated
- no backend/API/runtime/DB/migration changes

Phase **3-C — Unified Run-state, Error, Progress & Lineage UX** is complete on `main` (merged via PR #49; merge commit `33fdab3955f3a199b25ce0fb37e35c0cb3d0b26a`; merge commit CI PASS).

Phase 3-C delivered:

- unified Pipeline Builder coverage and Pipeline Run execution summaries on the shared lifecycle taxonomy
- deterministic pending/running/succeeded/failed/skipped/reused/cancelled presentation without changing backend runtime semantics
- stage and overall terminal-step progress from the exact historical PipelineVersion graph and node states
- first-failed-node recovery focus while retaining existing auto-focus and rerun-from-failed behavior
- exact DatasetVersion → Training Job → Experiment/Model → Deployment/Batch/Alert lineage from existing graph configuration and persisted node artifacts
- no backend/API/runtime/DB/migration or retry/reuse semantic changes

Phase **3-D — Final Hardening / Browser Regression** is complete on `main` (merged via PR #50; squash commit `ff6c1f92752263c5684f4d3311d377d05b27f4e4`; post-merge CI #245 / run `35289545125` PASS).

Phase 3-D delivered:

- shared unsaved-change protection for same-origin SPA/sidebar navigation, project switching, and sign-out while Pipeline edits are dirty
- route-project → `ProjectContext` synchronization so direct project URLs and the global project picker stay consistent
- existing browser `beforeunload` and Builder-local back-link confirmation preserved without duplicate prompts
- Viewer/read-only Pipeline Builder browser regression
- drawer viewport accessibility/focus and horizontal-overflow regression
- exact PR HEAD full verification PASS and post-merge `main` full verification PASS
- no backend/API/runtime/DB/migration changes

**Enhancement Phase 3 — End-to-End Pipeline UX is complete on `main`.**

The completed implementation plan is documented in [`phase-3-pipeline-ux.md`](./phase-3-pipeline-ux.md), and final verification evidence is documented in [`phase-3d-verification.md`](./phase-3d-verification.md).

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

- Branch baseline: `main@b0c8d517b8e83c57e1b1bcaedb8a4120bc99e620`
- Phase 3 closeout merge (PR #51): `b0c8d517b8e83c57e1b1bcaedb8a4120bc99e620` (post-merge CI #247 / run `35292163693` PASS)
- Phase 3-D merge (PR #50): `ff6c1f92752263c5684f4d3311d377d05b27f4e4` (post-merge CI #245 / run `35289545125` PASS)
- Phase 3-C merge (PR #49): `33fdab3955f3a199b25ce0fb37e35c0cb3d0b26a`
- Phase 3-B merge (PR #47): `ffbe248a999c5fca1f26c54cd03de1d3eaebc643`
- Phase 3-A merge (PR #46): `f30a9541c30c8722009e31839e819c30d6d69de9`
- Phase 2-G merge (PR #45): `b847f658f2f8bf78c9c5ad878750730da711775c`
- Phase 2-F2 merge (PR #44): `d44fffa1ffde80e604c01d38f5dbee9664251057`
- Phase 2-F1 merge (PR #43): `e848a9c7a53bc9e791294e60ec4e6baf95409f37`
- Phase 2-E merge (PR #42): `bb8df0212641f70308ca1dfa77cddc8e3aff5f77`
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

### Phase 3 completion baseline (PR #50)

- pre-merge exact HEAD `0ed343b8df0ef491a7759b3e75279bdb0409b44a`: CI #244 / run `35202693765` **PASS**
- squash merge to `main`: `ff6c1f92752263c5684f4d3311d377d05b27f4e4`
- post-merge `main` CI #245 / run `35289545125`: **PASS**
- `Full verification gate`: **PASS**
- actual diff final review: **PASS / no blocker**

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

Complete **Phase 4-D — Oracle Connector** from `main@e8c5af7db26affd29c312f3739fb4b76db366ad6`. Acceptance requires a disposable Oracle Free fixture, SQLAlchemy + `python-oracledb` Thin mode (`oracle+oracledb`), Host/Port with `service_name` (default 1521) and allowlisted Connection URL modes, `SET TRANSACTION READ ONLY` defense-in-depth, bounded preview without `LIMIT`, and the full verification gate to pass. Phase 4-D is not complete until this Draft PR merges and `main` CI passes.

Known limitation retained from Phase 2-C: Pandas in-memory preparation execution only (no Spark/Dask/distributed/chunked processing).

Known object-store atomicity limitation retained for a later hardening slice: if artifact upload succeeds but the final DB commit fails, an orphaned object may require cleanup/reconciliation.

Known non-blocking frontend optimization debt retained after Phase 3-C:

- Pipeline Run lifecycle summary and the underlying historical Run Detail currently maintain independent active-run polling loops; this duplicates a read-only request while a run is active and can be consolidated in a later frontend performance cleanup.
