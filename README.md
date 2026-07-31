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
docker compose up --build -d
```

Open:

- UI: http://localhost:3000
- API v1: http://localhost:8000/api/v1
- API docs: http://localhost:8000/docs
- MLflow: http://localhost:5000
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)

Sign in to the local stack with `admin@modelflow.local` / `ChangeMeAdmin123!`.
These are development-only credentials from `docker-compose.yml`; change them for every
non-local deployment.

Sample dataset: `samples/iris.csv` (target column: `target`).

Stop and wipe volumes:

```bash
docker compose down -v --remove-orphans
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
system administrator only when a bootstrap password is configured:

```bash
export MODELFLOW_SECRET_KEY='replace-with-a-long-random-secret'
export MODELFLOW_BOOTSTRAP_ADMIN_EMAIL='admin@example.com'
export MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD='replace-with-a-strong-password'
export MODELFLOW_ENCRYPTION_KEY='' # optional Fernet key; empty derives one from SECRET_KEY
docker compose up --build -d
```

Bootstrap does not overwrite or recreate users once the database contains a user. The
Compose defaults are intentionally public local-development values and must not be used
on a shared host. Keep `MODELFLOW_SECRET_KEY`, the bootstrap password, PostgreSQL,
MinIO, and MLflow credentials in a secret manager for production.

## Demo data and PostgreSQL source

Seed a running stack with a demo project and `samples/iris.csv`:

```bash
MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD='ChangeMeAdmin123!' ./scripts/seed-demo.sh
```

An optional PostgreSQL source on host port `5433` contains
`public.customers` for data-source integration tests:

```bash
docker compose --profile source up -d postgres-source
```

Its local-only connection is
`postgresql://source:source@postgres-source:5432/source` from Compose services, or
`postgresql://source:source@localhost:5433/source` from the host.

## Backup, restore, and reset

Back up the `modelflow` and `mlflow` PostgreSQL databases plus the `datasets`, `mlflow`,
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
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export MODELFLOW_SECRET_KEY='local-development-secret'
export MODELFLOW_BOOTSTRAP_ADMIN_EMAIL='admin@modelflow.local'
export MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD='ChangeMeAdmin123!'
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
  expose the default Compose configuration to the public internet.
- Replace all default credentials and use TLS, network controls, external backups, and a
  secret manager for production.
- CI and local verification use development credentials only and do not require paid
  external services.
