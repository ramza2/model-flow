#!/usr/bin/env bash
# Usage: ./scripts/restore.sh backups/20260731T053300Z
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

if ! modelflow_load_env "$ROOT"; then
  echo "Missing $(modelflow_env_file "$ROOT"); initialize the environment first." >&2
  exit 2
fi

: "${POSTGRES_USER:?Set POSTGRES_USER in env}"
: "${POSTGRES_DB:?Set POSTGRES_DB in env}"
: "${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in env}"
: "${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in env}"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <backup-directory>" >&2
  exit 2
fi

BACKUP_DIR="$(cd "$1" && pwd)"
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

MINIO_API_HOST_PORT="${MINIO_API_HOST_PORT:-9000}"
for attempt in $(seq 1 60); do
  if modelflow_compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null \
    && curl -sf "http://localhost:${MINIO_API_HOST_PORT}/minio/health/live" >/dev/null; then
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
modelflow_compose run --rm --no-deps \
  -v "$BACKUP_DIR/minio:/backup:ro" \
  --entrypoint /bin/sh \
  minio-init -c '
    set -eu
    MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    export MC_HOST_local
    for bucket in datasets mlflow batch-results artifacts; do
      mc mb -p "local/$bucket" >/dev/null 2>&1 || true
      mc mirror --overwrite --remove "/backup/$bucket" "local/$bucket"
    done
  '

echo "Starting restored stack"
modelflow_compose up -d --wait --wait-timeout 300 mlflow backend worker frontend
echo "Restore complete from: $BACKUP_DIR"
