#!/usr/bin/env bash
# Automated checks that verification preserves the caller's .env and host ports.
#
# This script NEVER creates, overwrites, or deletes the project .env.
# All generated credentials go to temporary files under artifacts/verify/.
#
# Usage:
#   ./scripts/test-env-preservation.sh            # unit + forced-fail verify path
#   ./scripts/test-env-preservation.sh --unit-only  # no verify.sh invocation
#
# Test-only knobs (do not set in normal use):
#   MODELFLOW_ENV_PRESERVATION_FORCE_FAIL=1
#     Exit mid-run after writing a temp env file, so EXIT trap can prove .env
#     is still untouched on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UNIT_ONLY=false
if [[ "${1:-}" == "--unit-only" ]]; then
  UNIT_ONLY=true
fi

PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"
ARTIFACT_DIR="$ROOT/artifacts/verify"
mkdir -p "$ARTIFACT_DIR"

USER_ENV="$ROOT/.env"
USER_ENV_EXISTED=0
USER_ENV_SHA=""
USER_ENV_MODE=""
USER_ENV_SIZE=""
TEMP_FILES=()
SCRIPT_EXIT=0

pass() { echo "[PASS] env-preservation: $*"; }
fail() { echo "[FAIL] env-preservation: $*" >&2; exit 1; }

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    docker run --rm -v "$path:/file:ro" "$PYTHON_IMAGE" \
      python -c 'import hashlib,pathlib; print(hashlib.sha256(pathlib.Path("/file").read_bytes()).hexdigest())'
  fi
}

file_mode() {
  # Portable-ish mode string (octal when available).
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%OLp' "$1"
  fi
}

file_size() {
  if stat -c '%s' "$1" >/dev/null 2>&1; then
    stat -c '%s' "$1"
  else
    stat -f '%z' "$1"
  fi
}

record_user_env_baseline() {
  if [[ -e "$USER_ENV" ]]; then
    USER_ENV_EXISTED=1
    USER_ENV_SHA="$(sha256_file "$USER_ENV")"
    USER_ENV_MODE="$(file_mode "$USER_ENV")"
    USER_ENV_SIZE="$(file_size "$USER_ENV")"
    {
      echo "existed=1"
      echo "sha256=${USER_ENV_SHA}"
      echo "mode=${USER_ENV_MODE}"
      echo "size=${USER_ENV_SIZE}"
    } > "$ARTIFACT_DIR/env-preservation-baseline.txt"
  else
    USER_ENV_EXISTED=0
    USER_ENV_SHA=""
    USER_ENV_MODE=""
    USER_ENV_SIZE=""
    {
      echo "existed=0"
      echo "sha256="
      echo "mode="
      echo "size="
    } > "$ARTIFACT_DIR/env-preservation-baseline.txt"
  fi
}

assert_user_env_unchanged() {
  # Return status only — safe to call from EXIT / signal traps.
  local label="${1:-check}"
  if [[ "$USER_ENV_EXISTED" -eq 1 ]]; then
    if [[ ! -e "$USER_ENV" ]]; then
      echo "[FAIL] env-preservation: project .env was deleted (${label})" >&2
      return 1
    fi
    local after_sha after_mode after_size
    after_sha="$(sha256_file "$USER_ENV")"
    after_mode="$(file_mode "$USER_ENV")"
    after_size="$(file_size "$USER_ENV")"
    echo "$USER_ENV_SHA" > "$ARTIFACT_DIR/env-preservation-${label}-before.sha256"
    echo "$after_sha" > "$ARTIFACT_DIR/env-preservation-${label}-after.sha256"
    if [[ "$after_sha" != "$USER_ENV_SHA" ]]; then
      echo "[FAIL] env-preservation: project .env checksum changed (${label}: before=$USER_ENV_SHA after=$after_sha)" >&2
      return 1
    fi
    if [[ "$after_size" != "$USER_ENV_SIZE" ]]; then
      echo "[FAIL] env-preservation: project .env size changed (${label}: before=$USER_ENV_SIZE after=$after_size)" >&2
      return 1
    fi
    if [[ "$after_mode" != "$USER_ENV_MODE" ]]; then
      echo "[FAIL] env-preservation: project .env mode changed (${label}: before=$USER_ENV_MODE after=$after_mode)" >&2
      return 1
    fi
  else
    if [[ -e "$USER_ENV" ]]; then
      echo "[FAIL] env-preservation: project .env was created (${label}); removing stray file" >&2
      rm -f "$USER_ENV"
      return 1
    fi
  fi
  return 0
}

cleanup_temp_files() {
  local f
  for f in "${TEMP_FILES[@]:-}"; do
    [[ -n "$f" ]] || continue
    rm -f "$f"
  done
  TEMP_FILES=()
}

