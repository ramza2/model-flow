#!/usr/bin/env bash
# Offline regression for backup ownership hardening helpers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

grep -q -- '--user "${BACKUP_UID}:${BACKUP_GID}"' "$ROOT/scripts/backup.sh" \
  || { echo 'backup.sh missing host-user MinIO mirror' >&2; exit 1; }
grep -q 'BACKUP_OWNERSHIP_ERROR' "$ROOT/scripts/backup.sh" \
  || { echo 'backup.sh missing ownership fail-closed check' >&2; exit 1; }
if grep -n 'find -P "\$BACKUP_DIR"' "$ROOT/scripts/backup.sh" | grep -q '|| true'; then
  echo 'backup.sh ownership find still swallows errors with || true' >&2
  exit 1
fi
grep -q 'ownership_find_rc' "$ROOT/scripts/backup.sh" \
  || { echo 'backup.sh missing ownership find fail-closed status check' >&2; exit 1; }
grep -q 'RETENTION_FAIL_EXIT=78' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing retention fail exit code' >&2; exit 1; }
grep -q 'retention_status=' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing retention_status recording' >&2; exit 1; }
grep -q 'retention_candidate_preflight' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing retention preflight' >&2; exit 1; }
grep -q -- '--one-file-system' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing rm --one-file-system' >&2; exit 1; }
grep -q 'partial_delete_quarantined' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing quarantine-on-partial-delete path' >&2; exit 1; }
grep -q 'subdirectory_not_accessible' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing subdirectory access preflight' >&2; exit 1; }
grep -q 'nested_mount' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing nested mount preflight' >&2; exit 1; }
grep -q 'mount_check_failed' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing findmnt fail-closed handling' >&2; exit 1; }
if grep -n 'findmnt' "$ROOT/scripts/ops/backup-daily.sh" | grep -q '< <('; then
  echo 'backup-daily.sh still uses process substitution for findmnt' >&2
  exit 1
fi
grep -q 'SUDO_UID' "$ROOT/scripts/ops/fix-backup-ownership.sh" \
  || { echo 'ownership helper missing SUDO_UID handling' >&2; exit 1; }
grep -q 'BACKUP_OWNERSHIP_SYMLINK_EXTERNAL' "$ROOT/scripts/ops/fix-backup-ownership.sh" \
  || { echo 'ownership helper missing external symlink guard' >&2; exit 1; }
if grep -Eq 'sudo[[:space:]]+chown[[:space:]]+-R|chown[[:space:]]+-R[[:space:]]' \
  "$ROOT/scripts/ops/fix-backup-ownership.sh" "$ROOT/docs/post-ga-daily-backup.md"; then
  echo 'dangerous recursive sudo chown guidance still present' >&2
  exit 1
fi

FIXTURE_ROOT="$(mktemp -d -t modelflow-backup-ownership-test.XXXXXX)"
cleanup() {
  [[ "$FIXTURE_ROOT" == /tmp/modelflow-backup-ownership-test.* ]] && /bin/rm -rf -- "$FIXTURE_ROOT"
}
trap cleanup EXIT

# Build a fake repo layout for the ownership helper.
FIXTURE="$FIXTURE_ROOT/model-flow"
mkdir -p "$FIXTURE/scripts/ops" "$FIXTURE/backups/auto" "$FIXTURE/bin-find"
cp "$ROOT/scripts/ops/fix-backup-ownership.sh" "$FIXTURE/scripts/ops/fix-backup-ownership.sh"

