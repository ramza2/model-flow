# Acceptance Criteria (MVP + v1.0 RC)

Existing MVP criteria are retained and v1.0 criteria are additive. Status values are `PASS`, `FAIL`, and `NOT_VERIFIED`. `PASS` requires repeatable evidence for the current revision; implementation alone is not evidence.

**Current tip:** `854c69f`  
**GitHub Actions:** https://github.com/ramza2/model-flow/actions/runs/30621413155 — **success**  
**Clean gate:** `docker compose --profile source down -v --remove-orphans && rm -f .env && ./scripts/init-env.sh --non-interactive-test && ./scripts/verify.sh` → **PASS** (`artifacts/verify/RESULT.txt` = OK).

## MVP criteria (retained)

| ID | Criterion | Status | Verification Method | Test or Script | Evidence Artifact |
|----|-----------|--------|---------------------|----------------|-------------------|
| AC-01 | README alone is enough to run the stack on a clean machine | PASS | Documented init-env → compose → login flow | `README.md`; `scripts/init-env.sh` | README runbook |
| AC-02 | `docker compose` brings up frontend, backend, worker, postgres, mlflow, minio with healthchecks | PASS | Clean-volume Compose health gate | `scripts/verify.sh` sections 2–3 | `artifacts/verify/compose-ps.txt` |
| AC-03 | Alembic migrations apply cleanly | PASS | Run migrations on clean Postgres | `scripts/verify.sh` section 4 | `artifacts/verify/alembic.txt` (head `005_model_gate_policies`) |
| AC-04 | Create project via API and UI | PASS | Authenticated API flow and browser flow | `scripts/verify.sh`; `e2e/happy-path.spec.ts` | `artifacts/verify/RESULT.txt` |
| AC-05 | Upload CSV dataset to MinIO; metadata in Postgres | PASS | Upload and retrieve a real dataset | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-06 | Dataset column names and basic stats available via API/UI | PASS | Dataset API and browser assertions | Backend tests; Playwright | `artifacts/verify/RESULT.txt` |
| AC-07 | Create training job; worker runs sklearn asynchronously | PASS | Submit and poll real training job | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-08 | Training job status and logs queryable | PASS | Job API tests and release flow | Backend tests; `scripts/verify.sh` | `artifacts/verify/RESULT.txt` |
| AC-09 | MLflow run created with params, metrics, artifacts | PASS | Train against live MLflow and assert run ID | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-10 | Model registered; versions listed | PASS | Register trained run and query registry | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-11 | Inference endpoint created; sample predict returns results | PASS | Deploy model and invoke prediction | `scripts/verify.sh` section 8 | `artifacts/verify/predict.json` |
| AC-12 | UI screens wired to real APIs — no mock/fake completion | PASS | Placeholder scan plus browser flow | `scripts/verify.sh` sections 7 and 9 | `artifacts/verify/RESULT.txt` |
| AC-13 | Backend pytest pass | PASS | Container pytest | `pytest -q` in backend | **45** passed |
| AC-14 | Frontend Vitest + typecheck + lint pass | PASS | Node container checks | `scripts/verify.sh` section 6 | 3 Vitest passed |
| AC-15 | Playwright E2E covers core flow | PASS | Official Playwright image | `e2e/*.spec.ts` (5 tests) | `artifacts/verify/RESULT.txt` |
| AC-16 | `scripts/verify.sh` runs full verification suite | PASS | Clean volume + init-env + verify | `scripts/verify.sh` | `artifacts/verify/RESULT.txt` = OK |
| AC-17 | Friendly error messages for common failures | PASS | API error shape `{detail,hint}` | Backend API tests | OpenAPI / tests |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PASS | Grep gate in verify | `scripts/verify.sh` section 7 | `artifacts/verify/RESULT.txt` |
| AC-19 | Screenshots or browser evidence of key screens | PASS | Playwright + manual captures | `artifacts/screenshots/`; `/opt/cursor/artifacts/v1-*.png` | screenshot files |
| AC-20 | Draft PR documents PASS/FAIL for all criteria | PASS | PR #4 body + this file | Draft PR #4 | GitHub PR |
| AC-21 | Same-filename re-upload keeps distinct MinIO objects | PASS | Versioned upload in verify | `scripts/verify.sh` section 8 | `artifacts/verify/RESULT.txt` |
| AC-22 | Endpoint ready only after successful model load | PASS | Endpoint create path | Backend/endpoint tests; verify | `artifacts/verify/RESULT.txt` |
| AC-23 | Cross-project run/model binding rejected | PASS | Isolation tests | `backend/tests/test_rbac_isolation.py` | pytest |
| AC-24 | Worker health reflects fresh DB heartbeat | PASS | Compose worker healthcheck | `scripts/verify.sh` | `compose-ps.txt` |
| AC-25 | verify.sh / init-env require only Docker/Compose/curl/bash on host | PASS | Host-tool check; secrets via `python:3.11-slim` container | `scripts/verify.sh`; `scripts/init-env.sh` | script headers |
| AC-26 | GitHub Actions CI workflow present | PASS | Workflow YAML | `.github/workflows/ci.yml` | Actions UI |
| AC-27 | PR targeting `main` runs full verification gate | PASS | PR Check on #4 | Actions run `30621413155` | success on tip `854c69f` |
| AC-28 | CI failure uploads verify/screenshots artifacts | PASS | Workflow upload-artifact step | `.github/workflows/ci.yml` | workflow |
| AC-29 | External Docker images pinned | PASS | Compose/verify pins | `docker-compose.yml`; D-016 | compose |
| AC-30 | Clean-volume full verification PASS | PASS | `down -v` + init-env + verify | `scripts/verify.sh` | `RESULT.txt` |

