#!/usr/bin/env bash
# Limited recovery helper for foreign-owned files under backups/auto/.
# Default is dry-run (--check). Never deletes backups. Never touches Cron/DB/volumes.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BACKUP_ROOT="$ROOT/backups"
AUTO_ROOT="$BACKUP_ROOT/auto"
RETENTION_MIN_KEEP=2
MODE='--check'
TARGET_UID=''
TARGET_GID=''
TARGET_USER=''

usage() {
  cat <<'EOF'
usage: fix-backup-ownership.sh --check | --apply

  --check  Report foreign-owned paths / unsafe symlinks under backups/auto
  --apply  chown matching regular files/dirs to the verified ops user

Safety:
  - Only exact-name non-symlink backups/auto/auto-YYYYMMDDTHHMMSSZ-PID trees
  - Never modifies the newest two verified auto backups
  - Never deletes backups; never follows symlinks; never leaves backups/auto
  - find access errors fail closed
  - Under sudo, target identity comes from SUDO_UID/SUDO_GID or SUDO_USER
    (must be a verified non-root account). Root is never the chown target.
EOF
}

fail() {
  echo "BACKUP_OWNERSHIP_ERROR: $*" >&2
  exit 1
}

is_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

resolve_target_identity() {
  local euid egid sudo_uid sudo_gid sudo_user resolved_uid resolved_gid
  euid="$(id -u)"
  egid="$(id -g)"

  if [[ "$euid" -ne 0 ]]; then
    TARGET_UID="$euid"
    TARGET_GID="$egid"
    TARGET_USER="$(id -un)"
    return 0
  fi

  # Running as root: only accept a verified non-root invoking operator identity.
  sudo_uid="${SUDO_UID:-}"
  sudo_gid="${SUDO_GID:-}"
  sudo_user="${SUDO_USER:-}"

  if is_uint "$sudo_uid" && is_uint "$sudo_gid" && [[ "$sudo_uid" -ne 0 ]]; then
    if ! getent passwd "$sudo_uid" >/dev/null 2>&1; then
      fail "SUDO_UID=${sudo_uid} does not resolve to a local user"
    fi
    resolved_uid="$sudo_uid"
    resolved_gid="$(id -g "$sudo_uid")"
    # Prefer the kernel-reported primary GID for that UID when SUDO_GID disagrees.
    if [[ "$sudo_gid" -ne "$resolved_gid" ]]; then
      echo "BACKUP_OWNERSHIP_WARN=sudo_gid_mismatch using_primary_gid=${resolved_gid}" >&2
    fi
    if [[ -n "$sudo_user" && "$sudo_user" != 'root' ]]; then
      if [[ "$(id -u "$sudo_user")" -ne "$resolved_uid" ]]; then
        fail "SUDO_USER=${sudo_user} does not match SUDO_UID=${sudo_uid}"
      fi
      TARGET_USER="$sudo_user"
    else
      TARGET_USER="$(id -un "$resolved_uid")"
    fi
    TARGET_UID="$resolved_uid"
    TARGET_GID="$resolved_gid"
    return 0
  fi

  if [[ -n "$sudo_user" && "$sudo_user" != 'root' ]]; then
    if ! getent passwd "$sudo_user" >/dev/null 2>&1; then
      fail "SUDO_USER=${sudo_user} does not resolve to a local user"
    fi
    resolved_uid="$(id -u "$sudo_user")"
    resolved_gid="$(id -g "$sudo_user")"
    if [[ "$resolved_uid" -eq 0 ]]; then
      fail 'refusing root as ownership target'
    fi
    TARGET_UID="$resolved_uid"
    TARGET_GID="$resolved_gid"
    TARGET_USER="$sudo_user"
    return 0
  fi

  fail 'running as root without verified non-root SUDO_UID/SUDO_USER'
}

case "${1:---check}" in
  --help|-h) usage; exit 0 ;;
  --check|--apply) MODE="$1" ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

resolve_target_identity
echo "BACKUP_OWNERSHIP_TARGET_UID=${TARGET_UID}"
echo "BACKUP_OWNERSHIP_TARGET_GID=${TARGET_GID}"
echo "BACKUP_OWNERSHIP_TARGET_USER=${TARGET_USER}"

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

