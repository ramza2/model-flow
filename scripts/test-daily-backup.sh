#!/usr/bin/env bash
# Unit-test daily backup safety without any real Docker, database, or MinIO calls.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FIXTURE_ROOT="$(mktemp -d -t modelflow-daily-backup-test.XXXXXX)"
cleanup() {
  [[ "$FIXTURE_ROOT" == /tmp/modelflow-daily-backup-test.* ]] && /bin/rm -rf -- "$FIXTURE_ROOT"
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
      *' ps -q backend') echo 'mock-backend' ;;
      *' exec -T postgres pg_restore --file=/dev/null') exit "${MOCK_PG_RESTORE_FAIL:-0}" ;;
      *' exec -T backend python -m app.services.backup_retention')
        [[ "${MOCK_RETENTION_POLICY_UNAVAILABLE:-0}" != '1' ]] || exit 8
        echo "${MOCK_RETENTION_POLICY:-enabled=1 days=14}"
        ;;
      *) echo 'unexpected docker compose invocation' >&2; exit 9 ;;
    esac
    ;;
  inspect)
    case "$*" in
      *'com.docker.compose.project'*) echo "${MOCK_PROJECT:-model-flow}" ;;
      *'com.docker.compose.service'*)
        if [[ "$*" == *'mock-postgres' ]]; then echo 'postgres';
        elif [[ "$*" == *'mock-backend' ]]; then echo 'backend';
        else echo 'minio'; fi
        ;;
      *'.State.Health.Status'*)
        if [[ "$*" == *'mock-backend' ]]; then echo "${MOCK_BACKEND_HEALTH:-healthy}";
        else echo 'healthy'; fi
        ;;
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

# Admin may disable cleanup or extend the retention window without editing Cron.
MOCK_RETENTION_POLICY='enabled=0 days=14' "${runner[@]}" --run --apply-retention
[[ -d "$old" ]] || { echo 'disabled retention deleted data' >&2; exit 1; }
MOCK_RETENTION_POLICY='enabled=1 days=30' "${runner[@]}" --run --apply-retention
[[ -d "$old" ]] || { echo 'extended retention deleted data' >&2; exit 1; }

# Backend/policy errors must never revert to an unsafe deletion fallback.
MOCK_RETENTION_POLICY_UNAVAILABLE=1 "${runner[@]}" --run --apply-retention
[[ -d "$old" ]] || { echo 'unavailable policy deleted data' >&2; exit 1; }
MOCK_BACKEND_HEALTH=unhealthy "${runner[@]}" --run --apply-retention
[[ -d "$old" ]] || { echo 'unhealthy backend deleted data' >&2; exit 1; }
MOCK_RETENTION_POLICY='enabled=1 days=invalid' "${runner[@]}" --run --apply-retention
[[ -d "$old" ]] || { echo 'invalid policy deleted data' >&2; exit 1; }

# Preflight: not-writable candidate must be kept intact (no partial delete).
chmod a-w "$old"
set +e
"${runner[@]}" --run --apply-retention
nowrite_rc=$?
set -e
[[ "$nowrite_rc" -eq 78 ]] || {
  echo "expected not-writable retention-fail exit 78, got $nowrite_rc" >&2; exit 1
}
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^retention_status=FAILED$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^exit_code=78$' "$FIXTURE/backups/auto/last-run.status"
[[ -d "$old" && -f "$old/verified.ok" ]] || {
  echo 'not-writable candidate was altered during retention' >&2; exit 1
}
nowrite_log="$(find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=directory_not_writable$' "$nowrite_log"
chmod u+w "$old"

# Preflight: symlink inside candidate blocks deletion and keeps the tree intact.
ln -s /tmp/modelflow-retention-symlink-target "$old/evil.link"
set +e
"${runner[@]}" --run --apply-retention
symlink_rc=$?
set -e
[[ "$symlink_rc" -eq 78 ]] || {
  echo "expected symlink retention-fail exit 78, got $symlink_rc" >&2; exit 1
}
[[ -d "$old" && -L "$old/evil.link" && -f "$old/verified.ok" ]] || {
  echo 'symlink candidate was partially deleted' >&2; exit 1
}
symlink_log="$(find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=symlink_present$' "$symlink_log"
/bin/rm -f "$old/evil.link"

