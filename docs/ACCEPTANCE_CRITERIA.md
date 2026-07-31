# Acceptance Criteria (MVP)

Each item must be PASS before completion is declared.

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
| AC-10 | Model registered in MLflow Model Registry; versions listed | PASS |
| AC-11 | Inference endpoint created; sample predict returns results | PASS |
| AC-12 | UI screens (15 required) wired to real APIs — no mock/fake completion | PASS |
| AC-13 | Backend pytest pass | PASS |
| AC-14 | Frontend Vitest + typecheck + lint pass | PASS |
| AC-15 | Playwright E2E covers core flow | PASS |
| AC-16 | `scripts/verify.sh` runs full verification suite | PASS |
| AC-17 | Friendly error messages for common failures | PASS |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PASS |
| AC-19 | Screenshots or browser evidence of key screens | PASS |
| AC-20 | Draft PR documents PASS/FAIL for all criteria | PASS |

## Evidence (2026-07-31)

- Compose health: backend/frontend/mlflow/postgres/minio healthy; API system status all `ok`.
- API flow: train succeeded (`accuracy=1.0`), MLflow run logged, model `project-1-classifier` v1 registered, predict returned `[0]`.
- Playwright: `e2e/happy-path.spec.ts` passed (~7s); screenshots under `artifacts/screenshots/`.
- Backend: `pytest` 6 passed; `ruff check` clean.
- Frontend: `typecheck` clean; `eslint` warnings only (hooks deps); `vitest` 1 passed; production build OK.
