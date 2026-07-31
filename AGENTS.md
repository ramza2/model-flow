# AGENTS.md

## Cursor Cloud specific instructions

### Base tooling

Environment is defined by `.cursor/environment.json` → `.cursor/Dockerfile` (Ubuntu 24.04 with Git, Docker/Compose, Python 3.11, Node.js 22, npm, `psql`, curl, make).

- After boot, Docker daemon: `sudo service docker start` (or `sudo dockerd`) if needed. DinD uses `fuse-overlayfs` + `iptables-legacy`.
- Prefer `docker compose` (plugin), not legacy `docker-compose`.
- Prefer `python3.11` for backend work; some base images may still expose `python3` as 3.12.
- `psql` is the PostgreSQL **client** only; the server runs via Compose.
- `install` refreshes `backend/requirements.txt` and `frontend` npm deps only — never `compose up`, migrations, or dev servers.

### MVP day-to-day

ModelFlow MVP stack: FastAPI (`backend`), async worker (`python -m app.workers.runner`), React/Vite UI (`frontend`), Postgres, MLflow, MinIO via `docker compose`.

- Preferred full stack: `docker compose up --build -d` (see README). UI http://localhost:3000, API http://localhost:8000/docs.
- Full gate: `./scripts/verify.sh` (Compose + health + migrations + lint/tests in containers + API flow + Playwright container). Host needs Docker, Compose, curl, bash — not Node/npm/host Python.
- Same gate runs in GitHub Actions (`.github/workflows/ci.yml`) on PRs to `main`, pushes to `main`, and `workflow_dispatch`. Failure artifacts: `artifacts/verify/`, `artifacts/screenshots/`.
- External images are pinned (see `docs/DECISIONS.md` D-016). Do not switch back to `latest` without pull/run verification.
- Sample CSV: `samples/iris.csv` with target column `target`.
- Worker claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`) and writes a DB heartbeat for health checks; training uses `SklearnTrainingRunner` (`app/services/training.py`).

### Auth / secrets

MVP has no auth. Local MinIO/MLflow credentials are the Compose defaults (`minioadmin`). Do not use production secrets. CI must not depend on production secrets or paid external services.