register_temp() {
  local path="$1"
  TEMP_FILES+=("$path")
  printf '%s\n' "$path"
}

on_exit() {
  local ec=$?
  # Prevent re-entry from nested exit / fail inside this trap.
  trap - EXIT INT TERM
  SCRIPT_EXIT="$ec"
  cleanup_temp_files || true
  if ! assert_user_env_unchanged "exit"; then
    SCRIPT_EXIT=1
  else
    if [[ "$USER_ENV_EXISTED" -eq 1 ]]; then
      echo "[PASS] env-preservation: EXIT trap: project .env unchanged"
    else
      echo "[PASS] env-preservation: EXIT trap: project .env still absent"
    fi
  fi
  exit "$SCRIPT_EXIT"
}

on_signal() {
  local sig="$1"
  echo "[FAIL] env-preservation: received ${sig}; aborting without touching project .env" >&2
  exit 130
}

trap on_exit EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

read_env_value() {
  local file="$1" key="$2"
  (
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
    printf '%s' "${!key}"
  )
}

record_user_env_baseline
if [[ "$USER_ENV_EXISTED" -eq 1 ]]; then
  echo "[INFO] env-preservation: baseline .env sha256=${USER_ENV_SHA} mode=${USER_ENV_MODE} size=${USER_ENV_SIZE}"
else
  echo "[INFO] env-preservation: baseline .env absent (will not create one)"
fi

# --- Unit: init-env preserves exported host ports and CORS ---
OUT_CUSTOM="$(register_temp "$(mktemp "$ARTIFACT_DIR/init-env-custom.XXXXXX")")"

export POSTGRES_HOST_PORT=15432
export SOURCE_POSTGRES_HOST_PORT=15433
export MINIO_API_HOST_PORT=19000
export MINIO_CONSOLE_HOST_PORT=19001
export MLFLOW_HOST_PORT=15000
export BACKEND_HOST_PORT=18000
export FRONTEND_HOST_PORT=13000

./scripts/init-env.sh --non-interactive-test --output "$OUT_CUSTOM" >/dev/null
assert_user_env_unchanged "after-custom-output" || fail "project .env changed after custom --output"

[[ "$(read_env_value "$OUT_CUSTOM" POSTGRES_HOST_PORT)" == "15432" ]] \
  || fail "POSTGRES_HOST_PORT not preserved"
[[ "$(read_env_value "$OUT_CUSTOM" SOURCE_POSTGRES_HOST_PORT)" == "15433" ]] \
  || fail "SOURCE_POSTGRES_HOST_PORT not preserved"
[[ "$(read_env_value "$OUT_CUSTOM" MINIO_API_HOST_PORT)" == "19000" ]] \
  || fail "MINIO_API_HOST_PORT not preserved"
[[ "$(read_env_value "$OUT_CUSTOM" MINIO_CONSOLE_HOST_PORT)" == "19001" ]] \
  || fail "MINIO_CONSOLE_HOST_PORT not preserved"
[[ "$(read_env_value "$OUT_CUSTOM" MLFLOW_HOST_PORT)" == "15000" ]] \
  || fail "MLFLOW_HOST_PORT not preserved"
[[ "$(read_env_value "$OUT_CUSTOM" BACKEND_HOST_PORT)" == "18000" ]] \
  || fail "BACKEND_HOST_PORT not preserved"
[[ "$(read_env_value "$OUT_CUSTOM" FRONTEND_HOST_PORT)" == "13000" ]] \
  || fail "FRONTEND_HOST_PORT not preserved"

CORS="$(read_env_value "$OUT_CUSTOM" CORS_ORIGINS)"
case ",${CORS}," in
  *,http://localhost:13000,*) ;;
  *) fail "CORS_ORIGINS missing http://localhost:13000 (got: $CORS)" ;;
esac
pass "init-env preserves exported host ports and CORS"

# Mid-run forced failure: nested invocation proves EXIT trap preserves .env
# without this script writing to the project root.
if [[ "${MODELFLOW_ENV_PRESERVATION_FORCE_FAIL:-}" == "1" ]]; then
  fail "forced mid-test failure (MODELFLOW_ENV_PRESERVATION_FORCE_FAIL=1)"
fi

if [[ "${MODELFLOW_ENV_PRESERVATION_SKIP_SELF_FAIL:-}" != "1" ]]; then
  echo "[INFO] env-preservation: nested mid-test forced-fail check"
  set +e
  MODELFLOW_ENV_PRESERVATION_FORCE_FAIL=1 \
    MODELFLOW_ENV_PRESERVATION_SKIP_SELF_FAIL=1 \
    "$ROOT/scripts/test-env-preservation.sh" --unit-only
  SELF_FAIL_RC=$?
  set -e
  [[ "$SELF_FAIL_RC" -ne 0 ]] || fail "expected nested mid-test forced-fail to exit non-zero"
  assert_user_env_unchanged "after-self-force-fail" \
    || fail "nested mid-test forced-fail mutated project .env"
  pass "mid-test forced-fail preserves project .env state"
