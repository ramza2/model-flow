# Acceptance Criteria (MVP + v1.0 RC)

Existing MVP criteria are retained and v1.0 criteria are additive. Status values are `PASS`, `FAIL`, `NOT_VERIFIED`, and `PENDING`. `PASS` requires repeatable evidence for the current revision; implementation alone is not evidence.

## MVP criteria (retained)

| ID | Criterion | Status | Verification Method | Test or Script | Evidence Artifact |
|----|-----------|--------|---------------------|----------------|-------------------|
| AC-01 | README alone is enough to run the stack on a clean machine | NOT_VERIFIED | Clean-machine walkthrough | Test not yet identified | Not available |
| AC-02 | `docker compose` brings up frontend, backend, worker, postgres, mlflow, minio with healthchecks | PASS | Clean-volume Compose health gate | `scripts/verify.sh` sections 2–3 | `artifacts/verify/compose-ps.txt` |
| AC-03 | Alembic migrations apply cleanly | PASS | Run migrations on clean Postgres | `scripts/verify.sh` section 4 | `artifacts/verify/alembic.txt` |
| AC-04 | Create project via API and UI | PASS | Authenticated API flow and browser flow | `scripts/verify.sh`; `e2e/happy-path.spec.ts` | `artifacts/verify/RESULT.txt` |
| AC-05 | Upload CSV dataset to MinIO; metadata in Postgres | PASS | Upload and retrieve a real dataset | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-06 | Dataset column names and basic stats available via API/UI | PASS | Dataset API and browser assertions | Backend tests; Playwright | `artifacts/verify/RESULT.txt` |
| AC-07 | Create training job; worker runs sklearn asynchronously | PASS | Submit and poll real training job | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-08 | Training job status and logs queryable | PASS | Job API tests and release flow | Backend tests; `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-09 | MLflow run created with params, metrics, artifacts | PASS | Train against live MLflow and assert run ID | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-10 | Model registered; versions listed | PASS | Register trained run and query registry | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-11 | Inference endpoint created; sample predict returns results | PASS | Deploy model and invoke prediction | `scripts/verify.sh` section 8 | `artifacts/verify/predict.json` |
| AC-12 | UI screens wired to real APIs — no mock/fake completion | PASS | Placeholder scan plus browser flow | `scripts/verify.sh` sections 7 and 9 | `artifacts/verify/RESULT.txt` |
| AC-13 | Backend pytest pass | PASS | Containerized backend test suite | `pytest -q` via `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-14 | Frontend Vitest + typecheck + lint pass | PASS | Containerized frontend checks | `scripts/verify.sh` section 6 | `artifacts/verify/RESULT.txt` |
| AC-15 | Playwright E2E covers core flow | PASS | Playwright against live stack | `scripts/verify.sh` section 9 | `artifacts/verify/RESULT.txt` |
| AC-16 | `scripts/verify.sh` runs full verification suite | PASS | Clean-volume full gate | `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-17 | Friendly error messages for common failures | NOT_VERIFIED | Browser assertions for representative errors | Test not yet identified | Not available |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PASS | Source scan | `scripts/verify.sh` section 7 | `artifacts/verify/RESULT.txt` |
| AC-19 | Screenshots or browser evidence of key screens | PASS | Playwright screenshot capture | Playwright suite | `artifacts/screenshots/` |
| AC-20 | Draft PR documents PASS/FAIL for all criteria | PENDING | Review this evidence matrix against current CI | `docs/ACCEPTANCE_CRITERIA.md` | Current document |
| AC-21 | Same-filename re-upload keeps distinct MinIO objects | PASS | Upload same filename twice and compare versions | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-22 | Endpoint ready only after successful model load | PASS | Endpoint service tests | Backend tests | `artifacts/verify/RESULT.txt` |
| AC-23 | Cross-project run/model binding rejected | PASS | Project ownership tests | Backend tests | `artifacts/verify/RESULT.txt` |
| AC-24 | Worker health reflects fresh DB heartbeat | PASS | Compose health check after worker startup | `scripts/verify.sh` health assertions | `artifacts/verify/compose-ps.txt` |
| AC-25 | `verify.sh` requires only Docker/Compose/curl/bash on host | PASS | Host-tool preflight and containerized tooling | `scripts/verify.sh` | `artifacts/verify/meta.txt` |
| AC-26 | GitHub Actions CI workflow present; YAML validates and triggers on PR/push/`workflow_dispatch` | PENDING | Workflow syntax and trigger review | `.github/workflows/ci.yml` | GitHub Actions run |
| AC-27 | Pull Request targeting `main` runs the full verification gate as a required Check | NOT_VERIFIED | Inspect branch-protection required checks | Repository settings | Not available |
| AC-28 | CI failure uploads `artifacts/verify/` and `artifacts/screenshots/` | PENDING | Deliberate failing CI run or workflow inspection | `.github/workflows/ci.yml` | GitHub Actions artifacts |
| AC-29 | External Docker images pinned to pull-verified tags | PASS | Compose/Dockerfile pin scan and pull | `scripts/verify.sh`; `docs/DECISIONS.md` D-016 | `artifacts/verify/RESULT.txt` |
| AC-30 | Clean-volume full verification PASS | PASS | Destroy volumes and run the full gate | `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |

