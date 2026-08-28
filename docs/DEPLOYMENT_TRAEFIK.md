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
            PostgreSQL / MinIO / MLflow / worker
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

Edit `.env.deploy` for production (minimum):

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

Recommended backup before upgrade:

```bash
BACKUP_DIR=/path/to/backups ./scripts/backup.sh
```

(Uses the project `.env` by default; for deploy env, set `MODELFLOW_ENV_FILE=.env.deploy` or symlink as documented in `scripts/backup.sh`.)

Redeploy:

```bash
./scripts/deploy.sh --traefik --build --migrate --force-recreate
```

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
| `--migrate` | `alembic upgrade head` via backend image before `up` |
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

- Removes host port publishing from: `postgres`, `postgres-source`, `minio`, `mlflow`, `backend`, `frontend` via `ports: !reset []`
- Adds `restart: unless-stopped` to long-running services (not `minio-init`)
- Connects `frontend` to `default` + external `traefik_proxy`
- Traefik labels on `frontend` only (`modelflow-*` prefix):
  - HTTP → HTTPS redirect (`modelflow-web-http`, entrypoint `web`)
  - HTTPS router (`modelflow-web`, entrypoint `websecure`, `letsencrypt`)
  - Service target port `80`, `traefik.docker.network=traefik_proxy`

## Exposed vs internal services

| Exposed via Traefik | Internal only |
|---------------------|---------------|
| `frontend` (port 80 on Docker network) | `backend`, `worker`, `postgres`, `postgres-source`, `minio`, `mlflow` |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `MODELFLOW_WEB_HOST` | Public hostname for Traefik `Host()` rules (Traefik deploy only) |
| `CORS_ORIGINS` | Must include `https://${MODELFLOW_WEB_HOST}` |
| `MODELFLOW_BOOTSTRAP_ADMIN_EMAIL` | First admin account email |

All other secrets and database credentials come from `./scripts/init-env.sh --output .env.deploy` unchanged.
