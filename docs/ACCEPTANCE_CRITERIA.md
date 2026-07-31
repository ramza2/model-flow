# Acceptance Criteria (MVP + v1.0 RC)

Existing MVP criteria are **retained**. v1.0 criteria are **additive**. Each item must be PASS before completion is declared.

## MVP criteria (retained)

| ID | Criterion | Status |
|----|-----------|--------|
| AC-01 | README alone is enough to run the stack on a clean machine | PENDING (re-verify) |
| AC-02 | `docker compose` brings up frontend, backend, worker, postgres, mlflow, minio with healthchecks | PENDING |
| AC-03 | Alembic migrations apply cleanly | PENDING |
| AC-04 | Create project via API and UI | PENDING |
| AC-05 | Upload CSV dataset to MinIO; metadata in Postgres | PENDING |
| AC-06 | Dataset column names and basic stats available via API/UI | PENDING |
| AC-07 | Create training job; worker runs sklearn asynchronously | PENDING |
| AC-08 | Training job status and logs queryable | PENDING |
| AC-09 | MLflow run created with params, metrics, artifacts | PENDING |
| AC-10 | Model registered; versions listed | PENDING |
| AC-11 | Inference endpoint created; sample predict returns results | PENDING |
| AC-12 | UI screens wired to real APIs — no mock/fake completion | PENDING |
| AC-13 | Backend pytest pass | PENDING |
| AC-14 | Frontend Vitest + typecheck + lint pass | PENDING |
| AC-15 | Playwright E2E covers core flow | PENDING |
| AC-16 | `scripts/verify.sh` runs full verification suite | PENDING |
| AC-17 | Friendly error messages for common failures | PENDING |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PENDING |
| AC-19 | Screenshots or browser evidence of key screens | PENDING |
| AC-20 | Draft PR documents PASS/FAIL for all criteria | PENDING |
| AC-21 | Same-filename re-upload keeps distinct MinIO objects | PENDING |
| AC-22 | Endpoint ready only after successful model load | PENDING |
| AC-23 | Cross-project run/model binding rejected | PENDING |
| AC-24 | Worker health reflects fresh DB heartbeat | PENDING |
| AC-25 | verify.sh requires only Docker/Compose/curl/bash on host | PENDING |
| AC-26 | GitHub Actions CI workflow present; YAML validates and triggers on PR/push/`workflow_dispatch` | PENDING |
| AC-27 | Pull Request targeting `main` runs the full verification gate as a required Check | PENDING |
| AC-28 | CI failure uploads `artifacts/verify/` and `artifacts/screenshots/` | PENDING |
| AC-29 | External Docker images pinned to pull-verified tags | PENDING |
| AC-30 | Clean-volume full verification PASS | PENDING |

## v1.0 criteria

| ID | Criterion | Status |
|----|-----------|--------|
| AC-31 | Bootstrap admin from env; no hardcoded default password | PENDING |
| AC-32 | Login, logout, me, password change; JWT expiry | PENDING |
| AC-33 | User create/activate/deactivate; inactive blocked | PENDING |
| AC-34 | Brute-force lockout or rate limit on login | PENDING |
| AC-35 | RBAC roles enforced; unauthorized → 403; menus hidden by role | PENDING |
| AC-36 | Project membership isolation at API layer | PENDING |
| AC-37 | Audit log for auth, users, projects, data, train, registry, endpoints, admin settings | PENDING |
| AC-38 | Audit UI: search, filter, date range, detail; secrets never stored | PENDING |
| AC-39 | File data sources: CSV, JSON, Parquet | PENDING |
| AC-40 | Postgres data source: test connection, schema/table, import → DatasetVersion; secrets encrypted | PENDING |
| AC-41 | Dataset versions immutable; profiling stats; preview; compare; lineage | PENDING |
| AC-42 | Quality rules create/run/history; PASS/WARNING/FAIL; train policy | PENDING |
| AC-43 | Train/val/test splits with seed and ratios persisted | PENDING |
| AC-44 | Classification algorithms: LR, RF, GB | PENDING |
| AC-45 | Regression algorithms: Ridge, RF, GB | PENDING |
| AC-46 | Training job cancel/retry/clone; concurrency; heartbeat recovery | PENDING |
| AC-47 | Experiment compare UI with params/metrics | PENDING |
| AC-48 | Visual pipeline design + publish + validate + execute via worker | PENDING |
| AC-49 | Pipeline E2E: data→quality→split→preprocess→train→eval→registry | PENDING |
| AC-50 | Model lifecycle states + approval/reject/promote/rollback + gates | PENDING |
| AC-51 | Realtime endpoint start/stop/swap/rollback + schema validation + metrics | PENDING |
| AC-52 | Batch inference job + MinIO result + download | PENDING |
| AC-53 | Service/data/model monitoring from real data; empty states (no fake metrics) | PENDING |
| AC-54 | Drift detection (numeric/categorical/prediction) + history + alerts | PENDING |
| AC-55 | Retrain triggers; never auto-promote to PRODUCTION | PENDING |
| AC-56 | In-app alerts (read/unread, severity, resolve, filter) | PENDING |
| AC-57 | Admin: users, membership, system/worker/queue/storage, settings, retention | PENDING |
| AC-58 | Security headers, CORS, rate limit, validation, secret masking | PENDING |
| AC-59 | `scripts/backup.sh` + `scripts/restore.sh` verified | PENDING |
| AC-60 | `scripts/reset-dev.sh` (+ optional seed-demo) | PENDING |
| AC-61 | E2E-01 Admin & users PASS | PENDING |
| AC-62 | E2E-02 Data PASS | PENDING |
| AC-63 | E2E-03 Training PASS | PENDING |
| AC-64 | E2E-04 Pipeline PASS | PENDING |
| AC-65 | E2E-05 Approve & deploy PASS | PENDING |
| AC-66 | E2E-06 Monitoring/drift/retrain PASS | PENDING |
| AC-67 | E2E-07 Permissions & audit PASS | PENDING |
| AC-68 | E2E-08 Batch PASS | PENDING |
| AC-69 | E2E-09 Clean installation PASS | PENDING |
| AC-70 | Forbidden TODO/mock/placeholder scan PASS | PENDING |
| AC-71 | Known limitations documented | PENDING |
| AC-72 | GitHub Actions Full verification gate PASS on Draft PR | PENDING |

## Evidence

Filled during Phase 12. Until then status remains PENDING.
