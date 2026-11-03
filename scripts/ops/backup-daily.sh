#!/usr/bin/env bash
# Daily backup runner for the *existing* ModelFlow production Compose project.
# No scheduled job is installed by this script. Retention deletion is opt-in.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ENV_FILE="$ROOT/.env.deploy"
BACKUP_ROOT="$ROOT/backups"
AUTO_ROOT="$BACKUP_ROOT/auto"
PROJECT="model-flow"
RETENTION_SECONDS=$((14 * 24 * 60 * 60))

usage() {
  echo 'usage: backup-daily.sh --check | --run [--apply-retention]'
  echo '  --check: read-only production target preflight'
  echo '  --run: create and validate a daily backup; report retention candidates'
  echo '  --apply-retention: after successful backup, remove only verified auto-* backups older than 14 days'
}

fail() {
  echo "BACKUP_DAILY_ERROR: $*" >&2
  exit 1
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --check|--run) MODE="$1" ;;
  *) usage >&2; exit 2 ;;
esac

RETENTION_APPLY=0
if [[ "$MODE" == '--run' && "${2:-}" == '--apply-retention' && $# -eq 2 ]]; then
  RETENTION_APPLY=1
elif [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

[[ -f "$ENV_FILE" && -f "$ROOT/scripts/backup.sh" ]] || fail 'required files unavailable'
[[ -f "$ROOT/docker-compose.yml" && -f "$ROOT/docker-compose.traefik.yml" ]] || fail 'Compose files unavailable'

# backup.sh sources .env.deploy itself. Reject values that could redirect it to
# another Compose project or backup location after the runner sets safe exports.
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(MODELFLOW_ENV_FILE|MODELFLOW_COMPOSE_PROJECT_NAME|COMPOSE_PROJECT_NAME|COMPOSE_FILE|BACKUP_DIR|BACKUP_ROOT)[[:space:]]*=' "$ENV_FILE"; then
  fail 'reserved deployment override detected in env file'
fi

export MODELFLOW_ENV_FILE="$ENV_FILE"
export MODELFLOW_COMPOSE_PROJECT_NAME="$PROJECT"
export COMPOSE_FILE="$ROOT/docker-compose.yml:$ROOT/docker-compose.traefik.yml"

COMPOSE=(
  docker compose
  -p "$PROJECT"
  --env-file "$ENV_FILE"
  -f "$ROOT/docker-compose.yml"
  -f "$ROOT/docker-compose.traefik.yml"
)

for service in postgres minio; do
  cid="$("${COMPOSE[@]}" ps -q "$service")"
  [[ -n "$cid" ]] || fail "production $service not running"
  actual_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$cid")"
  actual_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")"
  [[ "$actual_project" == "$PROJECT" && "$actual_service" == "$service" ]] || fail "production $service identity mismatch"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$cid")"
  [[ "$health" == 'healthy' ]] || fail "production $service is not healthy"
done

if [[ "$MODE" == '--check' ]]; then
  echo 'BACKUP_DAILY_PRODUCTION_TARGET_PASS'
  exit 0
fi

command -v flock >/dev/null 2>&1 || fail 'flock is required'
[[ ! -L "$BACKUP_ROOT" && ! -L "$AUTO_ROOT" ]] || fail 'backup location must not be a symlink'
mkdir -p "$AUTO_ROOT"

# Lock is outside dated backup directories and is never deleted by retention.
exec 9>"$AUTO_ROOT/.daily-backup.lock"
if ! flock -n 9; then
  echo 'BACKUP_DAILY_ALREADY_RUNNING' >&2
  exit 75
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
export BACKUP_DIR="$AUTO_ROOT/auto-$STAMP-$$"
mkdir -p "$BACKUP_DIR"
exec >>"$BACKUP_DIR/backup.log" 2>&1

record_status() {
  rc=$?
  if [[ "$rc" == 0 ]]; then
    status='SUCCESS'
  else
    status='FAILED'
  fi
  printf 'status=%s\nfinished_at=%s\nexit_code=%s\n' \
    "$status" "$(date -u +%Y%m%dT%H%M%SZ)" "$rc" >"$AUTO_ROOT/last-run.status"
  echo "BACKUP_DAILY_$status exit_code=$rc"
}
trap record_status EXIT

echo "BACKUP_DAILY_STARTED $STAMP"
bash "$ROOT/scripts/backup.sh"

[[ -s "$BACKUP_DIR/metadata.txt" ]] || fail 'backup metadata missing'
for name in modelflow mlflow; do
  dump="$BACKUP_DIR/postgres/$name.dump"
  [[ -s "$dump" ]] || fail "PostgreSQL archive missing: $name"
  "${COMPOSE[@]}" exec -T postgres pg_restore --file=/dev/null <"$dump" \
    || fail "PostgreSQL archive unreadable: $name"
done
for bucket in datasets mlflow batch-results artifacts; do
  [[ -d "$BACKUP_DIR/minio/$bucket" ]] || fail "MinIO bucket directory missing: $bucket"
done

printf 'verified_at=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$BACKUP_DIR/verified.ok"
echo 'BACKUP_DAILY_ARCHIVES_VERIFIED'

now_epoch="$(date -u +%s)"
expired_count=0
RETENTION_MIN_KEEP=2
shopt -s nullglob

# Sorting exact-name, verified auto folders means the two newest successful
# backups remain protected even if the schedule has been broken for weeks.
verified_backups=()
for candidate in "$AUTO_ROOT"/auto-*; do
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  name="${candidate##*/}"
  [[ "$name" =~ ^auto-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || continue
  marker="$candidate/verified.ok"
  [[ -f "$marker" && ! -L "$marker" ]] || continue
  verified_backups+=("$candidate")
done
if (( ${#verified_backups[@]} > 0 )); then
  mapfile -t verified_backups < <(printf '%s\n' "${verified_backups[@]}" | LC_ALL=C sort)
fi

for (( i=0; i<${#verified_backups[@]}; i++ )); do
  candidate="${verified_backups[$i]}"
  name="${candidate##*/}"
  if (( i >= ${#verified_backups[@]} - RETENTION_MIN_KEEP )); then
    echo "RETENTION_PROTECTED=$name"
    continue
  fi
  marker="$candidate/verified.ok"
  verified_epoch="$(stat -c '%Y' -- "$marker")"
  if ((now_epoch - verified_epoch >= RETENTION_SECONDS)); then
    ((expired_count += 1))
    if [[ "$RETENTION_APPLY" -eq 1 ]]; then
      echo "RETENTION_REMOVE=$name"
      rm -rf -- "$candidate"
    else
      echo "RETENTION_DRY_RUN_CANDIDATE=$name"
    fi
  fi
done

echo "BACKUP_DAILY_RETENTION_CANDIDATES=$expired_count"
echo "BACKUP_DAILY_RETENTION_APPLIED=$RETENTION_APPLY"
echo "BACKUP_DAILY_RETENTION_MIN_KEEP=$RETENTION_MIN_KEEP"