fi

# --- Unit: defaults when host ports are unset ---
unset POSTGRES_HOST_PORT SOURCE_POSTGRES_HOST_PORT
unset MINIO_API_HOST_PORT MINIO_CONSOLE_HOST_PORT
unset MLFLOW_HOST_PORT BACKEND_HOST_PORT FRONTEND_HOST_PORT

OUT_DEFAULT="$(register_temp "$(mktemp "$ARTIFACT_DIR/init-env-default.XXXXXX")")"
./scripts/init-env.sh --non-interactive-test --output "$OUT_DEFAULT" >/dev/null
assert_user_env_unchanged "after-default-output" || fail "project .env changed after default --output"

[[ "$(read_env_value "$OUT_DEFAULT" POSTGRES_HOST_PORT)" == "5432" ]] \
  || fail "default POSTGRES_HOST_PORT expected 5432"
[[ "$(read_env_value "$OUT_DEFAULT" SOURCE_POSTGRES_HOST_PORT)" == "5433" ]] \
  || fail "default SOURCE_POSTGRES_HOST_PORT expected 5433"
[[ "$(read_env_value "$OUT_DEFAULT" MINIO_API_HOST_PORT)" == "9000" ]] \
  || fail "default MINIO_API_HOST_PORT expected 9000"
[[ "$(read_env_value "$OUT_DEFAULT" MINIO_CONSOLE_HOST_PORT)" == "9001" ]] \
  || fail "default MINIO_CONSOLE_HOST_PORT expected 9001"
[[ "$(read_env_value "$OUT_DEFAULT" MLFLOW_HOST_PORT)" == "5000" ]] \
  || fail "default MLFLOW_HOST_PORT expected 5000"
[[ "$(read_env_value "$OUT_DEFAULT" BACKEND_HOST_PORT)" == "8000" ]] \
  || fail "default BACKEND_HOST_PORT expected 8000"
[[ "$(read_env_value "$OUT_DEFAULT" FRONTEND_HOST_PORT)" == "3000" ]] \
  || fail "default FRONTEND_HOST_PORT expected 3000"
CORS_DEFAULT="$(read_env_value "$OUT_DEFAULT" CORS_ORIGINS)"
case ",${CORS_DEFAULT}," in
  *,http://localhost:3000,*) ;;
  *) fail "default CORS_ORIGINS missing http://localhost:3000" ;;
esac
pass "init-env keeps default host ports when unset"

# --- Unit: --output never creates/modifies project .env ---
OUT_SIDE="$(register_temp "$(mktemp "$ARTIFACT_DIR/init-env-side.XXXXXX")")"
./scripts/init-env.sh --non-interactive-test --output "$OUT_SIDE" >/dev/null
assert_user_env_unchanged "after-side-output" || fail "init-env --output mutated project .env"
[[ -f "$OUT_SIDE" ]] || fail "init-env --output did not write target file"
pass "init-env --output leaves project .env untouched"

if [[ "$UNIT_ONLY" == true ]]; then
  pass "unit-only env preservation checks complete"
  exit 0
fi

# Avoid double-nesting when invoked from inside verify.sh's own force-fail child.
if [[ "${MODELFLOW_VERIFY_FORCE_FAIL:-}" == "1" ]]; then
  pass "skipping nested verify forced-fail (already in verify force-fail child)"
  exit 0
fi

# --- Forced-fail verify: never write markers into project .env ---
export POSTGRES_HOST_PORT=15432
export SOURCE_POSTGRES_HOST_PORT=15433
export MINIO_API_HOST_PORT=19000
export MINIO_CONSOLE_HOST_PORT=19001
export MLFLOW_HOST_PORT=15000
export BACKEND_HOST_PORT=18000
export FRONTEND_HOST_PORT=13000

assert_user_env_unchanged "before-verify-force-fail" \
  || fail "baseline drifted before verify forced-fail"

set +e
MODELFLOW_VERIFY_FORCE_FAIL=1 ./scripts/verify.sh
FORCE_RC=$?
set -e
[[ "$FORCE_RC" -ne 0 ]] || fail "expected forced verify failure"

assert_user_env_unchanged "after-verify-force-fail" \
  || fail "forced-fail verify mutated project .env state"
pass "forced-fail verify preserves project .env state"

pass "all env-preservation checks complete"
