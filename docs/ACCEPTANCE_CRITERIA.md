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
| AC-21 | Same-filename re-upload keeps distinct MinIO objects | PASS |
| AC-22 | Endpoint ready only after successful model load | PASS |
| AC-23 | Cross-project run/model binding rejected | PASS |
| AC-24 | Worker health reflects fresh DB heartbeat | PASS |
| AC-25 | verify.sh requires only Docker/Compose/curl/bash on host | PASS |

## Evidence (re-verified after review fixes)

- Clean volumes: `docker compose down -v` then `./scripts/verify.sh` **PASS**
- Compose health (frontend/backend/worker/postgres/mlflow/minio) all `healthy`
- Alembic head: `002_worker_heartbeats`
- Backend: ruff clean, **11** pytest tests passed
- Frontend (node:22-alpine container): lint/typecheck/vitest PASS
- Playwright (`mcr.microsoft.com/playwright:v1.49.1-jammy`): PASS
- API flow: train + registry + predict PASS
