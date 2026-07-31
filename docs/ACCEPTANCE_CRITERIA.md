# Acceptance Criteria (MVP)

Each item must be PASS before completion is declared.

| ID | Criterion | Status |
|----|-----------|--------|
| AC-01 | README alone is enough to run the stack on a clean machine | PENDING |
| AC-02 | `docker compose` brings up frontend, backend, worker, postgres, mlflow, minio with healthchecks | PENDING |
| AC-03 | Alembic migrations apply cleanly | PENDING |
| AC-04 | Create project via API and UI | PENDING |
| AC-05 | Upload CSV dataset to MinIO; metadata in Postgres | PENDING |
| AC-06 | Dataset column names and basic stats available via API/UI | PENDING |
| AC-07 | Create training job; worker runs sklearn asynchronously | PENDING |
| AC-08 | Training job status and logs queryable | PENDING |
| AC-09 | MLflow run created with params, metrics, artifacts | PENDING |
| AC-10 | Model registered in MLflow Model Registry; versions listed | PENDING |
| AC-11 | Inference endpoint created; sample predict returns results | PENDING |
| AC-12 | UI screens (15 required) wired to real APIs — no mock/fake completion | PENDING |
| AC-13 | Backend pytest pass | PENDING |
| AC-14 | Frontend Vitest + typecheck + lint pass | PENDING |
| AC-15 | Playwright E2E covers core flow | PENDING |
| AC-16 | `scripts/verify.sh` runs full verification suite | PENDING |
| AC-17 | Friendly error messages for common failures | PENDING |
| AC-18 | No infra jargon (Pod/Namespace/K8s) on primary UI | PENDING |
| AC-19 | Screenshots or browser evidence of key screens | PENDING |
| AC-20 | Draft PR documents PASS/FAIL for all criteria | PENDING |

Update Status to PASS/FAIL as verification completes.
