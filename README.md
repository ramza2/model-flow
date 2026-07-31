# ModelFlow

End-to-End MLOps Platform (MVP).

## Host prerequisites

- Docker Engine
- Docker Compose plugin (`docker compose`)
- curl
- bash

Node.js/npm are **not** required on the host for `./scripts/verify.sh` (frontend and Playwright run in containers).

## Quick start

```bash
docker compose up --build -d
```

Open:

- UI: http://localhost:3000
- API docs: http://localhost:8000/docs
- MLflow: http://localhost:5000
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)

Sample dataset: `samples/iris.csv` (target column: `target`).

## Full verification

```bash
chmod +x scripts/verify.sh
docker compose down -v --remove-orphans
./scripts/verify.sh
```

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

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/ACCEPTANCE_CRITERIA.md`.

## Security note

MVP has **no authentication**. Do not expose the Compose stack to the public internet.