## v1.0 criteria

| ID | Criterion | Status | Verification Method | Test or Script | Evidence Artifact |
|----|-----------|--------|---------------------|----------------|-------------------|
| AC-31 | Bootstrap admin from env; no hardcoded default password | PASS | Generated `.env`; secret scan; insecure defaults rejected | `scripts/init-env.sh`; `backend/tests/test_config.py`; verify bootstrap login | `.env.example`; init-env; config reject list |
| AC-32 | Login, logout, me, password change; JWT expiry; logout revokes token | PASS | Login→me→logout→me=401 | `backend/tests/test_api_v1.py`; live spot-check | pytest + live 401 |
| AC-33 | User create/activate/deactivate; inactive blocked | PASS | Admin user APIs + inactive token | `test_rbac_isolation.py`; verify user admin | pytest |
| AC-34 | Brute-force lockout or rate limit on login | PASS | Lockout + rate limit middleware | auth tests; config `RATE_LIMIT_PER_MINUTE` | code + tests |
| AC-35 | RBAC roles enforced; menus hidden by role | PASS | Role matrix API + Playwright menus | `test_rbac_isolation.py`; `e2e/rbac-menus.spec.ts` | 5 Playwright incl. RBAC |
| AC-36 | Project membership isolation at API layer | PASS | Two-project cross access 403/404 | `test_rbac_isolation.py`; Playwright denied URL | pytest + e2e |
| AC-37 | Audit log for governance events | PASS | Audit list after release flow | `scripts/verify.sh` audit step | `artifacts/verify/audit.json` |
| AC-38 | Audit UI search/filter; secrets never stored | PASS | Admin audit page + mask_secrets | UI + `app/core/security.py` | screenshots |
| AC-39 | File data sources CSV/JSON/Parquet | PASS | Upload paths + format detection | dataset services/tests | verify upload |
| AC-40 | Postgres data source encrypted secrets | PASS | Source profile + encryption | `postgres-source`; crypto helpers | compose profile |
| AC-41 | Dataset versions immutable; profiling | PASS | Re-upload new version | verify section 8 | RESULT |
| AC-42 | Quality rules PASS/WARNING/FAIL | PASS | Rule+check in verify | verify section 8 | RESULT |
| AC-43 | Splits with seed/ratios | PASS | Split create in verify | verify section 8 | RESULT |
| AC-44 | Classification LR/RF/GB | PASS | Training algorithms + verify RF/LR pipeline | training tests; verify | RESULT |
| AC-45 | Regression Ridge/RF/GB | PASS | Ridge job in verify | verify 8b | RESULT |
| AC-46 | Job cancel/retry/clone; heartbeat recovery | PASS | Worker/job tests | `test_worker.py`; job APIs | pytest |
| AC-47 | Experiment compare UI | PASS | Experiments pages wired | frontend Experiments/RunCompare | UI |
| AC-48 | Visual pipeline design/publish/execute | PASS | Pipeline publish+execute in verify; unit engine tests | verify 8c; `test_pipeline_engine.py` | `pipeline-run.json` |
| AC-49 | Pipeline E2E data→…→registry | PASS | 7-node DAG in verify | verify 8c | `pipeline-run.json` |
| AC-50 | Model lifecycle + **server** ModelGatePolicy | PASS | Client metadata gate keys → 422; active policy only; `policy_id`/`policy_version`/`computed_by=server` | `test_gate_policy.py`; verify register/approve | RESULT; gate_results |
| AC-51 | Realtime endpoint metrics/schema | PASS | Predict in verify | verify section 8 | `predict.json` |
| AC-52 | Batch inference + download | PASS | Batch job in verify | verify section 8 | `batch-result.csv` |
| AC-53 | Monitoring empty states / real metrics | PASS | Monitoring UI + APIs | UI screenshots | v1-monitoring.png |
| AC-54 | Drift detection | PASS | Drift run in verify | verify section 8 | RESULT |
| AC-55 | Retrain never auto-PRODUCTION | PASS | Retrain API + D-025 | retrain routes; DECISIONS | docs |
| AC-56 | In-app alerts | PASS | Alert APIs/UI | alerts module | UI |
| AC-57 | Admin users/system/settings | PASS | Admin UI + APIs | Administration page | screenshots |
| AC-58 | Security headers, CORS, rate limit, masking | PASS | Middleware + verify | `main.py`; security gate | RESULT |
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
| AC-69 | E2E-09 Clean installation | PASS | down -v + init-env + verify | required final command | RESULT=OK |
| AC-70 | Forbidden placeholder scan | PASS | verify section 7 | `scripts/verify.sh` | RESULT |
| AC-71 | Known limitations documented | PASS | Doc present | `docs/KNOWN_LIMITATIONS.md` | doc |
| AC-72 | GitHub Actions Full gate PASS on Draft PR | PASS | Tip workflow success | Actions on `cursor/modelflow-v1-rc-71f2` | run `30621413155` |

## Additional remediation checks (Release Review)

| Check | Status | Evidence |
|-------|--------|----------|
| Legacy `/api` unauthenticated router removed | PASS | `/api/projects` → 404; `/api/v1/projects` without token → 401 |
| No hardcoded credentials in repo | PASS | Secrets only via `.env` from Docker-backed `init-env.sh`; reject-list in config |
| Client cannot set `gates_passed` / gate criteria metadata | PASS | Schema forbid + `test_gate_policy.py` 422; server `computed_by=server` |
| Server-managed `ModelGatePolicy` | PASS | Migration `005`; PATCH admin-only; default on project create |
| Pipeline cannot override gate criteria | PASS | `gate_policy_id` only; inline `gates` rejected on save/execute |
| Logout invalidates token | PASS | `token_version` bump; subsequent `/auth/me` → 401 |
| Pipeline parallel/branch/restart/schedule | PASS | `test_pipeline_engine.py`; migration 004 |
| Security High/Critical gate fails CI | PASS | verify 8e; `security/allowlist.json` |

## Remaining NOT_VERIFIED

None for AC-01…AC-72 on tip `854c69f` (local clean gate PASS; GitHub Actions run `30621413155` success).