protected_old="$FIXTURE/backups/auto/auto-20261001T030000Z-100"
protected_new="$FIXTURE/backups/auto/auto-20261101T030000Z-200"
eligible="$FIXTURE/backups/auto/auto-20260901T030000Z-50"
mkdir -p "$protected_old/minio/datasets" "$protected_new/minio/datasets" "$eligible/minio/datasets"
touch "$protected_old/verified.ok" "$protected_new/verified.ok" "$eligible/verified.ok"
# Simulate foreign ownership with a file the helper will attempt to chown to self.
# We cannot create true root-owned files in CI; instead create a path owned by the
# current user and force the helper's find predicate by using a fake `find`.
install_find_stub() {
  cat >"$FIXTURE/bin-find/find" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# Distinguish symlink listing (-type l) from foreign-owner listing (! -user),
# including the real helper predicate "! -type l ! -user UID".
dir=""
print0=0
saw_user=0
positive_type_l=0
negated=0
for arg in "$@"; do
  if [[ -d "$arg" && -z "$dir" ]]; then
    dir="$arg"
    continue
  fi
  [[ "$arg" == '-print0' ]] && print0=1
  if [[ "$arg" == '!' ]]; then
    negated=1
    continue
  fi
  if [[ "$arg" == '-type' ]]; then
    # next token handled below via peek in loop is awkward; use state
    next_type=1
    continue
  fi
  if [[ "${next_type:-0}" -eq 1 ]]; then
    if [[ "$arg" == 'l' && "$negated" -eq 0 ]]; then
      positive_type_l=1
    fi
    next_type=0
    negated=0
    continue
  fi
  if [[ "$arg" == '-user' ]]; then
    saw_user=1
    negated=0
    continue
  fi
  negated=0
done
[[ -n "$dir" ]] || exit 0
emit() {
  if [[ "$print0" -eq 1 ]]; then printf '%s\0' "$1"; else printf '%s\n' "$1"; fi
}
if [[ "$saw_user" -eq 1 ]]; then
  while IFS= read -r path; do emit "$path"; done < <(/usr/bin/find -P "$dir" -xdev -name 'foreign.dat' ! -type l -print)
  exit 0
fi
if [[ "$positive_type_l" -eq 1 ]]; then
  while IFS= read -r path; do emit "$path"; done < <(/usr/bin/find -P "$dir" -xdev -type l -print)
  exit 0
fi
exit 0
SH
  chmod +x "$FIXTURE/bin-find/find"
}
install_find_stub
touch "$eligible/minio/datasets/foreign.dat"
touch "$protected_new/minio/datasets/foreign.dat"

export PATH="$FIXTURE/bin-find:$PATH"
check_out="$(bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1 || true)"
printf '%s\n' "$check_out" | grep -q "BACKUP_OWNERSHIP_TARGET_UID=$(id -u)"
printf '%s\n' "$check_out" | grep -q 'BACKUP_OWNERSHIP_FOREIGN=auto-20260901T030000Z-50/minio/datasets/foreign.dat'
printf '%s\n' "$check_out" | grep -q 'BACKUP_OWNERSHIP_PROTECTED_SKIP=auto-20261101T030000Z-200:'
printf '%s\n' "$check_out" | grep -q 'BACKUP_OWNERSHIP_CHECK_NEEDS_ATTENTION'

# Apply should fix the eligible tree and skip rewriting the newest verified backups.
apply_out="$(bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --apply 2>&1)"
printf '%s\n' "$apply_out" | grep -q 'BACKUP_OWNERSHIP_FIXED=auto-20260901T030000Z-50/minio/datasets/foreign.dat'
printf '%s\n' "$apply_out" | grep -q 'BACKUP_OWNERSHIP_PROTECTED_SKIP_COUNT='
printf '%s\n' "$apply_out" | grep -q 'BACKUP_OWNERSHIP_APPLY_PASS'
[[ -f "$eligible/minio/datasets/foreign.dat" ]] || {
  echo 'ownership helper deleted backup content' >&2; exit 1
}
[[ -d "$protected_new" && -d "$protected_old" ]] || {
  echo 'ownership helper removed protected backups' >&2; exit 1
}

# External symlink must fail closed and never become a chown target.
/bin/rm -f "$eligible/minio/datasets/foreign.dat"
outside="$FIXTURE_ROOT/outside-target"
printf 'secret\n' >"$outside"
ln -s "$outside" "$eligible/minio/datasets/escape.link"
set +e
symlink_out="$(bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1)"
symlink_rc=$?
set -e
[[ "$symlink_rc" -ne 0 ]] || {
  echo 'external symlink check unexpectedly passed' >&2; exit 1
}
printf '%s\n' "$symlink_out" | grep -q 'BACKUP_OWNERSHIP_SYMLINK_EXTERNAL='
printf '%s\n' "$symlink_out" | grep -vq 'BACKUP_OWNERSHIP_FIXED='
[[ -L "$eligible/minio/datasets/escape.link" ]] || {
  echo 'symlink node was removed during check' >&2; exit 1
}
[[ "$(cat "$outside")" == 'secret' ]] || {
  echo 'external symlink target was modified' >&2; exit 1
}
/bin/rm -f "$eligible/minio/datasets/escape.link"

