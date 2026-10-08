# Progress

## Current phase

**Enhancement Phase 8 — Enterprise / Scale is current.** **8-A and 8-B are complete on `main`.** **8-C — Enterprise Identity — OIDC / SSO is the current Draft slice** (Draft PR #81). Slices **8-D–8-F** remain planned.

Phase 8-B completion baseline: `main@4ad6f908acd1ad5b0512b7e6e0933ac8c34d1e37` (PR #79; final PR HEAD `30482b854f198f4a7fdaf12019b611521328feec`; exact-head Fast Gate #372 / run `37730164986` PASS; post-merge Full Gate #373 / run `37734775244` PASS; Alembic head `023_forecasting_training`; no migration).

Phase 8-B delivered:

- unique per-replica worker identity via explicit `WORKER_ID` / `MODELFLOW_WORKER_ID` or container hostname fallback
- worker profiles `general` / `gpu` with fail-closed routing; all current workloads remain `general`
- heartbeat operational metadata for profile, capabilities, max concurrency, and git SHA
- PostgreSQL session advisory-lock leadership for scheduler / stale recovery / cancellation maintenance
- existing `FOR UPDATE SKIP LOCKED` durable job claims preserved with PostgreSQL no-double-claim regression
- Compose `--scale worker=2` verification with distinct healthy worker heartbeats
- GPU profile remains routing foundation only; no sklearn/CUDA execution semantic change
- Verification details: [`phase-8b-verification.md`](./phase-8b-verification.md)

Phase 8-A completion baseline: `main@933ce3dc2b47fb50aaa28d3e727d6b827d26a38c` (PR #76; exact PR HEAD `6ed6a964d20d11c06d4cd67d30697150f09b25ca`; exact-head CI #362 / run `37572306127` PASS; post-merge main CI #363 / run `37574052970` PASS; Alembic head `023_forecasting_training`).

Phase 8-A delivered:

- dedicated internal `inference-runtime` service for model load/predict
- backend/worker/pipeline/registry model execution delegated through `inference_client`
- server-owned inference service credential; no user JWT reuse
- online prediction control-plane contracts preserved
- batch inference uses bounded chunking (default 256) with row-order preservation
- runtime remains internal-only under Compose/Traefik
- internal HTTP client ignores ambient HTTP(S)/ALL proxy configuration (`trust_env=False`)

Phase 7 closeout evidence:

- PR #74 merged; squash/main commit `93b8878971d69a926c8f1dc93c02bad04665f4b1`
- post-merge main CI #358 / run `37559456232` SUCCESS
- Phase 7 implementation baseline before docs closeout: `483db3859558570c499114ba774bf62b491234e1`
- Alembic head: `023_forecasting_training`
- Phase 7 verification: [`phase-7d-verification.md`](./phase-7d-verification.md)

Phase 7-D complete evidence:

- PR #73 merged; squash/main commit `483db3859558570c499114ba774bf62b491234e1`
- final PR HEAD `a8084555779e2d68b0ffeec6ddcb668e6e5c0d12`; exact-head CI #355 / run `37553991815` SUCCESS
- post-merge main CI #356 / run `37555997629` SUCCESS
- Alembic head: `023_forecasting_training`
- Verification details: [`phase-7d-verification.md`](./phase-7d-verification.md)

Phase 7-C complete evidence:

- PR #72 merged; squash/main commit `0673366d2c67c11b2b1f84bf41ca7176b8cb17d1`
- post-merge main CI #353 / run `37409599810` SUCCESS
- Alembic head: `023_forecasting_training`

Phase 7-B complete evidence:

- PR #71 merged; squash/main commit `b8e94f5ff87450f48c12add980bd243fe88ee3a8`
- post-merge main CI #350 / run `37392846125` attempt 2 PASS
- Alembic head: `023_forecasting_training`
- Note: CI #350 attempt 1 had a transient MySQL import E2E timeout; no code change; identical tree SHA `d64be8fc401aeb985d5da4ecb2fb87662df5301a` passed PR CI #349 and CI #350 attempt 2.

Phase 7-A complete evidence:

- PR #70 merged; squash/main commit `e1927c5f72e0673a96b53a4cb4e2b5d2d422ed62`
- post-merge main CI #345 / run `36972237806` PASS
- Alembic head: `023_forecasting_training`

**Enhancement Phase 6 — Time-series / Multi-step is complete on `main`.** All slices are complete: **6-A**, **6-B**, **6-C**, and **6-D**.

Phase 6 closeout evidence:

- PR #69 merged; squash/main commit `aa8e077bd82a33278fea9e492c27e3aa9d99277b`
- post-merge main CI #340 / run `36954705944` PASS
- Alembic head: `023_forecasting_training`

Phase 6-D complete baseline (pre-closeout tip): `main@1b723e83ab7734822d867ebe42adb698612087c3` (PR #68; post-merge CI #338 PASS; Alembic head `023_forecasting_training`).

Phase 6-D complete evidence:

- PR #68 merged; squash/main commit `1b723e83ab7734822d867ebe42adb698612087c3`
- pre-merge exact HEAD CI #337 / run `36948403362` PASS
- post-merge `main` CI #338 / run `36950409425` PASS
- Alembic head: `023_forecasting_training`

Phase 6-C complete evidence:

- PR #67 merged; squash/main commit `abc738a5da390f62a5aade4691fcc640531c5d53`
- post-merge `main` CI #333 / run `36830381594` PASS
- Alembic head: `023_forecasting_training`

Phase 6-B complete evidence:

- PR #66 merged; squash/main commit `deb98ed18d6483fdd72adf430ab2cc5b763a3758`
- post-merge `main` CI #329 / run `36819635158` PASS
- Alembic head: `022_time_series_foundation`

Phase 6-A complete evidence:

- PR #65 merged; squash/main commit `9376c5c209f9ebce7e52da15d341707f904bedd7`
- post-merge `main` CI #323 PASS
- Alembic head: `022_time_series_foundation`

**Enhancement Phase 5.1 — Incremental / Continued Training is complete on `main`.**

Phase 5.1 complete evidence:

- PR #63 merged; merge commit `41cf96daaf8095103da7e47368b147fbf677d041`
- security follow-up PR #64 merged
- final baseline `295768f9e2f09e61ba7538d203080365bf6f7559`
- post-hotfix `main` CI #316 PASS
- Alembic head: `021_continued_training`

**Enhancement Phase 5 — Closed-loop MLOps is complete on `main`.**

Phase 5-D complete evidence:

- PR #62 squash merge commit `b7702144ffdabc94b02ccd323aa460de09e550fa`
- post-merge `main` CI #304 PASS
- Alembic head at merge: `020_advanced_quality_policy`

**Enhancement Phase 5-C — Advanced Quality Policies is complete on `main`.**

Phase 5-C complete evidence:

- PR #61 squash merge commit `2753a8e7a2c9338f6e0458a2d9f9c71dea38f32c`
- post-merge `main` CI #300 PASS
- Alembic head at merge: `020_advanced_quality_policy`

**Enhancement Phase 5-B — Feedback Dataset Materialization is complete on `main`.**

Phase 5-B complete evidence:

- PR #60 squash merge commit `4549b04030a9443266592a5cbbe8e06a2a3600a2`
- post-merge `main` CI #294 PASS
- Alembic head at merge: `019_feedback_materialization`

**Enhancement Phase 5-A — Closed-loop MLOps Foundation is complete on `main`.**

Phase 5-A complete evidence:

- PR #59 squash merge commit `1bb13bc2e527951e1a580787c35cd530fed45e7a`
- post-merge `main` CI #285 PASS
- Alembic head at merge: `018_closed_loop_mlops`

**Enhancement Phase 4 — Connectors is complete on `main`.**

Phase **4-A — Connector Foundation + REST API Source** is complete on `main` (merged via PR #52; merge commit `09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1`; post-merge CI #254 PASS).

Phase **4-B — MySQL / MariaDB Connector** is complete on `main` (merged via PR #54; merge commit `aa6bae2428390f3c49ff39693abeb3bf169faab4`; post-merge CI #259 PASS).

AGENTS.md connector-architecture update is on `main` (PR #53; `9c92a4d8e692ef93188e3a880ae21da206a8b573`; post-merge CI #262 PASS).

Phase **4-C — Microsoft SQL Server Connector** is complete on `main` (merged via PR #55; merge commit `e8c5af7db26affd29c312f3739fb4b76db366ad6`; post-merge CI #268 PASS).

Phase **4-D — Oracle Connector** is complete on `main` (merged via PR #56; merge commit `18576e6e54b751f416b87e110c39918fe7dc2045`; post-merge CI #273 PASS).

Phase **4-E — Final Hardening / Connector Regression** is complete on `main` (merged via PR #57; squash commit `c9483de0ef6d557097abb9340aeee499d68d41bc`; post-merge CI #278 PASS).

Phase 4-E delivered:

- Oracle final hardening (autonomous SELECT / UDF boundary, including quoted identifiers and comment-glue fail-closed)
- duplicate query parameter handling (Oracle + MSSQL)
- Oracle stale URL-mode config cleanup
- Oracle schema default UX
- PostgreSQL Connection URL scheme allowlist
- cross-connector security / read-only / lifecycle / lineage regression
- full verification PASS (see [`phase-4e-verification.md`](./phase-4e-verification.md))

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

- Phase 8-B implementation merge (PR #79): `4ad6f908acd1ad5b0512b7e6e0933ac8c34d1e37` (final PR HEAD `30482b854f198f4a7fdaf12019b611521328feec`; exact-head CI #372 PASS; post-merge main CI #373 PASS; Alembic head `023_forecasting_training`)
- Branch baseline: `main@93b8878971d69a926c8f1dc93c02bad04665f4b1` (Phase 7 closeout PR #74; post-merge CI #358 / run `37559456232` SUCCESS; Alembic head `023_forecasting_training`)
- Phase 7-D implementation merge (PR #73): `483db3859558570c499114ba774bf62b491234e1` (post-merge CI #356 / run `37555997629` SUCCESS)
- Phase 7-C merge (PR #72): `0673366d2c67c11b2b1f84bf41ca7176b8cb17d1` (post-merge main CI #353 / run `37409599810` SUCCESS; Alembic head `023_forecasting_training`)
- Phase 7-B merge (PR #71): `b8e94f5ff87450f48c12add980bd243fe88ee3a8` (post-merge main CI #350 / run `37392846125` attempt 2 PASS; Alembic head `023_forecasting_training`)
- Phase 7-A merge (PR #70): `e1927c5f72e0673a96b53a4cb4e2b5d2d422ed62` (post-merge main CI #345 / run `36972237806` PASS; Alembic head `023_forecasting_training`)
- Phase 6 docs closeout (PR #69): `aa8e077bd82a33278fea9e492c27e3aa9d99277b` (post-merge main CI #340 / run `36954705944` PASS; Alembic head `023_forecasting_training`)
- Phase 6-D merge (PR #68): `1b723e83ab7734822d867ebe42adb698612087c3` (post-merge CI #338 / run `36950409425` PASS; Alembic head `023_forecasting_training`)
- Phase 6-C merge (PR #67): `abc738a5da390f62a5aade4691fcc640531c5d53` (post-merge CI #333 PASS; Alembic head `023_forecasting_training`)
- Phase 6-B merge (PR #66): `deb98ed18d6483fdd72adf430ab2cc5b763a3758` (post-merge CI #329 PASS; Alembic head `022_time_series_foundation`)
- Phase 6-A merge (PR #65): `9376c5c209f9ebce7e52da15d341707f904bedd7` (post-merge CI #323 PASS; Alembic head `022_time_series_foundation`)
- Phase 4 closeout docs (PR #58): `364c0d846a8cbfe81a16cc0d0e16743d43c610f0`
- Phase 4-E merge (PR #57): `c9483de0ef6d557097abb9340aeee499d68d41bc` (post-merge CI #278 PASS)
- Phase 4-D merge (PR #56): `18576e6e54b751f416b87e110c39918fe7dc2045` (post-merge CI #273 PASS)
- Phase 4-C merge (PR #55): `e8c5af7db26affd29c312f3739fb4b76db366ad6` (post-merge CI #268 PASS)
- Phase 4-B merge (PR #54): `aa6bae2428390f3c49ff39693abeb3bf169faab4` (post-merge CI #259 PASS)
- Phase 4-A merge (PR #52): `09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1` (post-merge CI #254 PASS)
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

**Phase 8-A is complete.** Start **8-B — Worker Scale-out & Runner Profiles** from the current `main`. Keep 8-C+ scope out of the 8-B PR.

Phase 8 slice plan:

```text
8-A Inference Runtime Separation
8-B Worker Scale-out & Runner Profiles
8-C Enterprise Identity — OIDC / SSO
8-D External Secret Management
8-E Kubernetes / HA Deployment
8-F Final Hardening / Scale Regression
```

Ordering constraints:

- separate inference execution before Kubernetes/HA
- make multi-worker execution and singleton scheduler behavior safe before worker replica scaling
- preserve existing public API/RBAC/audit contracts while adding OIDC
- add vendor-neutral external secret delivery before Kubernetes production manifests
- do not claim HA for single embedded PostgreSQL/MinIO state
- GPU runner profiles are capability/routing infrastructure only; existing sklearn workloads do not become GPU workloads automatically

See [`phase-8-enterprise-scale.md`](./phase-8-enterprise-scale.md) and [`ENHANCEMENT_ROADMAP.md`](./ENHANCEMENT_ROADMAP.md).

Known limitation retained from Phase 2-C: Pandas in-memory preparation execution only (no Spark/Dask/distributed/chunked processing).

Known object-store atomicity limitation retained for a later hardening slice: if artifact upload succeeds but the final DB commit fails, an orphaned object may require cleanup/reconciliation.

Known non-blocking frontend optimization debt retained after Phase 3-C:

- Pipeline Run lifecycle summary and the underlying historical Run Detail currently maintain independent active-run polling loops; this duplicates a read-only request while a run is active and can be consolidated in a later frontend performance cleanup.
