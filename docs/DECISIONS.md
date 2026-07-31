# Architecture & Product Decisions

Format: Decision — Context — Choice — Consequences.

## D-001: No authentication in MVP

- **Context:** Local Compose trust boundary; auth would delay the MLOps loop.
- **Choice:** Open API/UI; document clearly in README.
- **Consequences:** Not safe on public networks. Add auth post-MVP.

## D-002: DB-backed job queue instead of Airflow

- **Context:** Airflow excluded from MVP.
- **Choice:** `training_jobs` table + worker poll with `FOR UPDATE SKIP LOCKED`.
- **Consequences:** Simple, replaceable via `TrainingRunner` protocol.

## D-003: Separate Postgres databases for app and MLflow

- **Context:** Avoid schema collisions.
- **Choice:** `modelflow` and `mlflow` databases on one Postgres service.
- **Consequences:** One service to operate; clear separation.

## D-004: MinIO for datasets and MLflow artifacts

- **Context:** Need S3-compatible storage without cloud spend.
- **Choice:** Single MinIO with buckets `datasets` and `mlflow`.
- **Consequences:** Local credentials only (`minioadmin` / `minioadmin`).

## D-005: Sklearn RandomForestClassifier as default trainer

- **Context:** Need a reliable sample model.
- **Choice:** Classification when target is categorical/integer with few uniques; else RandomForestRegressor. Default sample: Iris-like CSV with `target` column.
- **Consequences:** Tabular CSV only in MVP.

## D-006: Inference in backend process

- **Context:** Avoid separate model-serving mesh.
- **Choice:** FastAPI loads pyfunc/sklearn model from MLflow URI; in-memory cache per endpoint.
- **Consequences:** Single-node only; fine for MVP.

## D-007: Frontend served as static build behind nginx in Compose

- **Context:** Predictable ports and production-like assets.
- **Choice:** Vite build + nginx; `/api` proxied to backend.
- **Consequences:** Rebuild image for UI changes in Compose; local `npm run dev` for hot reload.

## D-008: MLflow experiment name = `project-{id}`

- **Context:** Map projects to MLflow experiments.
- **Choice:** Auto-create experiment per project.
- **Consequences:** Clear isolation per project.

## D-010: MinIO image tags (superseded by D-016)

- **Context:** Earlier dated MinIO/`mc` tags returned manifest-unknown during Compose pull.
- **Choice (historical):** Temporarily used `minio/minio:latest` and `minio/mc:latest`.
- **Consequences:** Less reproducible. Replaced by verified RELEASE tags in D-016.

## D-011: Dataset object keys include UUID

- **Context:** Re-uploading `iris.csv` reused `project-{id}/iris.csv` and overwrote prior objects.
- **Choice:** Store at `project-{id}/{uuid}/{original_filename}`; keep original name in `datasets.name`.
- **Consequences:** Object storage grows with each upload; training always reads the dataset-specific key.

## D-012: Endpoint readiness requires model load

- **Context:** Endpoints could be marked `ready` even when `mlflow.pyfunc.load_model` failed.
- **Choice:** Load the model before insert; on failure return 400 and do not persist the endpoint.
- **Consequences:** Slightly slower create path; fails closed for broken artifacts.

## D-013: Project-scoped MLflow ownership checks

- **Context:** A client could register another project's run or attach another project's model to an endpoint.
- **Choice:** Register only if `run.experiment_id` matches `project-{id}` experiment; endpoints require model name prefix `project-{id}-`.
- **Consequences:** Relies on naming/experiment conventions established at project create / train time.

## D-014: Worker heartbeat healthcheck

- **Context:** Compose worker health was a no-op sleep and could report healthy while polling was stuck.
- **Choice:** Worker writes `worker_heartbeats.last_seen_at` each loop; healthcheck module fails if age exceeds 30s.
- **Consequences:** Requires migration `002_worker_heartbeats`; start_period allows first beat.

## D-015: verify.sh runs tests in containers

- **Context:** Host Node/npm versions varied; review required reproducible verification.
- **Choice:** Frontend checks via pinned Node image; E2E via `mcr.microsoft.com/playwright:v1.49.1-jammy`; JSON parsing via `python:3.11-slim`. Host tools: Docker, Compose, curl, bash. EXIT trap collects Compose `ps` and service logs into `artifacts/verify/` on failure.
- **Consequences:** First verify pull is slower; no host Node/Python required; same gate locally and in CI.

## D-016: Pin external Docker images to pull-verified tags

- **Context:** `latest` tags for MinIO/`mc` and floating minor tags reduce CI reproducibility.
- **Choice:** After `docker pull` / `docker manifest inspect` and a smoke run, pin:
  - `minio/minio:RELEASE.2025-04-22T22-12-26Z`
  - `minio/mc:RELEASE.2025-04-16T18-13-26Z`
  - `postgres:16.9-alpine`
  - `node:22.17-alpine` (frontend build + verify)
  - `nginx:1.27.5-alpine`
  - Keep existing pins: `python:3.11-slim` / `python:3.11-slim-bookworm`, `ghcr.io/mlflow/mlflow:v2.18.0`, `mcr.microsoft.com/playwright:v1.49.1-jammy`
- **Consequences:** Tags must be re-verified before upgrades; do not invent unverified tags.

## D-017: GitHub Actions CI runs the same verify.sh gate

- **Context:** Need PR Checks without a second verification path.
- **Choice:** Single workflow `.github/workflows/ci.yml` on PR→main, push→main, and `workflow_dispatch`; runs `./scripts/verify.sh`; concurrency cancels superseded runs; least-privilege permissions; 60m timeout; failure artifact upload of `artifacts/verify/` + `artifacts/screenshots/`.
- **Consequences:** CI duration tracks full stack; no production secrets or paid external services.
