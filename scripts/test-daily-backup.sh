#!/usr/bin/env bash
# Unit-test daily backup safety without any real Docker, database, or MinIO calls.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FIXTURE_ROOT="$(mktemp -d -t modelflow-daily-backup-test.XXXXXX)"
cleanup_mounts() {
  local mp
  while IFS= read -r mp; do
    case "$mp" in
      "$FIXTURE_ROOT"/*)
        sudo -n umount "$mp" 2>/dev/null || true
        ;;
    esac
  done < <(findmnt -n -r -o TARGET 2>/dev/null || true)
}
cleanup() {
  cleanup_mounts
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
nowrite_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=directory_not_writable$' "$nowrite_log"
chmod u+w "$old"

# Preflight: nested subdirectory without write access blocks deletion intact.
mkdir -p "$old/minio/datasets"
touch "$old/minio/datasets/object.bin"
chmod a-w "$old/minio/datasets"
set +e
"${runner[@]}" --run --apply-retention
subdir_rc=$?
set -e
[[ "$subdir_rc" -eq 78 ]] || {
  echo "expected subdirectory retention-fail exit 78, got $subdir_rc" >&2; exit 1
}
[[ -d "$old" && -f "$old/verified.ok" && -f "$old/minio/datasets/object.bin" ]] || {
  echo 'subdirectory permission candidate was altered' >&2; exit 1
}
subdir_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=subdirectory_not_accessible$' "$subdir_log"
chmod u+w "$old/minio/datasets"

# Preflight: nested bind mount blocks deletion and keeps the tree intact.
mount_src="$FIXTURE_ROOT/mount-src"
mkdir -p "$old/minio/mounted" "$mount_src"
printf 'mount-payload\n' >"$mount_src/payload.bin"
sudo -n mount --bind "$mount_src" "$old/minio/mounted"
set +e
"${runner[@]}" --run --apply-retention
mount_rc=$?
set -e
[[ "$mount_rc" -eq 78 ]] || {
  echo "expected nested-mount retention-fail exit 78, got $mount_rc" >&2; exit 1
}
[[ -d "$old" && -f "$old/verified.ok" && -f "$old/minio/mounted/payload.bin" ]] || {
  echo 'nested-mount candidate was altered' >&2; exit 1
}
mount_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=nested_mount$' "$mount_log"
sudo -n umount "$old/minio/mounted"
rmdir "$old/minio/mounted" 2>/dev/null || /bin/rm -rf -- "$old/minio/mounted"

# Preflight: findmnt execution failure must fail closed (not skip the mount check).
mkdir -p "$FIXTURE/bin-findmnt"
cat >"$FIXTURE/bin-findmnt/findmnt" <<'SH'
#!/usr/bin/env bash
echo 'findmnt: cannot read /proc/self/mountinfo' >&2
exit 1
SH
chmod +x "$FIXTURE/bin-findmnt/findmnt"
set +e
PATH="$FIXTURE/bin-findmnt:$PATH" "${runner[@]}" --run --apply-retention
findmnt_rc=$?
set -e
[[ "$findmnt_rc" -eq 78 ]] || {
  echo "expected findmnt-failure retention-fail exit 78, got $findmnt_rc" >&2; exit 1
}
[[ -d "$old" && -f "$old/verified.ok" ]] || {
  echo 'findmnt-failure candidate was altered' >&2; exit 1
}
findmnt_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=mount_check_failed$' "$findmnt_log"
/bin/rm -f "$FIXTURE/bin-findmnt/findmnt"

# Preflight: find access errors fail closed and leave the candidate untouched.
mkdir -p "$FIXTURE/bin-find"
cat >"$FIXTURE/bin-find/find" <<'SH'
#!/usr/bin/env bash
echo 'find: Permission denied' >&2
exit 1
SH
chmod +x "$FIXTURE/bin-find/find"
set +e
PATH="$FIXTURE/bin-find:$PATH" "${runner[@]}" --run --apply-retention
find_rc=$?
set -e
[[ "$find_rc" -eq 78 ]] || {
  echo "expected find-error retention-fail exit 78, got $find_rc" >&2; exit 1
}
[[ -d "$old" && -f "$old/verified.ok" ]] || {
  echo 'find-error candidate was altered' >&2; exit 1
}
find_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=find_error$' "$find_log"
/bin/rm -f "$FIXTURE/bin-find/find"

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
symlink_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_SKIPPED=auto-20260901T030000Z-1234 reason=symlink_present$' "$symlink_log"
/bin/rm -f "$old/evil.link"

# Mid-delete failure must quarantine incomplete trees (never restore as verified).
stub_rm="$FIXTURE/bin/rm"
cat >"$stub_rm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
recursive=0
one_file_system=0
for arg in "$@"; do
  case "$arg" in
    -r|-R|--recursive|-rf|-fr|-hr|-rr) recursive=1 ;;
    --one-file-system) one_file_system=1 ;;
    -*)
      # Combined short options like -rf
      [[ "$arg" == *r* || "$arg" == *R* ]] && recursive=1
      ;;
  esac
done
if [[ "$recursive" -eq 1 && "$one_file_system" -ne 1 ]]; then
  echo 'rm stub expected --one-file-system for recursive delete' >&2
  exit 9
fi
for arg in "$@"; do
  case "$arg" in
    *auto-20260901T030000Z-1234.retention-pending-*)
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
[[ ! -e "$old" ]] || {
  echo 'partial delete incorrectly restored original verified backup path' >&2; exit 1
}
quarantine="$(/usr/bin/find "$FIXTURE/backups/auto" -maxdepth 1 -type d -name 'auto-20260901T030000Z-1234.retention-incomplete-*' | head -n 1)"
[[ -n "$quarantine" && -d "$quarantine" ]] || {
  echo 'incomplete backup was not quarantined' >&2; exit 1
}
[[ ! -f "$quarantine/verified.ok" ]] || {
  echo 'quarantine still exposes verified.ok as a live verified backup' >&2; exit 1
}
perm_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
grep -q '^RETENTION_REMOVE_FAILED=auto-20260901T030000Z-1234 reason=partial_delete_quarantined$' "$perm_log"
grep -q '^RETENTION_QUARANTINED=auto-20260901T030000Z-1234.retention-incomplete-' "$perm_log"
grep -q '^BACKUP_DAILY_RETENTION_WARNING=cleanup_failed_after_successful_backup$' "$perm_log"
# Newest verified backups remain; quarantined tree must not count as verified.ok.
verified_count="$(/usr/bin/find "$FIXTURE/backups/auto" -mindepth 2 -maxdepth 2 -name verified.ok | wc -l)"
[[ "$verified_count" -ge 2 ]] || {
  echo 'verified marker missing after retention permission failure' >&2; exit 1
}

# Re-run after the permission blocker is removed: quarantine stays; backup SUCCESS.
/bin/rm -f "$stub_rm"
"${runner[@]}" --run --apply-retention
[[ ! -e "$old" ]] || { echo 'expired verified auto backup path reappeared after re-run' >&2; exit 1; }
[[ -d "$quarantine" ]] || { echo 'quarantined incomplete backup disappeared unexpectedly' >&2; exit 1; }
[[ -d "$unverified" ]] || { echo 'unverified backup was removed' >&2; exit 1; }
[[ -d "$manual" ]] || { echo 'manual predeploy backup was removed' >&2; exit 1; }
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^retention_status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^exit_code=0$' "$FIXTURE/backups/auto/last-run.status"
latest_log="$(/usr/bin/find "$FIXTURE/backups/auto" -type f -name backup.log | sort | tail -n 1)"
test -f "$latest_log"
grep -q '^RETENTION_PROTECTED=' "$latest_log"
grep -qx 'BACKUP_DAILY_RETENTION_MIN_KEEP=2' "$latest_log"
grep -qx 'BACKUP_DAILY_RETENTION_STATUS=SUCCESS' "$latest_log"

# Partial deletion across candidates: one quarantined, one removed; SUCCESS+FAILED.
partial_a="$FIXTURE/backups/auto/auto-20260801T030000Z-1111"
partial_b="$FIXTURE/backups/auto/auto-20260815T030000Z-2222"
mkdir -p "$partial_a" "$partial_b"
touch "$partial_a/verified.ok" "$partial_b/verified.ok"
touch -d '20 days ago' "$partial_a/verified.ok" "$partial_b/verified.ok"
cat >"$stub_rm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
recursive=0
one_file_system=0
for arg in "$@"; do
  case "$arg" in
    -r|-R|--recursive|-rf|-fr|-hr|-rr) recursive=1 ;;
    --one-file-system) one_file_system=1 ;;
    -*)
      [[ "$arg" == *r* || "$arg" == *R* ]] && recursive=1
      ;;
  esac
done
if [[ "$recursive" -eq 1 && "$one_file_system" -ne 1 ]]; then
  echo 'rm stub expected --one-file-system for recursive delete' >&2
  exit 9
fi
for arg in "$@"; do
  case "$arg" in
    *auto-20260801T030000Z-1111.retention-pending-*)
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
[[ ! -e "$partial_a" ]] || {
  echo 'failed candidate was restored as original verified path' >&2; exit 1
}
partial_quarantine="$(/usr/bin/find "$FIXTURE/backups/auto" -maxdepth 1 -type d -name 'auto-20260801T030000Z-1111.retention-incomplete-*' | head -n 1)"
[[ -n "$partial_quarantine" && -d "$partial_quarantine" ]] || {
  echo 'failed candidate was not quarantined' >&2; exit 1
}
[[ ! -e "$partial_b" ]] || { echo 'deletable candidate survived partial run' >&2; exit 1; }
grep -q '^status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
grep -q '^retention_status=FAILED$' "$FIXTURE/backups/auto/last-run.status"
/bin/rm -f "$stub_rm"

# Successful deletes must pass --one-file-system through to rm.
cat >"$stub_rm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
recursive=0
one_file_system=0
for arg in "$@"; do
  case "$arg" in
    -r|-R|--recursive|-rf|-fr|-hr|-rr) recursive=1 ;;
    --one-file-system) one_file_system=1 ;;
    -*)
      [[ "$arg" == *r* || "$arg" == *R* ]] && recursive=1
      ;;
  esac
done
if [[ "$recursive" -eq 1 && "$one_file_system" -ne 1 ]]; then
  echo 'rm stub expected --one-file-system on success path' >&2
  exit 9
fi
exec /bin/rm "$@"
SH
chmod +x "$stub_rm"
success_old="$FIXTURE/backups/auto/auto-20260701T030000Z-3333"
mkdir -p "$success_old"
touch "$success_old/verified.ok"
touch -d '20 days ago' "$success_old/verified.ok"
"${runner[@]}" --run --apply-retention
[[ ! -e "$success_old" ]] || {
  echo 'expired candidate not removed when rm stub enforces --one-file-system' >&2; exit 1
}
grep -q '^retention_status=SUCCESS$' "$FIXTURE/backups/auto/last-run.status"
/bin/rm -f "$stub_rm"

echo 'MODELFLOW_DAILY_BACKUP_SAFETY_TEST_PASS'
