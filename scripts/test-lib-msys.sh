#!/usr/bin/env bash
# Unit tests for MSYS/Git Bash Docker path helpers in scripts/lib.sh.
#
# Usage:
#   ./scripts/test-lib-msys.sh
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
  trap 'rm -rf "$fake_bin"' EXIT
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
  pass "modelflow_docker_host_path uses cygpath on MSYS"
}

test_bind_mount_args_linux() {
  unset MSYSTEM
  OSTYPE="linux-gnu"
  mapfile -t mount < <(modelflow_compose_bind_mount_args "/data/backup/minio" /backup)
  assert_eq "-v" "${mount[0]}" "bind mount flag"
  assert_eq "/data/backup/minio:/backup" "${mount[1]}" "bind mount spec"
  pass "modelflow_compose_bind_mount_args on Linux"
}

test_bind_mount_args_readonly() {
  unset MSYSTEM
  OSTYPE="linux-gnu"
  mapfile -t mount < <(modelflow_compose_bind_mount_args "/data/backup/minio" /backup ro)
  assert_eq "/data/backup/minio:/backup:ro" "${mount[1]}" "readonly bind mount spec"
  pass "modelflow_compose_bind_mount_args readonly mode"
}

test_is_msys_default_linux
test_is_msys_detects_msys
test_docker_host_path_passthrough
test_docker_host_path_cygpath
test_bind_mount_args_linux
test_bind_mount_args_readonly

echo "[PASS] lib-msys: all unit checks"