# Scan one candidate. Fail closed on find errors or escape/symlink issues.
# Sets global arrays _scan_foreign and _scan_symlinks (NUL-delimited via temp files).
scan_candidate() {
  local candidate="$1"
  local errfile list_foreign list_symlink find_rc
  errfile="$(mktemp)"
  list_foreign="$(mktemp)"
  list_symlink="$(mktemp)"
  # -P: never follow symlinks. Stay on one filesystem.
  set +e
  find -P "$candidate" -xdev -type l -print0 >"$list_symlink" 2>"$errfile"
  find_rc=$?
  set -e
  if [[ "$find_rc" -ne 0 || -s "$errfile" ]]; then
    echo "BACKUP_OWNERSHIP_FIND_FAILED=${candidate##*/}"
    rm -f -- "$errfile" "$list_foreign" "$list_symlink"
    return 1
  fi
  : >"$errfile"
  set +e
  # Regular files/dirs not owned by the verified ops user (exclude symlink nodes).
  find -P "$candidate" -xdev ! -type l ! -user "$TARGET_UID" -print0 >"$list_foreign" 2>"$errfile"
  find_rc=$?
  set -e
  if [[ "$find_rc" -ne 0 || -s "$errfile" ]]; then
    echo "BACKUP_OWNERSHIP_FIND_FAILED=${candidate##*/}"
    rm -f -- "$errfile" "$list_foreign" "$list_symlink"
    return 1
  fi

  # Reject symlink nodes whose targets resolve outside this candidate tree.
  if [[ -s "$list_symlink" ]]; then
    while IFS= read -r -d '' linkpath; do
      local resolved
      if ! resolved="$(realpath -m -- "$linkpath" 2>/dev/null)"; then
        echo "BACKUP_OWNERSHIP_SYMLINK_UNRESOLVED=${linkpath#"$AUTO_ROOT"/}"
        rm -f -- "$errfile" "$list_foreign" "$list_symlink"
        return 1
      fi
      case "$resolved" in
        "$candidate"|"$candidate"/*) ;;
        *)
          echo "BACKUP_OWNERSHIP_SYMLINK_EXTERNAL=${linkpath#"$AUTO_ROOT"/}"
          rm -f -- "$errfile" "$list_foreign" "$list_symlink"
          return 1
          ;;
      esac
      # Even in-tree symlinks are never chown targets; report and block apply.
      echo "BACKUP_OWNERSHIP_SYMLINK=${linkpath#"$AUTO_ROOT"/}"
    done <"$list_symlink"
  fi

  SCAN_FOREIGN_FILE="$list_foreign"
  SCAN_SYMLINK_FILE="$list_symlink"
  rm -f -- "$errfile"
  return 0
}

foreign_count=0
fixed_count=0
denied_count=0
protected_skip=0
symlink_block_count=0
find_fail_count=0
had_fatal=0

for candidate in "${candidates[@]}"; do
  name="${candidate##*/}"
  SCAN_FOREIGN_FILE=''
  SCAN_SYMLINK_FILE=''
  if ! scan_candidate "$candidate"; then
    ((find_fail_count += 1)) || true
    had_fatal=1
    continue
  fi

  if [[ -s "${SCAN_SYMLINK_FILE:-}" ]]; then
    ((symlink_block_count += 1)) || true
    had_fatal=1
    # Symlink trees are reported and never rewritten.
    rm -f -- "${SCAN_FOREIGN_FILE:-}" "${SCAN_SYMLINK_FILE:-}"
    continue
  fi

  if is_protected "$candidate"; then
    while IFS= read -r -d '' path; do
      ((protected_skip += 1)) || true
      echo "BACKUP_OWNERSHIP_PROTECTED_SKIP=${name}:${path#"$AUTO_ROOT"/}"
    done <"${SCAN_FOREIGN_FILE}"
    rm -f -- "${SCAN_FOREIGN_FILE}" "${SCAN_SYMLINK_FILE}"
    continue
  fi

  while IFS= read -r -d '' path; do
    # Defense: never chown a symlink node even if find filter regresses.
    if [[ -L "$path" ]]; then
      echo "BACKUP_OWNERSHIP_SYMLINK_SKIP=${path#"$AUTO_ROOT"/}"
      ((symlink_block_count += 1)) || true
      had_fatal=1
      continue
    fi
    ((foreign_count += 1)) || true
    rel="${path#"$AUTO_ROOT"/}"
    if [[ "$MODE" == '--check' ]]; then
      echo "BACKUP_OWNERSHIP_FOREIGN=${rel}"
      continue
    fi
    # chown without -h on a non-symlink path; refuse if path became a symlink.
    if [[ -L "$path" ]]; then
      echo "BACKUP_OWNERSHIP_SYMLINK_SKIP=${rel}"
      ((denied_count += 1)) || true
      had_fatal=1
      continue
    fi
    if chown "${TARGET_UID}:${TARGET_GID}" -- "$path" 2>/dev/null; then
      ((fixed_count += 1)) || true
      echo "BACKUP_OWNERSHIP_FIXED=${rel}"
    else
      ((denied_count += 1)) || true
      had_fatal=1
      echo "BACKUP_OWNERSHIP_DENIED=${rel}"
      echo 'BACKUP_OWNERSHIP_OPERATOR_HINT=re-run as the ops user, or use a controlled sudo -u <ops-user> invocation of this script'
    fi
  done <"${SCAN_FOREIGN_FILE}"

  rm -f -- "${SCAN_FOREIGN_FILE}" "${SCAN_SYMLINK_FILE}"
done

echo "BACKUP_OWNERSHIP_FOREIGN_COUNT=${foreign_count}"
echo "BACKUP_OWNERSHIP_PROTECTED_SKIP_COUNT=${protected_skip}"
echo "BACKUP_OWNERSHIP_FIXED_COUNT=${fixed_count}"
echo "BACKUP_OWNERSHIP_DENIED_COUNT=${denied_count}"
echo "BACKUP_OWNERSHIP_SYMLINK_BLOCK_COUNT=${symlink_block_count}"
echo "BACKUP_OWNERSHIP_FIND_FAIL_COUNT=${find_fail_count}"
echo "BACKUP_OWNERSHIP_MIN_KEEP=${RETENTION_MIN_KEEP}"

if [[ "$MODE" == '--check' ]]; then
  if ((foreign_count + protected_skip + symlink_block_count + find_fail_count > 0)) || [[ "$had_fatal" -eq 1 ]]; then
    echo 'BACKUP_OWNERSHIP_CHECK_NEEDS_ATTENTION'
    exit 1
  fi
  echo 'BACKUP_OWNERSHIP_CHECK_PASS'
  exit 0
fi

if ((denied_count + symlink_block_count + find_fail_count > 0)) || [[ "$had_fatal" -eq 1 ]]; then
  echo 'BACKUP_OWNERSHIP_APPLY_PARTIAL'
  exit 1
fi
echo 'BACKUP_OWNERSHIP_APPLY_PASS'
