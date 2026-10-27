# Traefik production deployment (GPU / Linux server)

Deploy ModelFlow behind an **existing** Traefik reverse proxy on a shared Docker network.
Only the **frontend** container is exposed to Traefik; all other services stay on the internal Compose network.

## Architecture

```text
Internet → Traefik (web / websecure, letsencrypt)
              ↓ traefik_proxy network
         frontend :80
              ├─ /      → React static assets
              └─ /api/* → backend:8000/api/*
                    ↓
            PostgreSQL / MinIO / MLflow / worker / inference-runtime
```

Traefik labels route HTTPS traffic to `frontend:80`. The frontend nginx config already proxies `/api/*` to the backend.

## Requirements

- Linux server with Docker Engine and the **Docker Compose v2 plugin v2.24+** (`ports: !reset` merge support)
- Existing Traefik with:
  - entrypoints: `web`, `websecure`
  - certificate resolver: `letsencrypt`
  - external network: `traefik_proxy`
- Git checkout of ModelFlow at the commit you intend to run

## Standard deploy command

After the first `.env.deploy` setup, operators redeploy with:

```bash
./scripts/deploy.sh --traefik --build --migrate --force-recreate
```

## First-time server setup

```bash
git clone https://github.com/ramza2/model-flow.git
cd model-flow

./scripts/init-env.sh --output .env.deploy
chmod 600 .env.deploy
```

The generated `.env.deploy` already includes `MODELFLOW_WEB_HOST=` (empty) and `CORS_ORIGINS=...`.
Edit those values for production (minimum):

```dotenv
MODELFLOW_WEB_HOST=modelflow.openlink.kr
CORS_ORIGINS=https://modelflow.openlink.kr
MODELFLOW_BOOTSTRAP_ADMIN_EMAIL=admin@your-company.example
```

Use a real administrator email and change the bootstrap password after first login.
Do **not** commit `.env.deploy` (ignored by `.env.*` in `.gitignore`).

Confirm the shared Traefik network exists (do **not** create a duplicate if Traefik already uses it):

```bash
docker network inspect traefik_proxy
```

If Traefik is not installed yet and you are bootstrapping an isolated test host only:

```bash
docker network create traefik_proxy
```

On a shared production host, use the network Traefik already attaches to.

Deploy:

```bash
./scripts/deploy.sh --traefik --build --migrate --force-recreate
```

## Post-deploy checks

```bash
docker compose \
  --env-file .env.deploy \
  -f docker-compose.yml \
  -f docker-compose.traefik.yml \
  ps
```

- UI: `https://${MODELFLOW_WEB_HOST}`
- API health: `https://${MODELFLOW_WEB_HOST}/api/health`

## Updating an existing server

```bash
git fetch
git switch main
git pull
```

On Traefik deploy servers, use **`.env.deploy`** (same as `deploy.sh`), not the default `.env`. Recommended backup before upgrade:

```bash
MODELFLOW_ENV_FILE=.env.deploy BACKUP_DIR=/path/to/backups ./scripts/backup.sh
```

To write under the default `backups/` directory:

```bash
MODELFLOW_ENV_FILE=.env.deploy ./scripts/backup.sh
```

Redeploy:

```bash
./scripts/deploy.sh --traefik --build --migrate --force-recreate
```

### MLflow image / schema upgrades (Compose + Traefik)

`./scripts/deploy.sh --migrate` runs **ModelFlow Alembic only** (`alembic upgrade head`).
It does **not** run `mlflow db upgrade`. When the Compose MLflow image tag changes
(for example `v3.11.1` → `v3.17.2`), treat MLflow as a controlled maintenance window.

**Do not** assume a newer MLflow schema can be read by an older MLflow image.
**Do not** let old and new MLflow (or backend/worker) containers write to the same
databases at once — stop writers before migration, and do not start the new stack
until the schema upgrade finishes.
**Do not** delete, wipe, or re-initialize production PostgreSQL or MinIO data except
via the explicit `./scripts/restore.sh` path below (never `down -v`, volume prune, or
ad-hoc `dropdb` outside restore).

Use `.env.deploy` (same as `deploy.sh`). Prefer `MODELFLOW_ENV_FILE=.env.deploy` so
credentials stay out of ad-hoc command lines. Avoid `set -x` while database URLs that
embed passwords are in scope, and do not paste a password-bearing URI into shell history.

Compose helper used below (adjust paths if you do not use Traefik):

```bash
export MODELFLOW_ENV_FILE=.env.deploy
COMPOSE=(docker compose --env-file .env.deploy -f docker-compose.yml -f docker-compose.traefik.yml)
```

