#!/usr/bin/env bash
# Validate Traefik-aware restore prerequisites without wiping production data.
# - restore.sh documents --traefik / --no-start
# - Traefik overlay compose config clears MinIO host ports
# - MinIO health can be probed via compose exec (no localhost published port)
#
# Does not write interpolated Compose config to disk (credentials may be present).
# Does not require host Python, PyYAML, or jq.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

ARTIFACT_DIR="${VERIFY_ARTIFACT_DIR:-$ROOT/artifacts/verify}"
mkdir -p "$ARTIFACT_DIR"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"

fail() {
  echo "[FAIL] restore traefik: $*" >&2
  exit 1
}

pass() {
  echo "[PASS] restore traefik: $*"
}

# Remove any prior full-config artifact that may contain interpolated secrets.
# Overwrite before unlink so residual plaintext is not left on disk.
scrub_compose_config_artifact() {
  local path="$1"
  if [[ -f "$path" ]]; then
    : >"$path" || true
    rm -f "$path" || true
  fi
}
scrub_compose_config_artifact "$ARTIFACT_DIR/restore-traefik-compose-config.yml"
scrub_compose_config_artifact "/opt/cursor/artifacts/restore-traefik-compose-config.yml"

chmod +x "$ROOT/scripts/restore.sh"

HELP_OUT="$ARTIFACT_DIR/restore-help.txt"
./scripts/restore.sh --help >"$HELP_OUT"
grep -q -- '--traefik' "$HELP_OUT" || fail "restore --help missing --traefik"
grep -q -- '--no-start' "$HELP_OUT" || fail "restore --help missing --no-start"
grep -q -- '--no-traefik' "$HELP_OUT" || fail "restore --help missing --no-traefik"
pass "restore.sh help lists Traefik and --no-start options"

# Compose config with Traefik overlay must not publish MinIO (or require host :9000).
TRAEFIK_NETWORK="${TRAEFIK_NETWORK:-traefik_proxy}"
if ! docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1; then
  docker network create "$TRAEFIK_NETWORK" >/dev/null
  CREATED_TRAEFIK_NET=1
else
  CREATED_TRAEFIK_NET=0
fi

cleanup() {
  if [[ "${CREATED_TRAEFIK_NET:-0}" == "1" ]]; then
    docker network rm "$TRAEFIK_NETWORK" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ENV_FILE="$(modelflow_env_file "$ROOT")"
if [[ ! -f "$ENV_FILE" ]]; then
  fail "missing env file for compose config: $ENV_FILE"
fi

# Ensure Host() label interpolates; Traefik overlay requires MODELFLOW_WEB_HOST.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export MODELFLOW_WEB_HOST="${MODELFLOW_WEB_HOST:-restore-traefik-test.example}"

COMPOSE_FILE="$ROOT/docker-compose.yml:$ROOT/docker-compose.traefik.yml"
export COMPOSE_FILE

# Stream JSON config through a disposable Python container. Never persist the
# interpolated document (it can embed DB/MinIO credentials). On failure, do not
# dump compose stdout/stderr to the verification log.
if ! docker compose --env-file "$ENV_FILE" config --format json 2>/dev/null \
  | docker run --rm -i "$PYTHON_IMAGE" python -c '
import json, sys
try:
    cfg = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit("compose config json unavailable")
minio = (cfg.get("services") or {}).get("minio") or {}
ports = minio.get("ports") or []
if ports:
    # Count only — do not echo binding objects (may include host/IP detail).
    raise SystemExit(f"expected minio.ports empty under Traefik, got {len(ports)} published port(s)")
print("minio.ports=[]")
'; then
  fail "Traefik overlay compose config failed or MinIO still publishes a host port"
fi
pass "Traefik overlay compose config clears MinIO host ports"

# Prefer a live verify/minio container when present; otherwise start a disposable one.
MINIO_HEALTH_OK=0
if modelflow_compose ps -q minio >/dev/null 2>&1 \
  && [[ -n "$(modelflow_compose ps -q minio 2>/dev/null || true)" ]]; then
  if modelflow_compose exec -T minio curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null; then
    MINIO_HEALTH_OK=1
    pass "MinIO health via compose exec against project stack"
  fi
fi

if [[ "$MINIO_HEALTH_OK" -ne 1 ]]; then
  # Disposable container using the same organization MinIO image pin.
  MINIO_IMAGE="${MINIO_RESTORE_TEST_IMAGE:-modelflow/minio:RELEASE.2025-10-15T17-29-55Z}"
  NAME="mf-restore-minio-health-$$"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e MINIO_ROOT_USER=restoretest \
    -e MINIO_ROOT_PASSWORD=restoretest_password_not_for_prod \
    "$MINIO_IMAGE" server /data >/dev/null \
    || fail "could not start disposable MinIO for health probe"
  for _ in $(seq 1 30); do
    if docker exec "$NAME" curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
      MINIO_HEALTH_OK=1
      break
    fi
    sleep 1
  done
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ "$MINIO_HEALTH_OK" -eq 1 ]] || fail "in-container MinIO health probe failed"
  pass "MinIO health via in-container curl (no host port)"
fi

# Static guard: restore.sh must not curl localhost MinIO API host port.
if grep -E 'localhost:\$\{?MINIO_API_HOST_PORT|localhost:\$\{MINIO_API_HOST_PORT' \
  "$ROOT/scripts/restore.sh" >/dev/null; then
  fail "restore.sh still depends on localhost MINIO_API_HOST_PORT"
fi
if ! grep -q 'minio curl -sf http://127.0.0.1:9000/minio/health/live' \
  "$ROOT/scripts/restore.sh"; then
  fail "restore.sh missing in-container MinIO health check"
fi
if ! grep -q 'NO_START' "$ROOT/scripts/restore.sh"; then
  fail "restore.sh missing --no-start handling"
fi
pass "restore.sh uses in-container MinIO health and --no-start"

# Final guard: full compose config must not be left as a verification artifact.
if [[ -e "$ARTIFACT_DIR/restore-traefik-compose-config.yml" ]] \
  || [[ -e "/opt/cursor/artifacts/restore-traefik-compose-config.yml" ]]; then
  fail "compose config artifact still present (must not persist interpolated secrets)"
fi

echo "[PASS] Traefik restore prerequisites"
