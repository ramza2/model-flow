# ModelFlow Architecture (MVP)

## Overview

```
┌────────────┐     ┌────────────┐     ┌────────────┐
│  Frontend  │────▶│  Backend   │────▶│  Postgres  │
│ React/Vite │     │  FastAPI   │     └────────────┘
└────────────┘     │            │────▶┌────────────┐
                   │            │     │   MinIO    │
                   │            │────▶│  (S3 API)  │
                   │            │     └────────────┘
                   │            │────▶┌────────────┐
                   │            │     │   MLflow   │
                   └─────┬──────┘     └────────────┘
                         │ job queue (DB rows)
                   ┌─────▼──────┐
                   │   Worker   │  (poll + sklearn train)
                   └────────────┘
```

## Services (Docker Compose)

| Service | Role |
|---------|------|
| `frontend` | React SPA (nginx or Vite preview) |
| `backend` | FastAPI REST API |
| `worker` | Polls `training_jobs`, runs sklearn, writes MLflow |
| `postgres` | App DB + MLflow backend store |
| `mlflow` | Tracking server + Model Registry |
| `minio` | Dataset blobs + MLflow artifacts |

## Backend layout

- `app/api` — HTTP routers
- `app/services` — business logic
- `app/workers` — training runner interface + sklearn implementation
- `app/db` — SQLAlchemy models / session
- Alembic migrations for app schema

## Training abstraction

```python
class TrainingRunner(Protocol):
    def run(self, job: TrainingJobContext) -> TrainingResult: ...
```

MVP implementation: `SklearnTrainingRunner`. Later replaceable by Airflow/K8s without changing the API surface.

## Data flow (train)

1. API creates `training_jobs` row (`pending`).
2. Worker claims job (`running`), downloads CSV from MinIO.
3. Worker fits sklearn pipeline, logs to MLflow, uploads artifacts.
4. Worker updates job (`succeeded`/`failed`) with run_id and logs.
5. Optional: register model via API → MLflow Registry.

## Inference

Endpoint records store model URI / registry version. Backend loads the model (cached) and serves `POST /endpoints/{id}/predict`.

## Storage

- Postgres DB `modelflow`: application tables
- Postgres DB `mlflow`: MLflow tracking
- MinIO buckets: `datasets`, `mlflow`

## Auth

MVP: no authentication (local Compose trust boundary). Documented in DECISIONS.md.