1. Confirm no in-flight TrainingJob or PipelineRun work that still needs MLflow writes.
   Drain or wait for active runs; do not start new training or pipeline executions.
2. Stop new learning / MLflow write traffic (pause schedules if needed; keep the UI
   read-only or offline during the window).
3. Quiesce writers safely (leave Postgres and MinIO up for backup and migration):

   ```bash
   "${COMPOSE[@]}" stop frontend worker backend mlflow inference-runtime
   ```

4. Record the **currently running** image identifiers for rollback (before any rebuild).
   Keep this file with the backup from step 5:

   ```bash
   SAFETY_DIR=/path/to/upgrade-safety-$(date -u +%Y%m%dT%H%M%SZ)
   mkdir -p "$SAFETY_DIR"
   for svc in mlflow backend worker frontend; do
     cid="$("${COMPOSE[@]}" ps -aq "$svc" | head -n 1)"
     if [[ -z "$cid" ]]; then
       echo "$svc missing=true" >> "$SAFETY_DIR/pre-upgrade-images.txt"
       continue
     fi
     docker inspect --format \
       "$svc image={{.Config.Image}} id={{.Image}}" \
       "$cid" >> "$SAFETY_DIR/pre-upgrade-images.txt"
     docker tag "$(docker inspect --format '{{.Image}}' "$cid")" \
       "modelflow-rollback-$svc:pre-upgrade"
   done
   cat "$SAFETY_DIR/pre-upgrade-images.txt"
   ```

5. Back up PostgreSQL (`modelflow` and `mlflow`) and MinIO:

   ```bash
   MODELFLOW_ENV_FILE=.env.deploy ./scripts/backup.sh
   ```

   Or with an explicit destination:

   ```bash
   MODELFLOW_ENV_FILE=.env.deploy BACKUP_DIR=/path/to/backups ./scripts/backup.sh
   ```

6. Verify the backup directory: `metadata.txt`, non-empty
   `postgres/modelflow.dump` and `postgres/mlflow.dump`, and MinIO bucket trees
   (`datasets`, `mlflow`, `batch-results`, `artifacts`). Note total size. Copy or
   note the backup path next to `$SAFETY_DIR`.
7. Build images that pick up the upgraded dependency set (does **not** start them).
   Include every service whose image embeds changed Python/Node deps — not MLflow only:

   ```bash
   "${COMPOSE[@]}" build mlflow backend worker frontend
   ```

8. Apply the MLflow schema upgrade **explicitly** with the new image, while the old
   server remains stopped. Pass DB credentials via environment (from `.env.deploy`)
   and expand the URI **inside** the container so the password is not placed on the
   compose command line:

   ```bash
   set -a
   # shellcheck disable=SC1091
   source .env.deploy
   set +a
   "${COMPOSE[@]}" run --rm --no-deps \
     -e POSTGRES_USER \
     -e POSTGRES_PASSWORD \
     --entrypoint sh mlflow -c \
     'mlflow db upgrade "postgresql+psycopg2://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/mlflow"'
   ```

9. Start only the MLflow server and wait for health:

   ```bash
   "${COMPOSE[@]}" up -d mlflow
   "${COMPOSE[@]}" ps mlflow
   ```

   Confirm the container is healthy (Compose healthcheck hits `/health`).
10. Spot-check existing Experiments, Runs, logged models, artifacts, and Model Registry
    entries that existed before the upgrade (via MLflow UI/API or a known ModelFlow
    training/registry path). Confirm artifact objects under the `mlflow` MinIO bucket
    remain reachable.
11. Bring the rest of the stack back (backend/worker/frontend images built in step 7):

    ```bash
    "${COMPOSE[@]}" up -d
    ```

    Or, after this maintenance window, a full redeploy is fine once MLflow schema is done:

    ```bash
    ./scripts/deploy.sh --traefik --build --migrate --force-recreate
    ```

    Remember: `--migrate` still covers Alembic only; MLflow schema was already upgraded
    in step 8.
12. Verify overall health (`/api/health`, UI) and that a **new** training job can log
    to MLflow without disturbing historical runs.
