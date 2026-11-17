#!/usr/bin/env bash
# Limited recovery helper for root-owned files under backups/auto/.
# Default is dry-run (--check). Never deletes backups. Never touches Cron/DB/volumes.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BACKUP_ROOT="$ROOT/backups"
AUTO_ROOT="$BACKUP_ROOT/auto"
RETENTION_MIN_KEEP=2
MODE='--check'
TARGET_UID="$(id -u)"
TARGET_GID="$(id -g)"

usage() {
  cat <<'EOF'
usage: fix-backup-ownership.sh --check | --apply

  --check  Report root-owned paths under backups/auto (default; no changes)
  --apply  chown matching files to the invoking user when permitted

Safety:
  - Only exact-name non-symlink backups/auto/auto-YYYYMMDDTHHMMSSZ-PID trees
  - Never modifies the newest two verified auto backups
  - Never deletes backups, never follows symlinks, never leaves backups/
  - No sudo escalation; if chown is denied, prints the operator command
EOF
}

fail() {
  echo "BACKUP_OWNERSHIP_ERROR: $*" >&2
  exit 1
}

case "${1:---check}" in
  --help|-h) usage; exit 0 ;;
  --check|--apply) MODE="$1" ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

[[ ! -L "$BACKUP_ROOT" && ! -L "$AUTO_ROOT" ]] || fail 'backup location must not be a symlink'
[[ -d "$AUTO_ROOT" ]] || fail "missing auto backup directory: $AUTO_ROOT"
case "$(realpath -m -- "$AUTO_ROOT")" in
  "$ROOT"/backups/auto) ;;
  *) fail 'auto backup path escaped repository backups/auto' ;;
esac

shopt -s nullglob
candidates=()
for candidate in "$AUTO_ROOT"/auto-*; do
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  name="${candidate##*/}"
  [[ "$name" =~ ^auto-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || continue
  candidates+=("$candidate")
done
if ((${#candidates[@]} > 0)); then
  mapfile -t candidates < <(printf '%s\n' "${candidates[@]}" | LC_ALL=C sort)
fi

protected=()
verified=()
for candidate in "${candidates[@]}"; do
  marker="$candidate/verified.ok"
  if [[ -f "$marker" && ! -L "$marker" ]]; then
    verified+=("$candidate")
  fi
done
if ((${#verified[@]} > 0)); then
  mapfile -t verified < <(printf '%s\n' "${verified[@]}" | LC_ALL=C sort)
  start=0
  if ((${#verified[@]} > RETENTION_MIN_KEEP)); then
    start=$((${#verified[@]} - RETENTION_MIN_KEEP))
  fi
  for ((i=start; i<${#verified[@]}; i++)); do
    protected+=("${verified[$i]}")
  done
fi

is_protected() {
  local path="$1" item
  for item in "${protected[@]:-}"; do
    [[ "$path" == "$item" ]] && return 0
  done
  return 1
}

foreign_count=0
fixed_count=0
denied_count=0
protected_skip=0

for candidate in "${candidates[@]}"; do
  name="${candidate##*/}"
  if is_protected "$candidate"; then
    # Still report foreign ownership under protected trees, but never rewrite them.
    while IFS= read -r -d '' path; do
      ((protected_skip += 1)) || true
      echo "BACKUP_OWNERSHIP_PROTECTED_SKIP=${name}:${path#"$AUTO_ROOT"/}"
    done < <(find "$candidate" -xdev ! -user "$TARGET_UID" -print0 2>/dev/null || true)
    continue
  fi

  while IFS= read -r -d '' path; do
    ((foreign_count += 1)) || true
    rel="${path#"$AUTO_ROOT"/}"
    if [[ "$MODE" == '--check' ]]; then
      echo "BACKUP_OWNERSHIP_FOREIGN=${rel}"
      continue
    fi
    if chown "${TARGET_UID}:${TARGET_GID}" -- "$path" 2>/dev/null; then
      ((fixed_count += 1)) || true
      echo "BACKUP_OWNERSHIP_FIXED=${rel}"
    else
      ((denied_count += 1)) || true
      echo "BACKUP_OWNERSHIP_DENIED=${rel}"
      echo "BACKUP_OWNERSHIP_OPERATOR_HINT=sudo chown -R ${TARGET_UID}:${TARGET_GID} -- $(printf '%q' "$candidate")"
    fi
  done < <(find "$candidate" -xdev ! -user "$TARGET_UID" -print0 2>/dev/null || true)
done

echo "BACKUP_OWNERSHIP_FOREIGN_COUNT=${foreign_count}"
echo "BACKUP_OWNERSHIP_PROTECTED_SKIP_COUNT=${protected_skip}"
echo "BACKUP_OWNERSHIP_FIXED_COUNT=${fixed_count}"
echo "BACKUP_OWNERSHIP_DENIED_COUNT=${denied_count}"
echo "BACKUP_OWNERSHIP_MIN_KEEP=${RETENTION_MIN_KEEP}"
echo "BACKUP_OWNERSHIP_TARGET_UID=${TARGET_UID}"

if [[ "$MODE" == '--check' ]]; then
  if ((foreign_count + protected_skip > 0)); then
    echo 'BACKUP_OWNERSHIP_CHECK_NEEDS_ATTENTION'
    exit 1
  fi
  echo 'BACKUP_OWNERSHIP_CHECK_PASS'
  exit 0
fi

if ((denied_count > 0)); then
  echo 'BACKUP_OWNERSHIP_APPLY_PARTIAL'
  exit 1
fi
echo 'BACKUP_OWNERSHIP_APPLY_PASS'
