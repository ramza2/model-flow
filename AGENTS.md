# AGENTS.md

## Cursor Cloud specific instructions

ModelFlow MVP stack: FastAPI (`backend`), async worker (`python -m app.workers.runner`), React/Vite UI (`frontend`), Postgres, MLflow, MinIO via `docker compose`.

### Day-to-day

- Preferred full stack: `docker compose up --build -d` (see README). UI http://localhost:3000, API http://localhost:8000/docs.
- Full gate: `./scripts/verify.sh` (compose, health, migrations, lint/tests, API flow, Playwright).
- After boot, Docker daemon: `sudo service docker start` if needed (DinD uses fuse-overlayfs).
- `install` only refreshes `backend/requirements.txt` and `frontend` npm deps — never put `compose up`, migrations, or dev servers there.
- Sample CSV: `samples/iris.csv` with target column `target`.
- Worker claims jobs from Postgres (`FOR UPDATE SKIP LOCKED`); training goes through `SklearnTrainingRunner` (`app/services/training.py`).

### Auth / secrets

MVP has no auth. Local MinIO/MLflow credentials are the Compose defaults (`minioadmin`). Do not use production secrets.