13. **Rollback** if anything fails after schema upgrade. Do **not** start the new
    MLflow/backend/worker/frontend images against the restored older databases.

    a. Stop application services again:

    ```bash
    "${COMPOSE[@]}" stop frontend worker backend mlflow inference-runtime
    ```

    b. Restore databases and MinIO with the Traefik overlay and **without** auto-start
    (MinIO health is checked inside the container; no host port is required):

    ```bash
    MODELFLOW_ENV_FILE=.env.deploy \
      ./scripts/restore.sh --traefik --no-start /path/to/backup-from-step-5
    ```

    Local / non-Traefik stacks keep the default path:
    `./scripts/restore.sh [--no-start] <backup-dir>` (no `--traefik`).

    c. Start **only** the pre-upgrade images recorded in step 4. Do this after
    restore finishes — never let a default `restore.sh` (without `--no-start`) or
    `deploy.sh --build` pull the new images up against the restored DB.

    ```bash
    # Option A (preferred when image names match Compose): retag saved IDs, then up
    while read -r line; do
      svc="${line%% *}"
      img_id="$(printf '%s\n' "$line" | sed -n 's/.* id=//p')"
      name="$(printf '%s\n' "$line" | sed -n 's/.* image=\([^ ]*\).*/\1/p')"
      [[ -n "$img_id" && -n "$name" ]] || continue
      docker tag "$img_id" "$name"
      docker tag "$img_id" "modelflow-rollback-$svc:pre-upgrade"
    done < "$SAFETY_DIR/pre-upgrade-images.txt"
    "${COMPOSE[@]}" up -d mlflow backend worker frontend

    # Option B: check out the previous known-good git revision (same image pins),
    # then `up -d` **without** `--build` so the new Dockerfiles are not rebuilt.
    ```

    d. Confirm health, then resume traffic. Never restore the old DB and then
    unconditionally start a newer image set; never run old and new MLflow writers
    against the same database.

This repository’s isolated regression for the documented path is
`scripts/test-mlflow-upgrade.sh` (disposable Postgres/MinIO only; never production).
Restore Traefik / `--no-start` coverage lives in `scripts/test-restore-traefik.sh`
and the backup round-trip gate.

## Stopping ModelFlow

```bash
docker compose \
  --env-file .env.deploy \
  -f docker-compose.yml \
  -f docker-compose.traefik.yml \
  down
```

**Never** use `down -v` on a production host. That removes named volumes and destroys PostgreSQL / MinIO data.

## `scripts/deploy.sh` options

| Option | Description |
|--------|-------------|
| `--traefik` | Include `docker-compose.traefik.yml` (default) |
| `--no-traefik` | Base `docker-compose.yml` only (local-style host ports) |
| `--build` | `docker compose build` before start |
| `--migrate` | `alembic upgrade head` via backend image before `up` (ModelFlow DB only; **not** `mlflow db upgrade`) |
| `--force-recreate` | Pass `--force-recreate` to `up -d` |
| `--env-file PATH` | Override env file (default: `.env.deploy`) |

### Execution order (fail-fast)

1. Validate env file, Docker, Compose plugin
2. Traefik mode: verify overlay file and `traefik_proxy` network
3. `docker compose … config` validation
4. Traefik mode: verify `MODELFLOW_WEB_HOST`, frontend labels/networks, no host `published` ports
5. `--build` → `compose build`
6. `--migrate` → start Postgres, wait, `compose run --rm --no-deps backend alembic upgrade head`
7. `compose up -d` (optional `--force-recreate`)
8. `compose ps` and print HTTPS URL

`deploy.sh` never runs `down -v`, volume prune, `.env.deploy` overwrite, `git pull`, or tag changes.

## Compose overlay summary (`docker-compose.traefik.yml`)

- Removes host port publishing from: `postgres`, `postgres-source`, `minio`, `mlflow`, `backend`, `frontend`, `inference-runtime` via `ports: !reset []`
- Adds `restart: unless-stopped` to long-running services (not `minio-init`)
- Connects `frontend` to `default` + external `traefik_proxy`
- Traefik labels on `frontend` only (`modelflow-*` prefix):
  - HTTP → HTTPS redirect (`modelflow-web-http`, entrypoint `web`)
  - HTTPS router (`modelflow-web`, entrypoint `websecure`, `letsencrypt`)
  - Service target port `80`, `traefik.docker.network=traefik_proxy`

## Exposed vs internal services

| Exposed via Traefik | Internal only |
|---------------------|---------------|
| `frontend` (port 80 on Docker network) | `backend`, `worker`, `inference-runtime`, `postgres`, `postgres-source`, `minio`, `mlflow` |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `MODELFLOW_WEB_HOST` | Public hostname for Traefik `Host()` rules (generated empty; set before Traefik deploy) |
| `CORS_ORIGINS` | Must include `https://${MODELFLOW_WEB_HOST}` |
| `MODELFLOW_BOOTSTRAP_ADMIN_EMAIL` | First admin account email |

All other secrets and database credentials come from `./scripts/init-env.sh --output .env.deploy` unchanged.
