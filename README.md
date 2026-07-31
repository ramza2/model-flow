# ModelFlow

[![CI](https://github.com/ramza2/model-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/ramza2/model-flow/actions/workflows/ci.yml)

Self-hosted, end-to-end tabular MLOps platform — ModelFlow v1.0 Release Candidate.

## Host prerequisites

- Docker Engine
- Docker Compose plugin (`docker compose`)
- curl
- bash

Node.js/npm and host Python are **not** required for `./scripts/verify.sh` (frontend, Playwright, and JSON helpers run in containers).

## Quick start (local)

```bash
./scripts/init-env.sh
docker compose up --build -d
```

The initializer creates a mode-`600` `.env` with random credentials and prints the
bootstrap administrator email and password once. Save them in a password manager.

Open:

- UI: http://localhost:3000
- API v1: http://localhost:8000/api/v1
- API docs: http://localhost:8000/docs
- MLflow: http://localhost:5000
- MinIO console: http://localhost:9001

Sign in with the credentials printed by `init-env.sh`, open the user menu, choose
**Change password**, and replace the bootstrap password immediately. MinIO credentials
are stored only in the ignored `.env`.

Sample datasets: `samples/iris.csv` (classification target `target`) and `samples/regression.csv` (regression target `target_value`).

Stop and wipe volumes:

```bash
docker compose --profile source down -v --remove-orphans
```

## Full verification

Local and CI use the **same** gate:

```bash
chmod +x scripts/verify.sh
docker compose down -v --remove-orphans
./scripts/verify.sh
```

The script builds the stack with clean volumes, waits for the bootstrap administrator,
checks health, runs Alembic / lint / tests, and exercises the authenticated `/api/v1`
data-quality, training, registry, serving, batch, drift, and audit flow. It then runs
Playwright E2E in the official Playwright container. On failure it writes Compose status
and service logs under `artifacts/verify/`.

## Authentication and bootstrap

The API and UI require authentication. On an empty database, the backend creates one
system administrator from the generated environment:

```bash
./scripts/init-env.sh
docker compose up --build -d
```

Bootstrap does not overwrite or recreate users once the database contains a user. The
initializer refuses to overwrite `.env` unless `--force` is supplied. Compose rejects
missing or empty required settings. Keep `MODELFLOW_SECRET_KEY`,
`MODELFLOW_ENCRYPTION_KEY`, the bootstrap password, PostgreSQL credentials, and MinIO
credentials in a secret manager for production.

## Demo data and PostgreSQL source

Seed a running stack with a demo project and `samples/iris.csv`:

```bash
./scripts/seed-demo.sh
```

An optional PostgreSQL source on host port `5433` contains
`public.customers` for data-source integration tests:

```bash
docker compose --profile source up -d postgres-source
```

Use the generated `SOURCE_POSTGRES_USER`, `SOURCE_POSTGRES_PASSWORD`, and
`SOURCE_POSTGRES_DB` values from `.env`. The host is `postgres-source` from Compose
services and `localhost:5433` from the host.

## Backup, restore, and reset

Back up the application and `mlflow` PostgreSQL databases plus the `datasets`, `mlflow`,
`batch-results`, and `artifacts` MinIO buckets:

```bash
./scripts/backup.sh
# writes backups/<UTC timestamp>/
```

Restore one backup directory. Restore replaces both databases and mirrors bucket
contents, so do not point it at a production stack without an external backup:

```bash
./scripts/restore.sh backups/20260731T053300Z
```

Reset local development to clean volumes and wait for healthy services:

```bash
./scripts/reset-dev.sh
```

## GitHub Actions CI

Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

Runs on:

- Pull requests targeting `main`
- Pushes to `main`
- Manual `workflow_dispatch`

Behavior:

- `ubuntu-latest` + Docker / Compose
- Cancels superseded runs for the same ref (`concurrency`)
- Least-privilege token permissions (`contents: read`, `checks: write`)
- 60-minute job timeout
- Executes `./scripts/verify.sh` end-to-end
- On failure, uploads `artifacts/verify/` and `artifacts/screenshots/` (plus Compose `ps` / service logs collected in the workflow)

### CI Badge

The badge at the top of this README reflects the latest CI workflow status.

### Failure artifacts

1. Open the failed GitHub Actions run.
2. Download the artifact named `verify-failure-<run_id>`.
3. Inspect:
   - `artifacts/verify/` — RESULT, Compose `ps`, Alembic, predict JSON, service logs
   - `artifacts/screenshots/` — Playwright captures when available

## Local development (optional)

Backend (requires Compose infra services):

```bash
set -a
source .env
set +a
export DATABASE_URL="postgresql+psycopg2://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}"
export MINIO_ACCESS_KEY="$MINIO_ROOT_USER"
export MINIO_SECRET_KEY="$MINIO_ROOT_PASSWORD"
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
python -m app.workers.runner
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Docs

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/DECISIONS.md`, and `docs/PROGRESS.md`.

## Security

- `/api/v1` uses bearer-token authentication, project RBAC, login lockout, request rate
  limits, audit logs, and security headers.
- Data-source passwords and DSNs are encrypted at rest. Set a stable Fernet
  `MODELFLOW_ENCRYPTION_KEY` when rotating `MODELFLOW_SECRET_KEY`.
- Compose publishes PostgreSQL, MinIO, MLflow, and the API for local development. Do not
  expose this configuration to the public internet.
- Use generated credentials, TLS, network controls, external backups, and a secret
  manager for production.
- CI and local verification generate ephemeral credentials and do not require paid
  external services.
