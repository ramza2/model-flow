#!/usr/bin/env bash
# Unit-test daily backup safety without any real Docker, database, or MinIO calls.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FIXTURE_ROOT="$(mktemp -d -t modelflow-daily-backup-test.XXXXXX)"
cleanup() {
  [[ "$FIXTURE_ROOT" == /tmp/modelflow-daily-backup-test.* ]] && rm -rf -- "$FIXTURE_ROOT"
}
trap cleanup EXIT

FIXTURE="$FIXTURE_ROOT/model-flow"
mkdir -p "$FIXTURE/scripts/ops" "$FIXTURE/bin" "$FIXTURE/backups"
cp "$ROOT/scripts/ops/backup-daily.sh" "$FIXTURE/scripts/ops/backup-daily.sh"
touch "$FIXTURE/docker-compose.yml" "$FIXTURE/docker-compose.traefik.yml"
printf 'POSTGRES_USER=test\nPOSTGRES_DB=modelflow\n' >"$FIXTURE/.env.deploy"

# backup.sh stub does not contact Docker. It only creates fake backup objects.
cat >"$FIXTURE/scripts/backup.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -n "${BACKUP_DIR:-}" ]] || exit 11
mkdir -p "$BACKUP_DIR/postgres" "$BACKUP_DIR/minio"
if [[ "${MOCK_BACKUP_FAIL:-0}" == '1' ]]; then
  exit 12
fi
printf 'fake db archive\n' >"$BACKUP_DIR/postgres/modelflow.dump"
printf 'fake mlflow archive\n' >"$BACKUP_DIR/postgres/mlflow.dump"
for name in datasets mlflow batch-results artifacts; do
  mkdir -p "$BACKUP_DIR/minio/$name"
done
printf 'created_at=test\n' >"$BACKUP_DIR/metadata.txt"
SH

cat >"$FIXTURE/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  compose)
    case "$*" in
      *' ps -q postgres') echo 'mock-postgres' ;;
      *' ps -q minio') echo 'mock-minio' ;;
      *' exec -T postgres pg_restore --file=/dev/null') exit "${MOCK_PG_RESTORE_FAIL:-0}" ;;
      *) echo 'unexpected docker compose invocation' >&2; exit 9 ;;
    esac
    ;;
  inspect)
    case "$*" in
      *'com.docker.compose.project'*) echo "${MOCK_PROJECT:-model-flow}" ;;
      *'com.docker.compose.service'*)
        if [[ "$*" == *'mock-postgres' ]]; then echo 'postgres'; else echo 'minio'; fi
        ;;
      *'.State.Health.Status'*) echo 'healthy' ;;
      *) echo 'unexpected docker inspect invocation' >&2; exit 9 ;;
    esac
    ;;
  *) echo 'unexpected docker invocation' >&2; exit 9 ;;
esac
SH
chmod +x "$FIXTURE/bin/docker"
export PATH="$FIXTURE/bin:$PATH"

runner=(bash "$FIXTURE/scripts/ops/backup-daily.sh")

"${runner[@]}" --check | grep -q 'BACKUP_DAILY_PRODUCTION_TARGET_PASS'
[[ ! -e "$FIXTURE/backups/auto" ]] || {
  echo 'read-only preflight created backup directory' >&2; exit 1;
}

if MOCK_PROJECT=other "${runner[@]}" --check >/dev/null 2>&1; then
  echo 'wrong Compose project accepted' >&2; exit 1
fi
[[ ! -e "$FIXTURE/backups/auto" ]] || {
  echo 'wrong-project preflight wrote backup directory' >&2; exit 1;
}

printf 'MODELFLOW_COMPOSE_PROJECT_NAME=another\n' >>"$FIXTURE/.env.deploy"
if "${runner[@]}" --check >/dev/null 2>&1; then
  echo 'reserved env override accepted' >&2; exit 1
fi
printf 'POSTGRES_USER=test\nPOSTGRES_DB=modelflow\n' >"$FIXTURE/.env.deploy"

"${runner[@]}" --run
[[ -f "$FIXTURE/backups/auto/last-run.status" ]]
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
verified_count="$(find "$FIXTURE/backups/auto" -mindepth 2 -maxdepth 2 -name verified.ok | wc -l)"
[[ "$verified_count" -eq 1 ]] || {
  echo "unexpected initial verified backup count: $verified_count" >&2; exit 1;
}

if MOCK_BACKUP_FAIL=1 "${runner[@]}" --run; then
  echo 'failing backup was reported successful' >&2; exit 1
fi
grep -q '^status=FAILED$' "$FIXTURE/backups/auto/last-run.status"
verified_count="$(find "$FIXTURE/backups/auto" -mindepth 2 -maxdepth 2 -name verified.ok | wc -l)"
[[ "$verified_count" -eq 1 ]] || {
  echo 'failed backup incorrectly got verified marker' >&2; exit 1;
}

if MOCK_PG_RESTORE_FAIL=1 "${runner[@]}" --run; then
  echo 'unreadable PostgreSQL dump was accepted' >&2; exit 1
fi
grep -q '^status=FAILED$' "$FIXTURE/backups/auto/last-run.status"

old="$FIXTURE/backups/auto/auto-20260901T030000Z-1234"
unverified="$FIXTURE/backups/auto/auto-20260901T030000Z-9999"
manual="$FIXTURE/backups/predeploy-20260901T030000Z"
mkdir -p "$old" "$unverified" "$manual"
touch "$old/verified.ok" "$manual/verified.ok"
touch -d '20 days ago' "$old/verified.ok" "$manual/verified.ok"

# Without the explicit retention flag, even an expired auto backup is retained.
"${runner[@]}" --run
[[ -d "$old" ]] || { echo 'retention dry run deleted data' >&2; exit 1; }

# Explicit retention only removes old, completed auto backups with known names.
"${runner[@]}" --run --apply-retention
[[ ! -e "$old" ]] || { echo 'expired verified auto backup not removed' >&2; exit 1; }
[[ -d "$unverified" ]] || { echo 'unverified backup was removed' >&2; exit 1; }
[[ -d "$manual" ]] || { echo 'manual predeploy backup was removed' >&2; exit 1; }
grep -q '^status=SUCCESS
 "$FIXTURE/backups/auto/last-run.status"
latest_log="$(find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
test -f "$latest_log"
grep -q '^RETENTION_PROTECTED=' "$latest_log"
grep -qx 'BACKUP_DAILY_RETENTION_MIN_KEEP=2' "$latest_log"

echo 'MODELFLOW_DAILY_BACKUP_SAFETY_TEST_PASS'
