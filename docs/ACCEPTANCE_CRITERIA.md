# Acceptance Criteria — v1.0 GA Candidate

This document records **v1.0 GA readiness evidence**. It does **not** mean
`v1.0.0` has been tagged or published.

Status values are `PASS`, `FAIL`, and `NOT_VERIFIED`. `PASS` requires repeatable
evidence for the referenced revision; implementation alone is not evidence.
Final packaging-SHA Full Gate attestation remains **Phase 10-D** work.

## Phase 10-C evidence baseline

| Field | Value |
|---|---|
| Evidence baseline SHA | `1973860d4d3d7d0fd87ddbb662c940397b1735a7` |
| Merge | PR #98 (`docs: truth up GA candidate documentation`) |
| GitHub Actions | [CI #517](https://github.com/ramza2/model-flow/actions/runs/38696787666) / run id `38696787666` |
| Event | `push` |
| Job | Full verification gate |
| Exact SHA match | yes |
| Conclusion | **SUCCESS** |
| Alembic head | `024_oidc_enterprise_identity` |
| Clean gate | `./scripts/verify.sh` (isolated Compose project; does not rewrite project `.env`) |

This is the **Phase 10-C evidence baseline**, not the final GA packaging SHA.
A separate Full Gate SUCCESS on the future packaging tip is required before
`v1.0.0` is tagged (see AC-72).

## MVP criteria (retained)

| ID | Criterion | Status | Verification Method | Test or Script | Evidence Artifact |
|----|-----------|--------|---------------------|----------------|-------------------|
| AC-01 | README alone is enough to run the stack on a clean machine | PASS | Documented init-env → compose → login flow | `README.md`; `scripts/init-env.sh` | README runbook |
| AC-02 | `docker compose` brings up frontend, backend, worker, postgres, mlflow, minio, and dedicated `inference-runtime` with healthchecks | PASS | Clean-volume Compose health gate | `scripts/verify.sh` sections 2–3 | `artifacts/verify/compose-ps.txt`; Full Gate #517 |
| AC-03 | Alembic migrations apply cleanly to current head | PASS | Run migrations on clean Postgres | `scripts/verify.sh` section 4 | `artifacts/verify/alembic.txt` (head `024_oidc_enterprise_identity`); Full Gate #517 |
| AC-04 | Create project via API and UI | PASS | Authenticated API flow and browser flow | `scripts/verify.sh`; `e2e/happy-path.spec.ts` | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-05 | Upload CSV dataset to MinIO; metadata in Postgres | PASS | Upload and retrieve a real dataset | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-06 | Dataset column names and basic stats available via API/UI | PASS | Dataset API and browser assertions | Backend tests; Playwright | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-07 | Create training job; worker runs sklearn asynchronously | PASS | Submit and poll real training job | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-08 | Training job status and logs queryable | PASS | Job API tests and release flow | Backend tests; `scripts/verify.sh` | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-09 | MLflow run created with params, metrics, artifacts | PASS | Train against live MLflow and assert run ID | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-10 | Model registered; versions listed | PASS | Register trained run and query registry | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-11 | Inference endpoint created; sample predict returns results via internal `inference-runtime` | PASS | Deploy model and invoke prediction (control-plane Endpoint API; runtime executes load/predict) | `scripts/verify.sh` section 8 | `artifacts/verify/predict.json`; Full Gate #517 |
| AC-12 | UI screens wired to real APIs — no mock/fake completion | PASS | Placeholder scan plus browser flow | `scripts/verify.sh` sections 7 and 9 | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-13 | Backend pytest pass | PASS | Container pytest in Full Gate | `scripts/verify.sh` backend test section | Full Gate #517 SUCCESS (backend pytest PASS) |
| AC-14 | Frontend Vitest + typecheck + lint pass | PASS | Node container checks in Full Gate | `scripts/verify.sh` section 6 | Full Gate #517 SUCCESS (frontend lint/typecheck/Vitest PASS) |
| AC-15 | Playwright E2E covers core flow | PASS | Official Playwright image in Full Gate | `e2e/*.spec.ts` | Full Gate #517 SUCCESS (Playwright E2E PASS) |
| AC-16 | `scripts/verify.sh` runs full verification suite | PASS | Clean volume + init-env + verify | `scripts/verify.sh` | `artifacts/verify/RESULT.txt` = OK; Full Gate #517 |
| AC-17 | Friendly error messages for common failures | PASS | API error shape `{detail,hint}` | Backend API tests | OpenAPI / tests |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PASS | Grep gate in verify | `scripts/verify.sh` section 7 | `artifacts/verify/RESULT.txt` |
| AC-19 | Screenshots or browser evidence of key screens | PASS | Playwright + manual captures | `artifacts/screenshots/` | screenshot files |
| AC-20 | Release documentation records PASS/FAIL for criteria | PASS | This file + `docs/PROGRESS.md` + Phase 10 readiness | Docs on `main` | GitHub |
| AC-21 | Same-filename re-upload keeps distinct MinIO objects | PASS | Versioned upload in verify | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-22 | Endpoint ready only after successful model load through `inference-runtime` | PASS | Endpoint create/load-check fails closed if runtime load fails | Backend/endpoint tests; verify | `artifacts/verify/RESULT.txt`; Full Gate #517 |
| AC-23 | Cross-project run/model binding rejected | PASS | Isolation tests | `backend/tests/test_rbac_isolation.py` | pytest |
| AC-24 | Worker health reflects fresh DB heartbeat | PASS | Compose worker healthcheck | `scripts/verify.sh` | `compose-ps.txt` |
| AC-25 | verify.sh / init-env require only Docker/Compose/curl/bash on host | PASS | Host-tool check; secrets via `python:3.11-slim` container | `scripts/verify.sh`; `scripts/init-env.sh` | script headers |
| AC-26 | GitHub Actions CI workflow present | PASS | Workflow YAML | `.github/workflows/ci.yml` | Actions UI |
| AC-27 | CI contract: PR→`main` uses changed-file PR Fast Gate (docs-only lightweight when applicable; conditional backend/frontend/infra fast jobs; aggregate `PR fast gate`); Full verification gate on push→`main` and `workflow_dispatch` | PASS | Inspect `.github/workflows/ci.yml` triggers and job graph | `.github/workflows/ci.yml`; D-017 | Actions UI; README CI table. Historical only: Phase 8-F PR-title full-gate exception during that closeout. |
| AC-28 | Full verification gate failure uploads verify/screenshots artifacts | PASS | Workflow upload-artifact step on Full Gate | `.github/workflows/ci.yml` | workflow |
| AC-29 | External Docker images pinned | PASS | Compose/verify pins | `docker-compose.yml`; D-016 | compose |
| AC-30 | Clean-volume full verification PASS | PASS | Isolated verify stack | `scripts/verify.sh` | `RESULT.txt`; Full Gate #517 |

## v1.0 criteria

| ID | Criterion | Status | Verification Method | Test or Script | Evidence Artifact |
|----|-----------|--------|---------------------|----------------|-------------------|
| AC-31 | Bootstrap admin from env; no hardcoded default password | PASS | Generated `.env`; secret scan; insecure defaults rejected | `scripts/init-env.sh`; `backend/tests/test_config.py`; verify bootstrap login | `.env.example`; init-env; config reject list |
| AC-32 | Login, logout, me, password change; JWT expiry; logout revokes token; local login retained with optional OIDC | PASS | Login→me→logout→me=401; OIDC optional (`MODELFLOW_OIDC_*`) | `backend/tests/test_api_v1.py`; `test_oidc.py`; live spot-check | pytest + live 401; D-046 |
| AC-33 | User create/activate/deactivate; inactive blocked | PASS | Admin user APIs + inactive token | `test_rbac_isolation.py`; verify user admin | pytest |
| AC-34 | Brute-force lockout or rate limit on login | PASS | Lockout + rate limit middleware | auth tests; config `RATE_LIMIT_PER_MINUTE` | code + tests |
| AC-35 | RBAC roles enforced; menus hidden by role | PASS | Role matrix API + Playwright menus | `test_rbac_isolation.py`; `e2e/rbac-menus.spec.ts` | Playwright RBAC specs |
| AC-36 | Project membership isolation at API layer | PASS | Two-project cross access 403/404 | `test_rbac_isolation.py`; Playwright denied URL | pytest + e2e |
| AC-37 | Audit log for governance events | PASS | Audit list after release flow | `scripts/verify.sh` audit step | `artifacts/verify/audit.json` |
| AC-38 | Audit UI search/filter; secrets never stored | PASS | Admin audit page + mask_secrets | UI + `app/core/security.py` | screenshots |
| AC-39 | File data sources CSV/JSON/Parquet | PASS | Upload paths + format detection | dataset services/tests | verify upload |
| AC-40 | Connector data sources encrypt secrets; typed forms / DSN modes without secret disclosure (Postgres + MySQL/MariaDB + MSSQL + Oracle + REST as shipped) | PASS | Connector lifecycle + E2E + phase verification | `test_data_source_lifecycle.py`; connector tests; `e2e/data-sources-ops.spec.ts`; D-034 / D-039–D-041; `docs/phase-4-connectors.md` | pytest + Playwright + phase-4 docs |
| AC-41 | Dataset versions immutable; profiling | PASS | Re-upload new version | verify section 8 | RESULT |
| AC-42 | Quality rules PASS/WARNING/FAIL | PASS | Rule+check in verify | verify section 8 | RESULT |
| AC-43 | Splits with seed/ratios | PASS | Split create in verify | verify section 8 | RESULT |
| AC-44 | Classification LR/RF/GB | PASS | Training algorithms + verify RF/LR pipeline | training tests; verify | RESULT |
| AC-45 | Regression Ridge/RF/GB | PASS | Ridge job in verify | verify 8b | RESULT |
| AC-46 | Job cancel/retry/clone; heartbeat recovery; worker scale-out safe claims | PASS | Worker/job tests; Phase 8-B | `test_worker.py`; job APIs; `docs/phase-8b-verification.md` | pytest + phase docs |
| AC-47 | Experiment compare UI | PASS | Experiments pages wired | frontend Experiments/RunCompare | UI |
| AC-48 | Visual pipeline design/publish/execute | PASS | Pipeline publish+execute in verify; unit engine tests | verify 8c; `test_pipeline_engine.py` | `pipeline-run.json` |
| AC-49 | Pipeline E2E data→…→registry | PASS | 7-node DAG in verify | verify 8c | `pipeline-run.json` |
| AC-50 | Model lifecycle + **server** ModelGatePolicy | PASS | Client metadata gate keys → 422; active policy only; `policy_id`/`policy_version`/`computed_by=server` | `test_gate_policy.py`; verify register/approve | RESULT; gate_results |
| AC-51 | Realtime endpoint metrics/schema (execution via inference-runtime) | PASS | Predict in verify | verify section 8; `docs/phase-8a-verification.md` | `predict.json` |
| AC-52 | Batch inference + download (runtime-backed) | PASS | Batch job in verify | verify section 8 | `batch-result.csv` |
| AC-53 | Monitoring empty states / real metrics | PASS | Monitoring UI + APIs | UI screenshots | v1-monitoring.png |
| AC-54 | Drift detection | PASS | Drift run in verify | verify section 8 | RESULT |
| AC-55 | Retrain / closed-loop never auto-PRODUCTION | PASS | Retrain API + D-025 + Phase 5 docs | retrain routes; DECISIONS; closed-loop phase docs | docs + tests |
| AC-56 | In-app alerts | PASS | Alert APIs/UI | alerts module | UI |
| AC-57 | Admin users/system/settings | PASS | Admin UI + APIs | Administration page | screenshots |
| AC-58 | Security headers, CORS, rate limit, masking; optional `*_FILE` secrets | PASS | Middleware + verify + Phase 8-D | `main.py`; security gate; D-047 | RESULT |
| AC-59 | Backup·Restore **round-trip** | PASS | Marker DB+MinIO backup→mutate→restore→checksum + health/login/predict | `scripts/verify-backup-roundtrip.sh` | `artifacts/verify/backup-roundtrip-*` |
| AC-60 | reset-dev + seed-demo | PASS | Scripts present and env-aware | `scripts/reset-dev.sh`; `seed-demo.sh` | scripts |
| AC-61 | E2E-01 Admin & users | PASS | Verify user admin + Playwright auth | verify; `auth-navigation`/`rbac-menus` | RESULT |
| AC-62 | E2E-02 Data | PASS | Upload/quality/split | verify section 8 | RESULT |
| AC-63 | E2E-03 Training | PASS | Classification+regression | verify 8/8b | RESULT |
| AC-64 | E2E-04 Pipeline | PASS | Pipeline DAG execute | verify 8c; pipeline engine tests | `pipeline-run.json` |
| AC-65 | E2E-05 Approve & deploy | PASS | Server gates→approve→endpoint→predict | verify section 8 | `predict.json` |
| AC-66 | E2E-06 Monitoring/drift | PASS | Drift + monitoring | verify drift | RESULT |
| AC-67 | E2E-07 Permissions & audit | PASS | RBAC isolation + menus + audit | `test_rbac_isolation.py`; `rbac-menus.spec.ts`; audit.json | pytest + e2e |
| AC-68 | E2E-08 Batch | PASS | Batch download | verify | `batch-result.csv` |
| AC-69 | E2E-09 Clean installation | PASS | down -v + init-env + verify | required final command | RESULT=OK; Full Gate #517 |
| AC-70 | Forbidden placeholder scan | PASS | verify section 7 | `scripts/verify.sh` | RESULT |
| AC-71 | Known limitations documented and current | PASS | Doc present after Phase 10-B truth-up | `docs/KNOWN_LIMITATIONS.md` | doc |
| AC-72 | GitHub Actions Full Gate PASS on the **final packaging SHA** before `v1.0.0` tag | NOT_VERIFIED | Final packaging SHA does not exist yet | `.github/workflows/ci.yml`; Phase 10-D ordering | Phase 10-C baseline: Full Gate [#517](https://github.com/ramza2/model-flow/actions/runs/38696787666) SUCCESS on `1973860` (evidence only). **Pending Phase 10-D final packaging-SHA Full Gate.** |

## Additional remediation checks (Release Review)

| Check | Status | Evidence |
|-------|--------|----------|
| Legacy `/api` unauthenticated router removed | PASS | `/api/projects` → 404; `/api/v1/projects` without token → 401 |
| No hardcoded credentials in repo | PASS | Secrets only via `.env` from Docker-backed `init-env.sh`; reject-list in config |
| Client cannot set `gates_passed` / gate criteria metadata | PASS | Schema forbid + `test_gate_policy.py` 422; server `computed_by=server` |
| Server-managed `ModelGatePolicy` | PASS | Introduced historically in migration `005`; current Alembic head `024_oidc_enterprise_identity`; PATCH admin-only; default on project create |
| Pipeline cannot override gate criteria | PASS | `gate_policy_id` only; inline `gates` rejected on save/execute |
| Logout invalidates token | PASS | `token_version` bump; subsequent `/auth/me` → 401 |
| Pipeline parallel/branch/restart/schedule | PASS | `test_pipeline_engine.py`; scheduling docs |
| Security High/Critical gate fails CI | PASS | verify 8e; `security/allowlist.json`; D-033 |
| Postgres DSN/URL edit compatibility without secret leakage | PASS | PR #20; D-034; lifecycle + E2E |
| Training E2E Datasets heading selector stable under strict mode | PASS | PR #22; `exact: true` in `e2e/training-ux.spec.ts` |
| Helm/Kubernetes chart present with external durable-state boundary | PASS | `deploy/helm/model-flow`; `docs/DEPLOYMENT_KUBERNETES.md`; D-048; `scripts/test-kubernetes-helm.sh` in Full Gate |

## Post-RC enhancement acceptance evidence

One row per completed enhancement scope. Evidence is the recorded phase verification
doc and/or merge + post-merge CI already tracked in `docs/PROGRESS.md` — not a claim
that every phase re-ran on SHA `1973860`.

| Phase / scope | Status | Evidence source |
|---|---|---|
| Phase 1 — Scheduling / Automation | PASS | `docs/SCHEDULING.md`; Schedules UI/API; Full Gate schedule coverage; `docs/PROGRESS.md` / roadmap |
| Phase 1.1 — Retraining Foundation | PASS | Retrain lineage APIs/UI; D-025; `docs/PROGRESS.md` |
| Phase 1.2 — Multi-output Regression | PASS | Multi-output training/serving semantics; `docs/PROGRESS.md` |
| Phase 1.5 — UX Architecture / Frontend UX | PASS | Phase 1.5 docs; PRs #34–#36; browser smoke recorded in `docs/PROGRESS.md` |
| Phase 2 — Multi-dataset & Visual Data Preparation | PASS | [`phase-2g-verification.md`](./phase-2g-verification.md); PRs #38–#45 |
| Phase 3 — End-to-End Pipeline UX | PASS | [`phase-3d-verification.md`](./phase-3d-verification.md); PRs #46–#50 |
| Phase 4 — Connectors (Postgres / MySQL-MariaDB / MSSQL / Oracle / REST) | PASS | [`phase-4e-verification.md`](./phase-4e-verification.md); [`phase-4-connectors.md`](./phase-4-connectors.md); PRs #52–#57 |
| Phase 5 / 5.1 — Closed-loop MLOps / Feedback / Continued Training | PASS | [`phase-5d-verification.md`](./phase-5d-verification.md); related 5a–5c verification docs; continued-training PR evidence in `docs/PROGRESS.md` |
| Phase 6 — Time-aware / Multi-step Forecasting | PASS | [`phase-6d-verification.md`](./phase-6d-verification.md); PRs #65–#69 |
| Phase 7 — LLM Pipeline Copilot | PASS | [`phase-7d-verification.md`](./phase-7d-verification.md); PRs #70–#74 |
| Phase 8 — Enterprise / Scale (inference-runtime, workers, OIDC, `*_FILE`, Helm/K8s) | PASS | [`phase-8a-verification.md`](./phase-8a-verification.md); [`phase-8b-verification.md`](./phase-8b-verification.md); [`phase-8f-verification.md`](./phase-8f-verification.md); PRs #76–#86 |
| Phase 9 — Final Visual Redesign / Accessibility / Responsive | PASS | [`phase-9-final-visual-redesign.md`](./phase-9-final-visual-redesign.md); PR #96; Chrome browser review PASS; Full Gate #512 on `9e3f6e3` |

## Remaining NOT_VERIFIED

| ID | Item | Notes |
|----|------|-------|
| AC-72 | Final packaging-SHA Full Gate before `v1.0.0` tag | Pending Phase 10-D. Phase 10-C baseline #517 SUCCESS on `1973860` is evidence only and does **not** satisfy the packaging attestation. |

Accepted product limitations (sklearn-only, no LDAP, no auto-PRODUCTION, external-state K8s HA, etc.) are documented in `docs/KNOWN_LIMITATIONS.md` and are **not** listed as NOT_VERIFIED failures.