## v1.0 criteria

| ID | Criterion | Status | Verification Method | Test or Script | Evidence Artifact |
|----|-----------|--------|---------------------|----------------|-------------------|
| AC-31 | Bootstrap admin from env; no hardcoded default password | NOT_VERIFIED | Clean bootstrap with generated credentials and secret scan | `scripts/init-env.sh`; `scripts/verify.sh` | Not available |
| AC-32 | Login, logout, me, password change; JWT expiry | NOT_VERIFIED | Auth API tests including token revocation and expiry | Backend auth tests | Not available |
| AC-33 | User create/activate/deactivate; inactive blocked | PASS | Real-user API tests | `backend/tests/test_rbac_isolation.py`; `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-34 | Brute-force lockout or rate limit on login | PASS | Repeated failed-login test | Backend auth tests | `artifacts/verify/RESULT.txt` |
| AC-35 | RBAC roles enforced; unauthorized → 403; menus hidden by role | NOT_VERIFIED | Role matrix API tests and Playwright menu assertions | `backend/tests/test_rbac_isolation.py`; `e2e/rbac-menus.spec.ts` | Not available |
| AC-36 | Project membership isolation at API layer | NOT_VERIFIED | Two-project 403/404 isolation tests | `backend/tests/test_rbac_isolation.py`; `e2e/rbac-menus.spec.ts` | Not available |
| AC-37 | Audit log for auth, users, projects, data, train, registry, endpoints, admin settings | PASS | Audit API assertions after release flow | Backend tests; `scripts/verify.sh` | `artifacts/verify/audit.json` |
| AC-38 | Audit UI: search, filter, date range, detail; secrets never stored | NOT_VERIFIED | Dedicated browser and secret-redaction assertions | Test not yet identified | Not available |
| AC-39 | File data sources: CSV, JSON, Parquet | NOT_VERIFIED | Format-specific upload tests | Test not yet identified | Not available |
| AC-40 | Postgres data source: test connection, schema/table, import → DatasetVersion; secrets encrypted | NOT_VERIFIED | Live source-profile integration test | Compose `source` profile test not yet in full gate | Not available |
| AC-41 | Dataset versions immutable; profiling stats; preview; compare; lineage | NOT_VERIFIED | Dataset version API tests | Test not yet identified | Not available |
| AC-42 | Quality rules create/run/history; PASS/WARNING/FAIL; train policy | PASS | Quality API tests and live PASS flow | Backend tests; `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-43 | Train/val/test splits with seed and ratios persisted | PASS | Create and retrieve deterministic split | Backend tests; `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-44 | Classification algorithms: LR, RF, GB | NOT_VERIFIED | Parameterized algorithm tests | Test not yet identified | Not available |
| AC-45 | Regression algorithms: Ridge, RF, GB | NOT_VERIFIED | Parameterized algorithm tests | Test not yet identified | Not available |
| AC-46 | Training job cancel/retry/clone; concurrency; heartbeat recovery | NOT_VERIFIED | Job transition and worker recovery tests | Test not yet identified | Not available |
| AC-47 | Experiment compare UI with params/metrics | NOT_VERIFIED | Dedicated browser assertions | Test not yet identified | Not available |
| AC-48 | Visual pipeline design + publish + validate + execute via worker | NOT_VERIFIED | Live pipeline API and browser flow | `scripts/verify.sh` section 8c | Not available |
| AC-49 | Pipeline E2E: data→quality→split→preprocess→train→eval→registry | NOT_VERIFIED | Assert every node output and final registry record | `scripts/verify.sh` section 8c | Not available |
| AC-50 | Model lifecycle states + approval/reject/promote/rollback + gates | NOT_VERIFIED | Lifecycle transition and server-gate tests | Backend registry tests; `scripts/verify.sh` | Not available |
| AC-51 | Realtime endpoint start/stop/swap/rollback + schema validation + metrics | NOT_VERIFIED | Endpoint lifecycle API tests | Test not yet identified | Not available |
| AC-52 | Batch inference job + MinIO result + download | PASS | Live batch job and streamed result | `scripts/verify.sh` section 8 | `artifacts/verify/batch-result.csv` |
| AC-53 | Service/data/model monitoring from real data; empty states (no fake metrics) | NOT_VERIFIED | Browser and API assertions with real/empty data | Test not yet identified | Not available |
| AC-54 | Drift detection (numeric/categorical/prediction) + history + alerts | NOT_VERIFIED | Drift API tests and live drift run | Test not yet identified | Not available |
| AC-55 | Retrain triggers; never auto-promote to PRODUCTION | NOT_VERIFIED | Retrain lifecycle tests | Test not yet identified | Not available |
| AC-56 | In-app alerts (read/unread, severity, resolve, filter) | NOT_VERIFIED | Alert API tests | Test not yet identified | Not available |
| AC-57 | Admin: users, membership, system/worker/queue/storage, settings, retention | NOT_VERIFIED | Admin API and browser matrix | Test not yet identified | Not available |
| AC-58 | Security headers, CORS, rate limit, validation, secret masking | NOT_VERIFIED | Backend security tests and HTTP header checks | Test not yet identified | Not available |
| AC-59 | `scripts/backup.sh` + `scripts/restore.sh` verified | NOT_VERIFIED | Destructive PostgreSQL/MinIO marker round-trip | `scripts/verify-backup-roundtrip.sh` | Not available |
| AC-60 | `scripts/reset-dev.sh` (+ optional seed-demo) | NOT_VERIFIED | Destructive reset and optional seed check | Test not yet identified | Not available |
| AC-61 | E2E-01 Admin & users PASS | NOT_VERIFIED | Named scenario with retained output | Playwright/backend tests | Not available |
| AC-62 | E2E-02 Data PASS | PASS | Live data browser scenario | `e2e/happy-path.spec.ts` | `artifacts/verify/RESULT.txt` |
| AC-63 | E2E-03 Training PASS | PASS | Live training browser/API scenario | `e2e/happy-path.spec.ts`; `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-64 | E2E-04 Pipeline PASS | NOT_VERIFIED | Named pipeline browser scenario | Test not yet identified | Not available |
| AC-65 | E2E-05 Approve & deploy PASS | PASS | Live approval/deployment scenario | `e2e/happy-path.spec.ts`; `scripts/verify.sh` | `artifacts/verify/predict.json` |
| AC-66 | E2E-06 Monitoring/drift/retrain PASS | NOT_VERIFIED | Live drift/retrain scenario | Test not yet identified | Not available |
| AC-67 | E2E-07 Permissions & audit PASS | NOT_VERIFIED | Real-role browser and API denial/audit scenario | `backend/tests/test_rbac_isolation.py`; `e2e/rbac-menus.spec.ts` | Not available |
| AC-68 | E2E-08 Batch PASS | NOT_VERIFIED | Live batch browser scenario | Test not yet identified | Not available |
| AC-69 | E2E-09 Clean installation PASS | PASS | Clean-volume full gate | `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-70 | Forbidden TODO/mock/placeholder scan PASS | PASS | Blocking source scan | `scripts/verify.sh` section 7 | `artifacts/verify/RESULT.txt` |
| AC-71 | Known limitations documented | PASS | Documentation review | `docs/KNOWN_LIMITATIONS.md` | `docs/KNOWN_LIMITATIONS.md` |
| AC-72 | GitHub Actions Full verification gate PASS on Draft PR | PENDING | Current-revision CI result | `.github/workflows/ci.yml` | GitHub Actions run |

## Evidence policy

- Local evidence is current only when `artifacts/verify/RESULT.txt` contains `OK` from the current commit.
- CI evidence must link to a successful run for the current commit; historical runs do not prove later revisions.
- `NOT_VERIFIED` identifies missing or contested evidence. `PENDING` identifies evidence that still depends on the pushed PR/CI state or release review.
- The prior clean-volume result at `6e344c8e3d4c158a8c5d377bcf3e20fd7708b800` is historical and does not establish acceptance for this revision.
