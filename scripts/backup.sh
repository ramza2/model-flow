#!/usr/bin/env bash
# Back up ModelFlow's PostgreSQL databases and all MinIO buckets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

: "${POSTGRES_USER:?Set POSTGRES_USER in .env}"
: "${POSTGRES_DB:?Set POSTGRES_DB in .env}"
: "${MINIO_ROOT_USER:?Set MINIO_ROOT_USER in .env}"
: "${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in .env}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-${BACKUP_ROOT:-$ROOT/backups}/$TIMESTAMP}"
mkdir -p "$BACKUP_DIR/postgres" "$BACKUP_DIR/minio"

echo "Creating database dumps in $BACKUP_DIR"
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl \
  > "$BACKUP_DIR/postgres/modelflow.dump"
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d mlflow --format=custom --no-owner --no-acl \
  > "$BACKUP_DIR/postgres/mlflow.dump"

echo "Mirroring MinIO buckets"
docker compose run --rm --no-deps \
  -v "$BACKUP_DIR/minio:/backup" \
  --entrypoint /bin/sh \
  minio-init -c '
    set -eu
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    for bucket in datasets mlflow batch-results artifacts; do
      mkdir -p "/backup/$bucket"
      mc mirror "local/$bucket" "/backup/$bucket"
    done
  '

{
  echo "created_at=$TIMESTAMP"
  echo "databases=modelflow,mlflow"
  echo "buckets=datasets,mlflow,batch-results,artifacts"
} > "$BACKUP_DIR/metadata.txt"

echo "Backup complete: $BACKUP_DIR"
