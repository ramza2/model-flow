#!/usr/bin/env bash
# Validate Traefik-aware restore prerequisites without wiping production data.
# - restore.sh documents --traefik / --no-start
# - Traefik overlay compose config clears MinIO host ports
# - MinIO health can be probed via compose exec (no localhost published port)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

ARTIFACT_DIR="${VERIFY_ARTIFACT_DIR:-$ROOT/artifacts/verify}"
mkdir -p "$ARTIFACT_DIR"

fail() {
  echo "[FAIL] restore traefik: $*" >&2
  exit 1
}

pass() {
  echo "[PASS] restore traefik: $*"
}

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

CONFIG_OUT="$ARTIFACT_DIR/restore-traefik-compose-config.yml"
COMPOSE_FILE="$ROOT/docker-compose.yml:$ROOT/docker-compose.traefik.yml"
export COMPOSE_FILE
docker compose --env-file "$ENV_FILE" config >"$CONFIG_OUT" \
  || fail "traefik overlay compose config failed"

python3 - "$CONFIG_OUT" <<'PY' || fail "MinIO still publishes a host port under Traefik overlay"
import sys, yaml
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f)
minio = (cfg.get("services") or {}).get("minio") or {}
ports = minio.get("ports") or []
if ports:
    raise SystemExit(f"expected minio.ports empty under Traefik, got {ports!r}")
print("minio.ports=[]")
PY
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

echo "[PASS] Traefik restore prerequisites"
