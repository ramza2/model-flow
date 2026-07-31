#!/usr/bin/env bash
# Usage: ./scripts/restore.sh backups/20260731T053300Z
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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
docker compose stop frontend worker backend mlflow >/dev/null 2>&1 || true
docker compose up -d postgres minio

for attempt in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U modelflow -d postgres >/dev/null \
    && curl -sf http://localhost:9000/minio/health/live >/dev/null; then
    break
  fi
  if [[ $attempt -eq 60 ]]; then
    echo "PostgreSQL or MinIO did not become ready." >&2
    exit 1
  fi
  sleep 2
done

echo "Restoring PostgreSQL databases"
for database in modelflow mlflow; do
  docker compose exec -T postgres \
    dropdb -U modelflow --maintenance-db=postgres --if-exists --force "$database"
  docker compose exec -T postgres \
    createdb -U modelflow --owner=modelflow "$database"
  docker compose exec -T postgres \
    pg_restore -U modelflow -d "$database" --no-owner --no-acl --exit-on-error \
    < "$BACKUP_DIR/postgres/$database.dump"
done

echo "Restoring MinIO buckets"
docker compose run --rm --no-deps \
  -v "$BACKUP_DIR/minio:/backup:ro" \
  --entrypoint /bin/sh \
  minio-init -c '
    set -eu
    mc alias set local http://minio:9000 minioadmin minioadmin
    for bucket in datasets mlflow batch-results artifacts; do
      mc mb -p "local/$bucket" >/dev/null 2>&1 || true
      mc mirror --overwrite --remove "/backup/$bucket" "local/$bucket"
    done
  '

echo "Starting restored stack"
docker compose up -d --wait --wait-timeout 300 mlflow backend worker frontend
echo "Restore complete from: $BACKUP_DIR"
