# ModelFlow

[![CI](https://github.com/ramza2/model-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/ramza2/model-flow/actions/workflows/ci.yml)

End-to-End MLOps Platform (MVP).

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
- API docs: http://localhost:8000/docs
- MLflow: http://localhost:5000
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)

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

The script builds the stack with clean volumes, checks health, runs Alembic / lint / tests, exercises the API train→register→predict path, and runs Playwright E2E in the official Playwright container. On failure it writes Compose status and service logs under `artifacts/verify/`.

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

## Security limitations (MVP)

- **No authentication** on API or UI.
- Default local credentials only (`minioadmin` / Compose Postgres password `modelflow`).
- Do **not** expose the Compose stack to the public internet.
- Do **not** use production secrets in this MVP configuration.
- CI does not use production secrets or paid external services.
