#!/usr/bin/env bash
# Back up ModelFlow's PostgreSQL databases and all MinIO buckets.
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

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-${BACKUP_ROOT:-$ROOT/backups}/$TIMESTAMP}"
mkdir -p "$BACKUP_DIR/postgres" "$BACKUP_DIR/minio"

# MinIO mirror historically ran as container root and left host files root-owned,
# which later broke unprivileged retention cleanup. Create mirrored objects as
# the invoking host user whenever possible.
BACKUP_UID="$(id -u)"
BACKUP_GID="$(id -g)"

echo "Creating database dumps in $BACKUP_DIR"
modelflow_compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl \
  > "$BACKUP_DIR/postgres/modelflow.dump"
modelflow_compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d mlflow --format=custom --no-owner --no-acl \
  > "$BACKUP_DIR/postgres/mlflow.dump"

echo "Mirroring MinIO buckets (host uid=${BACKUP_UID} gid=${BACKUP_GID})"
MINIO_MOUNT="$(modelflow_compose_bind_mount_spec "$BACKUP_DIR/minio" /backup)"
modelflow_compose_sh run --rm --no-deps \
  --user "${BACKUP_UID}:${BACKUP_GID}" \
  -e HOME=/tmp \
  -v "$MINIO_MOUNT" \
  --entrypoint sh \
  minio-init -c '
    set -eu
    MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    export MC_HOST_local HOME=/tmp
    for bucket in datasets mlflow batch-results artifacts; do
      mkdir -p "/backup/$bucket"
      mc mirror "local/$bucket" "/backup/$bucket"
    done
  '

{
  echo "created_at=$TIMESTAMP"
  echo "databases=modelflow,mlflow"
  echo "buckets=datasets,mlflow,batch-results,artifacts"
  echo "host_uid=${BACKUP_UID}"
  echo "host_gid=${BACKUP_GID}"
} > "$BACKUP_DIR/metadata.txt"

# Fail closed if Docker still wrote root-owned paths the operator cannot prune,
# or if the ownership scan itself cannot complete.
ownership_err="$(mktemp)"
set +e
foreign_owner="$(find -P "$BACKUP_DIR" ! -user "${BACKUP_UID}" -print -quit 2>"$ownership_err")"
ownership_find_rc=$?
set -e
if [[ "$ownership_find_rc" -ne 0 || -s "$ownership_err" ]]; then
  echo "BACKUP_OWNERSHIP_ERROR: ownership scan failed under ${BACKUP_DIR}" >&2
  if [[ -s "$ownership_err" ]]; then
    cat "$ownership_err" >&2 || true
  fi
  rm -f -- "$ownership_err"
  echo "Re-run after fixing Docker --user support, or use scripts/ops/fix-backup-ownership.sh --check." >&2
  exit 1
fi
rm -f -- "$ownership_err"
if [[ -n "$foreign_owner" ]]; then
  echo "BACKUP_OWNERSHIP_ERROR: backup path not owned by uid ${BACKUP_UID}: ${foreign_owner}" >&2
  echo "Re-run after fixing Docker --user support, or use scripts/ops/fix-backup-ownership.sh --check." >&2
  exit 1
fi

echo "Backup complete: $BACKUP_DIR"
