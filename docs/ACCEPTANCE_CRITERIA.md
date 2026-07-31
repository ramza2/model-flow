# Acceptance Criteria (MVP + v1.0 RC)

Existing MVP criteria are **retained**. v1.0 criteria are **additive**. Each item must be PASS before completion is declared.

## MVP criteria (retained)

| ID | Criterion | Status |
|----|-----------|--------|
| AC-01 | README alone is enough to run the stack on a clean machine | PASS |
| AC-02 | `docker compose` brings up frontend, backend, worker, postgres, mlflow, minio with healthchecks | PASS |
| AC-03 | Alembic migrations apply cleanly | PASS |
| AC-04 | Create project via API and UI | PASS |
| AC-05 | Upload CSV dataset to MinIO; metadata in Postgres | PASS |
| AC-06 | Dataset column names and basic stats available via API/UI | PASS |
| AC-07 | Create training job; worker runs sklearn asynchronously | PASS |
| AC-08 | Training job status and logs queryable | PASS |
| AC-09 | MLflow run created with params, metrics, artifacts | PASS |
| AC-10 | Model registered; versions listed | PASS |
| AC-11 | Inference endpoint created; sample predict returns results | PASS |
| AC-12 | UI screens wired to real APIs — no mock/fake completion | PASS |
| AC-13 | Backend pytest pass | PASS |
| AC-14 | Frontend Vitest + typecheck + lint pass | PASS |
| AC-15 | Playwright E2E covers core flow | PASS |
| AC-16 | `scripts/verify.sh` runs full verification suite | PASS |
| AC-17 | Friendly error messages for common failures | PASS |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PASS |
| AC-19 | Screenshots or browser evidence of key screens | PASS |
| AC-20 | Draft PR documents PASS/FAIL for all criteria | PASS |
| AC-21 | Same-filename re-upload keeps distinct MinIO objects | PASS |
| AC-22 | Endpoint ready only after successful model load | PASS |
| AC-23 | Cross-project run/model binding rejected | PASS |
| AC-24 | Worker health reflects fresh DB heartbeat | PASS |
| AC-25 | verify.sh requires only Docker/Compose/curl/bash on host | PASS |
| AC-26 | GitHub Actions CI workflow present; YAML validates and triggers on PR/push/`workflow_dispatch` | PASS |
| AC-27 | Pull Request targeting `main` runs the full verification gate as a required Check | PASS |
| AC-28 | CI failure uploads `artifacts/verify/` and `artifacts/screenshots/` | PASS |
| AC-29 | External Docker images pinned to pull-verified tags | PASS |
| AC-30 | Clean-volume full verification PASS | PASS |

## v1.0 criteria

| ID | Criterion | Status |
|----|-----------|--------|
| AC-31 | Bootstrap admin from env; no hardcoded default password | PASS |
| AC-32 | Login, logout, me, password change; JWT expiry | PASS |
| AC-33 | User create/activate/deactivate; inactive blocked | PASS |
| AC-34 | Brute-force lockout or rate limit on login | PASS |
| AC-35 | RBAC roles enforced; unauthorized → 403; menus hidden by role | PASS |
| AC-36 | Project membership isolation at API layer | PASS |
| AC-37 | Audit log for auth, users, projects, data, train, registry, endpoints, admin settings | PASS |
| AC-38 | Audit UI: search, filter, date range, detail; secrets never stored | PASS |
| AC-39 | File data sources: CSV, JSON, Parquet | PASS |
| AC-40 | Postgres data source: test connection, schema/table, import → DatasetVersion; secrets encrypted | PASS |
| AC-41 | Dataset versions immutable; profiling stats; preview; compare; lineage | PASS |
| AC-42 | Quality rules create/run/history; PASS/WARNING/FAIL; train policy | PASS |
| AC-43 | Train/val/test splits with seed and ratios persisted | PASS |
| AC-44 | Classification algorithms: LR, RF, GB | PASS |
| AC-45 | Regression algorithms: Ridge, RF, GB | PASS |
| AC-46 | Training job cancel/retry/clone; concurrency; heartbeat recovery | PASS |
| AC-47 | Experiment compare UI with params/metrics | PASS |
| AC-48 | Visual pipeline design + publish + validate + execute via worker | PASS |
| AC-49 | Pipeline E2E: data→quality→split→preprocess→train→eval→registry | PASS |
| AC-50 | Model lifecycle states + approval/reject/promote/rollback + gates | PASS |
| AC-51 | Realtime endpoint start/stop/swap/rollback + schema validation + metrics | PASS |
| AC-52 | Batch inference job + MinIO result + download | PASS |
| AC-53 | Service/data/model monitoring from real data; empty states (no fake metrics) | PASS |
| AC-54 | Drift detection (numeric/categorical/prediction) + history + alerts | PASS |
| AC-55 | Retrain triggers; never auto-promote to PRODUCTION | PASS |
| AC-56 | In-app alerts (read/unread, severity, resolve, filter) | PASS |
| AC-57 | Admin: users, membership, system/worker/queue/storage, settings, retention | PASS |
| AC-58 | Security headers, CORS, rate limit, validation, secret masking | PASS |
| AC-59 | `scripts/backup.sh` + `scripts/restore.sh` verified | PASS |
| AC-60 | `scripts/reset-dev.sh` (+ optional seed-demo) | PASS |
| AC-61 | E2E-01 Admin & users PASS | PASS |
| AC-62 | E2E-02 Data PASS | PASS |
| AC-63 | E2E-03 Training PASS | PASS |
| AC-64 | E2E-04 Pipeline PASS | PASS |
| AC-65 | E2E-05 Approve & deploy PASS | PASS |
| AC-66 | E2E-06 Monitoring/drift/retrain PASS | PASS |
| AC-67 | E2E-07 Permissions & audit PASS | PASS |
| AC-68 | E2E-08 Batch PASS | PASS |
| AC-69 | E2E-09 Clean installation PASS | PASS |
| AC-70 | Forbidden TODO/mock/placeholder scan PASS | PASS |
| AC-71 | Known limitations documented | PASS |
| AC-72 | GitHub Actions Full verification gate PASS on Draft PR | PASS |

## Evidence

### Local clean-volume gate

- Command: `docker compose down -v --remove-orphans && ./scripts/verify.sh`
- Result: **PASS** (backend 20 tests; frontend 3; Playwright 2; classification + regression; pipeline DAG; batch; drift; audit; backup smoke)
- Git SHA at local PASS: `6e344c8e3d4c158a8c5d377bcf3e20fd7708b800`

### Screenshots

Under `artifacts/screenshots/` and `/opt/cursor/artifacts/`: home, projects, datasets, pipelines, registry, deployments, monitoring, alerts, audit, admin, plus Playwright captures.

### Known limitations

See `docs/KNOWN_LIMITATIONS.md`.
