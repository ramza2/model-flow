#!/usr/bin/env bash
# Unit tests for MSYS/Git Bash Docker path helpers in scripts/lib.sh.
#
# Usage:
#   ./scripts/test-lib-msys.sh
#
# Intentionally avoids Bash 4+ builtins (e.g. mapfile) so these checks run on macOS Bash 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

pass() { echo "[PASS] lib-msys: $*"; }
fail() { echo "[FAIL] lib-msys: $*" >&2; exit 1; }

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$expected" != "$actual" ]]; then
    fail "$label (expected '$expected', got '$actual')"
  fi
}

test_is_msys_default_linux() {
  unset MSYSTEM
  OSTYPE="linux-gnu"
  if modelflow_is_msys; then
    fail "modelflow_is_msys should be false on Linux"
  fi
  pass "modelflow_is_msys false on Linux"
}

test_is_msys_detects_msys() {
  OSTYPE="msys"
  MSYSTEM="MINGW64"
  if ! modelflow_is_msys; then
    fail "modelflow_is_msys should be true when OSTYPE=msys"
  fi
  pass "modelflow_is_msys true on MSYS"
}

test_docker_host_path_passthrough() {
  unset MSYSTEM
  OSTYPE="linux-gnu"
  assert_eq "/tmp/backup" "$(modelflow_docker_host_path "/tmp/backup")" "Linux path passthrough"
  pass "modelflow_docker_host_path passthrough on Linux"
}

test_docker_host_path_cygpath() {
  local fake_bin
  fake_bin="$(mktemp -d)"
  cat >"$fake_bin/cygpath" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-m" && -n "${2:-}" ]]; then
  printf 'C:/Users/test/%s\n' "$(basename "$2")"
fi
EOF
  chmod +x "$fake_bin/cygpath"
  PATH="$fake_bin:$PATH"
  OSTYPE="msys"
  MSYSTEM="MINGW64"
  assert_eq "C:/Users/test/minio" "$(modelflow_docker_host_path "/d/backups/minio")" "cygpath conversion"
  rm -rf "$fake_bin"
  pass "modelflow_docker_host_path uses cygpath on MSYS"
}

test_bind_mount_spec_linux() {
  unset MSYSTEM
  OSTYPE="linux-gnu"
  assert_eq "/data/backup/minio:/backup" \
    "$(modelflow_compose_bind_mount_spec "/data/backup/minio" /backup)" \
    "bind mount spec"
  pass "modelflow_compose_bind_mount_spec on Linux"
}

test_bind_mount_spec_readonly() {
  unset MSYSTEM
  OSTYPE="linux-gnu"
  assert_eq "/data/backup/minio:/backup:ro" \
    "$(modelflow_compose_bind_mount_spec "/data/backup/minio" /backup ro)" \
    "readonly bind mount spec"
  pass "modelflow_compose_bind_mount_spec readonly mode"
}

test_no_mapfile_dependency() {
  if type mapfile >/dev/null 2>&1; then
    pass "mapfile available in this shell (helpers still avoid requiring it)"
    return
  fi
  assert_eq "/tmp/minio:/backup" \
    "$(modelflow_compose_bind_mount_spec "/tmp/minio" /backup)" \
    "bind mount spec without mapfile"
  pass "helpers work without mapfile (Bash 3.x compatible)"
}

test_is_msys_default_linux
test_is_msys_detects_msys
test_docker_host_path_passthrough
test_docker_host_path_cygpath
test_bind_mount_spec_linux
test_bind_mount_spec_readonly
test_no_mapfile_dependency

echo "[PASS] lib-msys: all unit checks"