# Permission-denied cleanup must not hide a successful verified backup.
stub_rm="$FIXTURE/bin/rm"
cat >"$stub_rm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    *auto-20260901T030000Z-1234*)
      echo "rm: cannot remove '$arg': Permission denied" >&2
      exit 1
      ;;
  esac
done
exec /bin/rm "$@"
SH
chmod +x "$stub_rm"

set +e
"${runner[@]}" --run --apply-retention
rc=$?
set -e
[[ "$rc" -eq 78 ]] || {
  echo "expected retention-fail exit 78, got $rc" >&2; exit 1
}
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status" \
  || { echo 'permission failure flipped backup status away from SUCCESS' >&2; exit 1; }
grep -q '^retention_status=FAILED$' "$FIXTURE/backups/auto/last-run.status" \
  || { echo 'retention failure not recorded separately' >&2; exit 1; }
grep -q '^exit_code=78$' "$FIXTURE/backups/auto/last-run.status"
[[ -d "$old" && -f "$old/verified.ok" ]] || {
  echo 'failed retention unexpectedly deleted or truncated old backup' >&2; exit 1
}
perm_log="$(find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_FAILED=auto-20260901T030000Z-1234' "$perm_log"
grep -q '^BACKUP_DAILY_RETENTION_WARNING=cleanup_failed_after_successful_backup$' "$perm_log"
verified_count="$(find "$FIXTURE/backups/auto" -mindepth 2 -maxdepth 2 -name verified.ok | wc -l)"
[[ "$verified_count" -ge 2 ]] || {
  echo 'verified marker missing after retention permission failure' >&2; exit 1
}

# Re-run after the permission blocker is removed: cleanup succeeds and backup stays SUCCESS.
/bin/rm -f "$stub_rm"
"${runner[@]}" --run --apply-retention
[[ ! -e "$old" ]] || { echo 'expired verified auto backup not removed after re-run' >&2; exit 1; }
[[ -d "$unverified" ]] || { echo 'unverified backup was removed' >&2; exit 1; }
[[ -d "$manual" ]] || { echo 'manual predeploy backup was removed' >&2; exit 1; }
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^retention_status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^exit_code=0$' "$FIXTURE/backups/auto/last-run.status"
latest_log="$(find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
test -f "$latest_log"
grep -q '^RETENTION_PROTECTED=' "$latest_log"
grep -qx 'BACKUP_DAILY_RETENTION_MIN_KEEP=2' "$latest_log"
grep -qx 'BACKUP_DAILY_RETENTION_STATUS=SUCCESS' "$latest_log"

# Partial deletion: one candidate fails, another succeeds; still warn and keep SUCCESS.
partial_a="$FIXTURE/backups/auto/auto-20260801T030000Z-1111"
partial_b="$FIXTURE/backups/auto/auto-20260815T030000Z-2222"
mkdir -p "$partial_a" "$partial_b"
touch "$partial_a/verified.ok" "$partial_b/verified.ok"
touch -d '20 days ago' "$partial_a/verified.ok" "$partial_b/verified.ok"
cat >"$stub_rm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    *auto-20260801T030000Z-1111*)
      echo "rm: cannot remove '$arg': Permission denied" >&2
      exit 1
      ;;
  esac
done
exec /bin/rm "$@"
SH
chmod +x "$stub_rm"
set +e
"${runner[@]}" --run --apply-retention
partial_rc=$?
set -e
[[ "$partial_rc" -eq 78 ]] || {
  echo "expected partial retention-fail exit 78, got $partial_rc" >&2; exit 1
}
[[ -d "$partial_a" && -f "$partial_a/verified.ok" ]] || {
  echo 'permission-blocked candidate deleted or truncated' >&2; exit 1
}
[[ ! -e "$partial_b" ]] || { echo 'deletable candidate survived partial run' >&2; exit 1; }
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^retention_status=FAILED$' "$FIXTURE/backups/auto/last-run.status"
/bin/rm -f "$stub_rm"

echo 'MODELFLOW_DAILY_BACKUP_SAFETY_TEST_PASS'