# find access errors must fail closed.
cat >"$FIXTURE/bin-find/find" <<'SH'
#!/usr/bin/env bash
echo 'find: Permission denied' >&2
exit 1
SH
chmod +x "$FIXTURE/bin-find/find"
set +e
find_out="$(bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1)"
find_rc=$?
set -e
[[ "$find_rc" -ne 0 ]] || {
  echo 'find failure unexpectedly passed ownership check' >&2; exit 1
}
printf '%s\n' "$find_out" | grep -q 'BACKUP_OWNERSHIP_FIND_FAILED='
printf '%s\n' "$find_out" | grep -q 'BACKUP_OWNERSHIP_FIND_FAIL_COUNT='

# Restore a working find stub for sudo-identity checks.
install_find_stub

# Under a fake root euid, require verified non-root SUDO_UID / SUDO_USER.
mkdir -p "$FIXTURE/bin-id"
REAL_UID="$(id -u)"
REAL_GID="$(id -g)"
REAL_USER="$(id -un)"
cat >"$FIXTURE/bin-id/id" <<SH
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${#}" -eq 1 && "\$1" == '-u' ]]; then
  echo 0
  exit 0
fi
if [[ "\${#}" -eq 1 && "\$1" == '-g' ]]; then
  echo 0
  exit 0
fi
exec /usr/bin/id "\$@"
SH
chmod +x "$FIXTURE/bin-id/id"
export PATH="$FIXTURE/bin-id:$FIXTURE/bin-find:$PATH"

set +e
root_out="$(env -u SUDO_UID -u SUDO_GID -u SUDO_USER \
  bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1)"
root_rc=$?
set -e
[[ "$root_rc" -ne 0 ]] || {
  echo 'root without SUDO_* unexpectedly accepted' >&2; exit 1
}
printf '%s\n' "$root_out" | grep -q 'running as root without verified non-root SUDO_UID/SUDO_USER'

set +e
bad_uid_out="$(
  SUDO_UID=0 SUDO_GID=0 SUDO_USER=root \
    bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1
)"
bad_uid_rc=$?
set -e
[[ "$bad_uid_rc" -ne 0 ]] || {
  echo 'SUDO_UID=0 unexpectedly accepted' >&2; exit 1
}

set +e
sudo_out="$(
  SUDO_UID="$REAL_UID" SUDO_GID="$REAL_GID" SUDO_USER="$REAL_USER" \
    bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1 || true
)"
set -e
printf '%s\n' "$sudo_out" | grep -q "BACKUP_OWNERSHIP_TARGET_UID=${REAL_UID}"
printf '%s\n' "$sudo_out" | grep -q "BACKUP_OWNERSHIP_TARGET_USER=${REAL_USER}"
printf '%s\n' "$sudo_out" | grep -vq 'sudo chown -R'

# backup.sh ownership scan must fail closed when find itself errors.
mkdir -p "$FIXTURE/bin-backup-find" "$FIXTURE/fake-backup"
cat >"$FIXTURE/bin-backup-find/find" <<'SH'
#!/usr/bin/env bash
echo 'find: Permission denied' >&2
exit 1
SH
chmod +x "$FIXTURE/bin-backup-find/find"
ownership_block="$(
  sed -n '/# Fail closed if Docker still wrote root-owned paths/,/^fi$/p' \
    "$ROOT/scripts/backup.sh"
)"
[[ -n "$ownership_block" ]] || {
  echo 'failed to extract backup.sh ownership block' >&2; exit 1
}
set +e
backup_find_out="$(
  PATH="$FIXTURE/bin-backup-find:$PATH" \
  BACKUP_DIR="$FIXTURE/fake-backup" \
  BACKUP_UID="$(id -u)" \
  bash -c "set -euo pipefail; $ownership_block" 2>&1
)"
backup_find_rc=$?
set -e
[[ "$backup_find_rc" -ne 0 ]] || {
  echo 'backup.sh ownership find failure unexpectedly passed' >&2; exit 1
}
printf '%s\n' "$backup_find_out" | grep -q 'BACKUP_OWNERSHIP_ERROR: ownership scan failed'

echo 'MODELFLOW_BACKUP_OWNERSHIP_TEST_PASS'
