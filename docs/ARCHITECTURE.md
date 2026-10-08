# ModelFlow Architecture (v1.0 RC)

## Overview

```
┌──────────────┐     ┌──────────────────────────┐     ┌────────────┐
│   Frontend   │────▶│  Backend FastAPI /api/v1 │────▶│  Postgres  │
│ React / Vite │     │  Auth · RBAC · Services  │     │  modelflow │
└──────────────┘     └────────────┬─────────────┘     └────────────┘
                                  │
                    ┌─────────────┼──────────────────────┐
                    ▼             ▼                      ▼
               ┌────────┐   ┌────────┐         ┌──────────────────┐
               │ MinIO  │   │ MLflow │◀────────│ Inference Runtime│
               │datasets│   │track+  │ artifacts│ (internal only) │
               │batch   │   │registry│         │ load / predict   │
               │artifacts    └────────┘         └────────▲─────────┘
               └────────┘                                │
                                          ┌──────────────┴───┐
                                          │ Worker(s)        │
                                          │ train/pipeline/  │
                                          │ batch/drift/...  │
                                          └──────────────────┘
```

## Services (Docker Compose)

| Service | Role |
|---------|------|
| `frontend` | React SPA (nginx); `/api` proxied to backend |
| `backend` | FastAPI `/api/v1`; migrations on start; bootstrap admin; delegates model execution |
| `inference-runtime` | Internal FastAPI model load/predict; service-token auth; no public ingress |
| `worker` | Claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`); hostname worker identity (optional `WORKER_ID`); profile `general`/`gpu`; scheduler/maintenance via Postgres advisory lock; heartbeat; batch predict via runtime |
| `postgres` | App DB `modelflow` + MLflow DB `mlflow` |
| `mlflow` | Tracking + Model Registry; artifacts on MinIO |
| `minio` | Datasets, batch results, MLflow artifacts |
| `postgres-source` (optional/test) | Sample external Postgres for data-source integration tests |

## Backend layout

- `app/api/v1` — versioned HTTP routers
- `app/core` — settings, security, RBAC, crypto, audit helpers, errors, middleware
- `app/db` — SQLAlchemy models / session
- `app/schemas` — Pydantic request/response models
- `app/services` — business logic (storage, training, pipeline, registry, serving, drift, …)
- `app/workers` — unified job runner + healthcheck (identity, leadership, profile-aware claims)
- Alembic migrations for app schema

## Auth & tenancy

- Password hashing: bcrypt via passlib
- Access tokens: JWT (HS256) with expiry; optional refresh not required for v1.0
- Optional Enterprise OIDC SSO (Phase 8-C): Authorization Code + PKCE; durable `issuer+subject` binding; ModelFlow still issues its own access token after SSO
- Bootstrap: first SYSTEM_ADMIN from env `MODELFLOW_BOOTSTRAP_ADMIN_EMAIL` / `MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD` (never hardcoded); local break-glass login retained
- Project membership enforces isolation at API layer
- Inactive users rejected; login rate limited / lockout after failures

## Job queue

Unified `work_items` / domain job tables claimed by worker:

| Job kind | Handler |
|----------|---------|
| training | `SklearnTrainingRunner` |
| pipeline | `PipelineEngine` (DAG topological + parallel independent nodes) |
| batch_inference | Batch predictor |
| data_import | Postgres/file import → DatasetVersion |
| drift | Drift calculator |
| quality_check | Quality rule runner |

`TrainingRunner` / `PipelineExecutor` protocols keep Airflow/K8s replaceable later.

## Data flow (train)

1. API creates training job (`queued`).
2. Worker claims (`running`), loads DatasetVersion from MinIO.
3. Preprocess → fit algorithm → evaluate → log MLflow → store metrics/artifacts.
4. Update job (`succeeded`/`failed`); audit + optional alert.

## Registry & serving

- App-owned `model_versions` table mirrors MLflow artifacts with lifecycle states and gates.
- Online and batch model execution run in the internal `inference-runtime` (Phase 8-A). Backend/worker call it with `MODELFLOW_INFERENCE_SERVICE_TOKEN`; public Endpoint contracts stay on the control plane.
- Endpoint Ready requires a successful runtime load-check. Batch jobs chunk feature rows to the runtime and write results to MinIO; download via authenticated API.

## Storage

- Postgres `modelflow`: application tables
- Postgres `mlflow`: MLflow tracking
- MinIO buckets: `datasets`, `mlflow`, `batch-results`, `artifacts`
- Data-source passwords encrypted with Fernet key from `MODELFLOW_ENCRYPTION_KEY`

## Observability

- Correlation ID middleware
- Structured JSON logs with secret masking
- Health + readiness endpoints
- Audit log for governance events
- Endpoint request metrics (counts, latency histograms) without storing raw PII by default

## Security boundary

Compose is a **local/self-hosted trust boundary**. Do not expose to the public internet without reverse proxy TLS, hardened secrets, and operational controls. See README security section.
