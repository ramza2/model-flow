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
RETENTION_MIN_KEEP=2
# Distinct from backup creation failure so monitoring can warn without hiding archive success.
RETENTION_FAIL_EXIT=78

usage() {
  echo 'usage: backup-daily.sh --check | --run [--apply-retention]'
  echo '  --check: read-only production target preflight'
  echo '  --run: create and validate a daily backup; report retention candidates'
  echo '  --apply-retention: after successful backup, apply the admin-configured verified auto-backup retention policy'
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

BACKUP_OK=0
RETENTION_STATUS='NOT_REQUESTED'
RETENTION_FAIL_COUNT=0

record_status() {
  rc=$?
  if [[ "$BACKUP_OK" == 1 ]]; then
    status='SUCCESS'
  else
    status='FAILED'
  fi
  printf 'status=%s\nretention_status=%s\nretention_fail_count=%s\nfinished_at=%s\nexit_code=%s\n' \
    "$status" "$RETENTION_STATUS" "$RETENTION_FAIL_COUNT" \
    "$(date -u +%Y%m%dT%H%M%SZ)" "$rc" >"$AUTO_ROOT/last-run.status"
  echo "BACKUP_DAILY_$status exit_code=$rc retention_status=$RETENTION_STATUS"
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
BACKUP_OK=1

finish_retention_skip() {
  local reason="$1"
  RETENTION_STATUS='SKIPPED'
  echo "BACKUP_DAILY_RETENTION_SKIPPED=$reason"
  echo 'BACKUP_DAILY_RETENTION_APPLIED=0'
  echo "BACKUP_DAILY_RETENTION_MIN_KEEP=$RETENTION_MIN_KEEP"
  echo "BACKUP_DAILY_RETENTION_STATUS=$RETENTION_STATUS"
  exit 0
}

# This host runner never trusts browser-supplied filesystem paths. Read the
# administrator-controlled policy through the identified production backend,
# not through a public HTTP endpoint or an arbitrary local .env override.
# A backend/query/format error SKIPS deletion but retains the successful backup.
backend_cid="$("${COMPOSE[@]}" ps -q backend 2>/dev/null || true)"
backend_project=''
backend_service=''
backend_health=''
if [[ -n "$backend_cid" ]]; then
  backend_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$backend_cid" 2>/dev/null || true)"
  backend_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$backend_cid" 2>/dev/null || true)"
  backend_health="$(docker inspect --format '{{.State.Health.Status}}' "$backend_cid" 2>/dev/null || true)"
fi
if [[ "$backend_project" != "$PROJECT" || "$backend_service" != 'backend' || "$backend_health" != 'healthy' ]]; then
  finish_retention_skip 'backend_identity_unavailable'
fi

retention_policy="$("${COMPOSE[@]}" exec -T backend python -m app.services.backup_retention 2>/dev/null)" || retention_policy=''
if [[ ! "$retention_policy" =~ ^enabled=([01])[[:space:]]days=([0-9]{1,3})$ ]]; then
  finish_retention_skip 'policy_unavailable'
fi
retention_enabled="${BASH_REMATCH[1]}"
retention_days="$((10#${BASH_REMATCH[2]}))"
if (( retention_days < 7 || retention_days > 365 )); then
  finish_retention_skip 'policy_invalid'
fi
RETENTION_SECONDS=$((retention_days * 24 * 60 * 60))
echo "BACKUP_DAILY_RETENTION_DAYS=$retention_days"
echo "BACKUP_DAILY_RETENTION_ENABLED=$retention_enabled"

now_epoch="$(date -u +%s)"
expired_count=0
removed_count=0
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
    ((expired_count += 1)) || true
    if [[ "$RETENTION_APPLY" -eq 1 && "$retention_enabled" -eq 1 ]]; then
      echo "RETENTION_REMOVE=$name"
      if rm -rf -- "$candidate"; then
        if [[ -e "$candidate" ]]; then
          echo "RETENTION_REMOVE_FAILED=$name reason=still_present"
          ((RETENTION_FAIL_COUNT += 1)) || true
        else
          ((removed_count += 1)) || true
          echo "RETENTION_REMOVED=$name"
        fi
      else
        echo "RETENTION_REMOVE_FAILED=$name reason=permission_or_rm_error"
        ((RETENTION_FAIL_COUNT += 1)) || true
      fi
    else
      echo "RETENTION_DRY_RUN_CANDIDATE=$name"
    fi
  fi
done

echo "BACKUP_DAILY_RETENTION_CANDIDATES=$expired_count"
echo "BACKUP_DAILY_RETENTION_REMOVED=$removed_count"
echo "BACKUP_DAILY_RETENTION_FAIL_COUNT=$RETENTION_FAIL_COUNT"
echo "BACKUP_DAILY_RETENTION_APPLIED=$((RETENTION_APPLY * retention_enabled))"
echo "BACKUP_DAILY_RETENTION_MIN_KEEP=$RETENTION_MIN_KEEP"

if [[ "$RETENTION_APPLY" -eq 0 ]]; then
  RETENTION_STATUS='DRY_RUN'
elif [[ "$retention_enabled" -eq 0 ]]; then
  RETENTION_STATUS='DISABLED'
elif (( RETENTION_FAIL_COUNT > 0 )); then
  RETENTION_STATUS='FAILED'
  echo 'BACKUP_DAILY_RETENTION_WARNING=cleanup_failed_after_successful_backup'
  echo "BACKUP_DAILY_RETENTION_STATUS=$RETENTION_STATUS"
  echo 'BACKUP_DAILY_HINT=archives_verified_ok_but_retention_cleanup_failed'
  exit "$RETENTION_FAIL_EXIT"
else
  RETENTION_STATUS='SUCCESS'
fi
echo "BACKUP_DAILY_RETENTION_STATUS=$RETENTION_STATUS"
exit 0
