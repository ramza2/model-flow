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

## D-010: MinIO image tags

- **Context:** Dated MinIO/`mc` release tags returned manifest-unknown during Compose pull.
- **Choice:** Use `minio/minio:latest` and `minio/mc:latest` for MVP reliability.
- **Consequences:** Less bit-for-bit reproducibility; acceptable for local MVP. Revisit pinned digests later.
