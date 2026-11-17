#!/usr/bin/env bash
# Offline regression for backup ownership hardening helpers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

grep -q -- '--user "${BACKUP_UID}:${BACKUP_GID}"' "$ROOT/scripts/backup.sh" \
  || { echo 'backup.sh missing host-user MinIO mirror' >&2; exit 1; }
grep -q 'BACKUP_OWNERSHIP_ERROR' "$ROOT/scripts/backup.sh" \
  || { echo 'backup.sh missing ownership fail-closed check' >&2; exit 1; }
grep -q 'RETENTION_FAIL_EXIT=78' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing retention fail exit code' >&2; exit 1; }
grep -q 'retention_status=' "$ROOT/scripts/ops/backup-daily.sh" \
  || { echo 'backup-daily.sh missing retention_status recording' >&2; exit 1; }

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
cat >"$FIXTURE/bin-find/find" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# Emulate: find DIR -xdev ! -user UID -print0
dir=""
print0=0
for arg in "$@"; do
  if [[ -d "$arg" && -z "$dir" ]]; then
    dir="$arg"
  fi
  if [[ "$arg" == '-print0' ]]; then
    print0=1
  fi
done
[[ -n "$dir" ]] || exit 0
# Report only nested files named foreign.dat using the real find binary.
while IFS= read -r path; do
  if [[ "$print0" -eq 1 ]]; then
    printf '%s\0' "$path"
  else
    printf '%s\n' "$path"
  fi
done < <(/usr/bin/find "$dir" -name 'foreign.dat' -print)
SH
chmod +x "$FIXTURE/bin-find/find"
touch "$eligible/minio/datasets/foreign.dat"
touch "$protected_new/minio/datasets/foreign.dat"

export PATH="$FIXTURE/bin-find:$PATH"
check_out="$(bash "$FIXTURE/scripts/ops/fix-backup-ownership.sh" --check 2>&1 || true)"
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

echo 'MODELFLOW_BACKUP_OWNERSHIP_TEST_PASS'
