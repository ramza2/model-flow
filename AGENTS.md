# AGENTS.md

## Cursor Cloud specific instructions

ModelFlow is in early scaffolding: there is **no application code yet**. Do not invent product code during environment/setup tasks unless explicitly asked. Future stack (not present in-repo yet): FastAPI, React, PostgreSQL, MLflow, MinIO.

### Base tooling

Environment is defined by `.cursor/environment.json` → `.cursor/Dockerfile` (Ubuntu 24.04 with Git, Docker/Compose, Python 3.11, Node.js 22, npm, `psql`, curl, make).

- After boot, Docker is started via `start`: `sudo service docker start`. If the daemon is down, run that (or `sudo dockerd`) before container work.
- DinD uses `fuse-overlayfs` + `iptables-legacy` (see Dockerfile). Prefer `docker compose` (plugin), not legacy `docker-compose`.
- Prefer `python3.11` / `python` from the image for backend work. System `python3` on some snapshots may still be 3.12; use `python3.11` explicitly if unsure.
- Node 22 LTS + npm are available for the future React app.
- `psql` is the PostgreSQL **client** only; a Postgres server is expected via Docker Compose once the app lands.
- `install` is currently a no-op (`true`) because there are no project dependency manifests. When `requirements.txt` / `pyproject.toml` / `package.json` appear, update `.cursor/environment.json` `install` (and the SetupVmEnvironment update script) accordingly — keep it idempotent and dependency-refresh only (no `docker compose up`, no migrations, no `dev` servers).

### Not in scope until product scaffolding exists

Lint, unit tests, and running FastAPI/React/Postgres/MLflow/MinIO services cannot be exercised until those packages and Compose definitions are added in a later agent task.
