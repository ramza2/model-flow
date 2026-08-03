#!/usr/bin/env bash
# Automated checks that verification preserves the caller's .env and host ports.
# Usage:
#   ./scripts/test-env-preservation.sh            # unit + forced-fail verify path
#   ./scripts/test-env-preservation.sh --unit-only  # no verify.sh invocation
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

read_env_value() {
  local file="$1" key="$2"
  # shellcheck disable=SC1090
  (
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
    printf '%s' "${!key}"
  )
}

# --- Unit: init-env preserves exported host ports and CORS ---
OUT_CUSTOM="$(mktemp "$ARTIFACT_DIR/init-env-custom.XXXXXX")"
trap 'rm -f "$OUT_CUSTOM" "$OUT_DEFAULT" "${FORCE_FAIL_MARKER:-}"' EXIT

export POSTGRES_HOST_PORT=15432
export SOURCE_POSTGRES_HOST_PORT=15433
export MINIO_API_HOST_PORT=19000
export MINIO_CONSOLE_HOST_PORT=19001
export MLFLOW_HOST_PORT=15000
export BACKEND_HOST_PORT=18000
export FRONTEND_HOST_PORT=13000

./scripts/init-env.sh --non-interactive-test --output "$OUT_CUSTOM" >/dev/null

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

# --- Unit: defaults when host ports are unset ---
unset POSTGRES_HOST_PORT SOURCE_POSTGRES_HOST_PORT
unset MINIO_API_HOST_PORT MINIO_CONSOLE_HOST_PORT
unset MLFLOW_HOST_PORT BACKEND_HOST_PORT FRONTEND_HOST_PORT

OUT_DEFAULT="$(mktemp "$ARTIFACT_DIR/init-env-default.XXXXXX")"
./scripts/init-env.sh --non-interactive-test --output "$OUT_DEFAULT" >/dev/null

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
MARKER_CONTENT="# env-preservation-marker-$(date +%s)-$$"$'\n'"FRONTEND_HOST_PORT=13000"$'\n'
USER_ENV="$ROOT/.env"
HAD_USER_ENV=0
USER_ENV_BACKUP=""
if [[ -f "$USER_ENV" ]]; then
  HAD_USER_ENV=1
  USER_ENV_BACKUP="$(mktemp "$ARTIFACT_DIR/user-env-backup.XXXXXX")"
  cp -a "$USER_ENV" "$USER_ENV_BACKUP"
  BEFORE_SHA="$(sha256_file "$USER_ENV")"
else
  printf '%s' "$MARKER_CONTENT" > "$USER_ENV"
  chmod 600 "$USER_ENV"
  BEFORE_SHA="$(sha256_file "$USER_ENV")"
fi

OUT_SIDE="$(mktemp "$ARTIFACT_DIR/init-env-side.XXXXXX")"
./scripts/init-env.sh --non-interactive-test --output "$OUT_SIDE" >/dev/null
AFTER_SHA="$(sha256_file "$USER_ENV")"
[[ "$AFTER_SHA" == "$BEFORE_SHA" ]] || fail "init-env --output mutated project .env"
[[ -f "$OUT_SIDE" ]] || fail "init-env --output did not write target file"
rm -f "$OUT_SIDE"
pass "init-env --output leaves project .env untouched"

restore_user_env() {
  if [[ "$HAD_USER_ENV" -eq 1 ]]; then
    cp -a "$USER_ENV_BACKUP" "$USER_ENV"
    rm -f "$USER_ENV_BACKUP"
  else
    # We created a temporary marker .env for the test; remove it unless a later
    # forced-fail verify step still needs it.
    if [[ "${KEEP_MARKER_ENV:-0}" != "1" ]]; then
      rm -f "$USER_ENV"
    fi
  fi
}

# --- Forced-fail is covered by verify.sh step 0a when run as the full gate.
# Standalone mode still exercises it once for local debugging.
if [[ "$UNIT_ONLY" == true ]]; then
  restore_user_env
  pass "unit-only env preservation checks complete"
  exit 0
fi

# Avoid double-nesting when invoked from inside verify.sh's own force-fail child.
if [[ "${MODELFLOW_VERIFY_FORCE_FAIL:-}" == "1" ]]; then
  restore_user_env
  pass "skipping nested forced-fail (already in force-fail child)"
  exit 0
fi

KEEP_MARKER_ENV=1
if [[ "$HAD_USER_ENV" -eq 1 ]]; then
  printf '%s' "$MARKER_CONTENT" > "$USER_ENV"
  chmod 600 "$USER_ENV"
fi
FORCE_BEFORE="$(sha256_file "$USER_ENV")"
echo "$FORCE_BEFORE" > "$ARTIFACT_DIR/env-preservation-force-before.sha256"

export POSTGRES_HOST_PORT=15432
export SOURCE_POSTGRES_HOST_PORT=15433
export MINIO_API_HOST_PORT=19000
export MINIO_CONSOLE_HOST_PORT=19001
export MLFLOW_HOST_PORT=15000
export BACKEND_HOST_PORT=18000
export FRONTEND_HOST_PORT=13000

set +e
MODELFLOW_VERIFY_FORCE_FAIL=1 ./scripts/verify.sh
FORCE_RC=$?
set -e
[[ "$FORCE_RC" -ne 0 ]] || fail "expected forced verify failure"

FORCE_AFTER="$(sha256_file "$USER_ENV")"
echo "$FORCE_AFTER" > "$ARTIFACT_DIR/env-preservation-force-after.sha256"
[[ "$FORCE_AFTER" == "$FORCE_BEFORE" ]] \
  || fail "forced-fail verify mutated .env (before=$FORCE_BEFORE after=$FORCE_AFTER)"
pass "forced-fail verify preserves .env checksum"

if [[ "$HAD_USER_ENV" -eq 1 ]]; then
  cp -a "$USER_ENV_BACKUP" "$USER_ENV"
  rm -f "$USER_ENV_BACKUP"
else
  rm -f "$USER_ENV"
fi

pass "all env-preservation checks complete"
