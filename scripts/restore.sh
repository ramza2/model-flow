#!/usr/bin/env bash
# Restore ModelFlow PostgreSQL databases and MinIO buckets from a backup directory.
#
# Usage:
#   ./scripts/restore.sh [--traefik|--no-traefik] [--no-start] <backup-directory>
#
# Options:
#   --traefik       Use docker-compose.yml + docker-compose.traefik.yml
#                   (required when the live stack was deployed with Traefik;
#                   MinIO/Postgres host ports are not published)
#   --no-traefik    Base docker-compose.yml only (default; local / verify stacks)
#   --no-start      Restore data only; leave mlflow/backend/worker/frontend stopped
#                   so operators can reattach known-good images before starting
#
# Destructive: replaces application + mlflow databases and mirrors MinIO buckets.
# Do not run against production without an external backup of the current state.
# PostgreSQL/MinIO wipe or re-init outside this explicit restore path is forbidden.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

USE_TRAEFIK=false
NO_START=false
BACKUP_ARG=""
TRAEFIK_NETWORK="traefik_proxy"
TRAEFIK_COMPOSE_FILE="$ROOT/docker-compose.traefik.yml"
BASE_COMPOSE_FILE="$ROOT/docker-compose.yml"

usage() {
  cat <<'EOF'
Usage: ./scripts/restore.sh [--traefik|--no-traefik] [--no-start] <backup-directory>

Restore PostgreSQL (modelflow + mlflow) and MinIO buckets from a backup directory
created by ./scripts/backup.sh.

Options:
  --traefik       Include docker-compose.traefik.yml (production Traefik overlay)
  --no-traefik    Base compose only (default)
  --no-start      Do not start mlflow/backend/worker/frontend after restore
  -h, --help      Show this help

Examples:
  ./scripts/restore.sh backups/20260731T053300Z
  MODELFLOW_ENV_FILE=.env.deploy ./scripts/restore.sh --traefik --no-start backups/...
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --traefik)
      USE_TRAEFIK=true
      shift
      ;;
    --no-traefik)
      USE_TRAEFIK=false
      shift
      ;;
    --no-start)
      NO_START=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$BACKUP_ARG" ]]; then
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      BACKUP_ARG="$1"
      shift
      ;;
  esac
done

if [[ -z "$BACKUP_ARG" ]]; then
  usage >&2
  exit 2
fi

if ! modelflow_load_env "$ROOT"; then
  echo "Missing $(modelflow_env_file "$ROOT"); initialize the environment first." >&2
  exit 2
fi

: "${POSTGRES_USER:?Set POSTGRES_USER in env}"
: "${POSTGRES_DB:?Set POSTGRES_DB in env}"
: "${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in env}"
: "${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in env}"

if [[ "$USE_TRAEFIK" == true ]]; then
  if [[ ! -f "$TRAEFIK_COMPOSE_FILE" ]]; then
    echo "Missing Traefik overlay: $TRAEFIK_COMPOSE_FILE" >&2
    exit 1
  fi
  if ! docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1; then
    echo "Docker network '$TRAEFIK_NETWORK' not found." >&2
    echo "Traefik restores require the same external network used by deploy.sh --traefik." >&2
    exit 1
  fi
  # Prefer COMPOSE_FILE so modelflow_compose / modelflow_compose_sh pick up the overlay
  # without changing lib.sh call sites. Path separator is ':' on Linux/macOS.
  export COMPOSE_FILE="${BASE_COMPOSE_FILE}:${TRAEFIK_COMPOSE_FILE}"
  echo "Using Traefik Compose overlay (COMPOSE_FILE=$COMPOSE_FILE)"
fi

BACKUP_DIR="$(cd "$BACKUP_ARG" && pwd)"
for dump in modelflow mlflow; do
  if [[ ! -s "$BACKUP_DIR/postgres/$dump.dump" ]]; then
    echo "Missing database dump: $BACKUP_DIR/postgres/$dump.dump" >&2
    exit 2
  fi
done
for bucket in datasets mlflow batch-results artifacts; do
  if [[ ! -d "$BACKUP_DIR/minio/$bucket" ]]; then
    echo "Missing bucket backup: $BACKUP_DIR/minio/$bucket" >&2
    exit 2
  fi
done

echo "Stopping application services during restore"
modelflow_compose stop frontend worker backend mlflow >/dev/null 2>&1 || true
modelflow_compose up -d postgres minio

# Health checks use in-container endpoints so Traefik overlays (no host-published
# MinIO port) and local Compose stacks share one path.
for attempt in $(seq 1 60); do
  if modelflow_compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null \
    && modelflow_compose exec -T minio curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null; then
    break
  fi
  if [[ $attempt -eq 60 ]]; then
    echo "PostgreSQL or MinIO did not become ready." >&2
    exit 1
  fi
  sleep 2
done

echo "Restoring PostgreSQL databases"
for database in "$POSTGRES_DB" mlflow; do
  dump_name="$database"
  if [[ "$database" == "$POSTGRES_DB" ]]; then
    dump_name="modelflow"
  fi
  modelflow_compose exec -T postgres \
    dropdb -U "$POSTGRES_USER" --maintenance-db=postgres --if-exists --force "$database"
  modelflow_compose exec -T postgres \
    createdb -U "$POSTGRES_USER" --owner="$POSTGRES_USER" "$database"
  modelflow_compose exec -T postgres \
    pg_restore -U "$POSTGRES_USER" -d "$database" --no-owner --no-acl --exit-on-error \
    < "$BACKUP_DIR/postgres/$dump_name.dump"
done

echo "Restoring MinIO buckets"
MINIO_MOUNT="$(modelflow_compose_bind_mount_spec "$BACKUP_DIR/minio" /backup ro)"
modelflow_compose_sh run --rm --no-deps \
  -v "$MINIO_MOUNT" \
  --entrypoint sh \
  minio-init -c '
    set -eu
    MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    export MC_HOST_local
    for bucket in datasets mlflow batch-results artifacts; do
      mc mb -p "local/$bucket" >/dev/null 2>&1 || true
      mc mirror --overwrite --remove "/backup/$bucket" "local/$bucket"
    done
  '

if [[ "$NO_START" == true ]]; then
  echo "Restore complete from: $BACKUP_DIR"
  echo "Application services left stopped (--no-start)."
  echo "Reattach known-good mlflow/backend/worker/frontend images, then start them explicitly."
  echo "Do not start a newer image against a restored older database."
else
  echo "Starting restored stack"
  modelflow_compose up -d --wait --wait-timeout 300 mlflow backend worker frontend
  echo "Restore complete from: $BACKUP_DIR"
fi
