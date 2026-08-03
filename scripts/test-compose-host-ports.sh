#!/usr/bin/env bash
# Assert docker compose config honors custom *_HOST_PORT values without editing YAML.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"

fail() {
  echo "[FAIL] compose host ports: $*" >&2
  exit 1
}

POSTGRES_HOST_PORT=15432
SOURCE_POSTGRES_HOST_PORT=15433
MINIO_API_HOST_PORT=19000
MINIO_CONSOLE_HOST_PORT=19001
MLFLOW_HOST_PORT=15000
BACKEND_HOST_PORT=18000
FRONTEND_HOST_PORT=13000

# Provide required Compose variables so `config` can interpolate the full file.
export POSTGRES_USER="${POSTGRES_USER:-modelflow_port_test}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-modelflow_port_test_password}"
export POSTGRES_DB="${POSTGRES_DB:-modelflow_port_test}"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-modelflow_port_test}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-modelflow_port_test_password}"
export SOURCE_POSTGRES_USER="${SOURCE_POSTGRES_USER:-source_port_test}"
export SOURCE_POSTGRES_PASSWORD="${SOURCE_POSTGRES_PASSWORD:-source_port_test_password}"
export SOURCE_POSTGRES_DB="${SOURCE_POSTGRES_DB:-source_port_test}"
export MODELFLOW_SECRET_KEY="${MODELFLOW_SECRET_KEY:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
export MODELFLOW_ENCRYPTION_KEY="${MODELFLOW_ENCRYPTION_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
export MODELFLOW_BOOTSTRAP_ADMIN_EMAIL="${MODELFLOW_BOOTSTRAP_ADMIN_EMAIL:-admin@localhost.local}"
export MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD="${MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD:-bootstrap-port-test-password}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:${FRONTEND_HOST_PORT}}"
export POSTGRES_HOST_PORT SOURCE_POSTGRES_HOST_PORT
export MINIO_API_HOST_PORT MINIO_CONSOLE_HOST_PORT
export MLFLOW_HOST_PORT BACKEND_HOST_PORT FRONTEND_HOST_PORT

mkdir -p "$ROOT/artifacts/verify"
CONFIG_FILE="$(mktemp "$ROOT/artifacts/verify/compose-host-ports.XXXXXX.yml")"
trap 'rm -f "$CONFIG_FILE"' EXIT

if ! docker compose --profile source config >"$CONFIG_FILE"; then
  fail "docker compose config failed"
fi

if ! docker run --rm \
  -v "$CONFIG_FILE:/config.yml:ro" \
  -v "$ROOT/scripts/check-compose-host-ports.py:/check.py:ro" \
  -e POSTGRES_HOST_PORT \
  -e SOURCE_POSTGRES_HOST_PORT \
  -e MINIO_API_HOST_PORT \
  -e MINIO_CONSOLE_HOST_PORT \
  -e MLFLOW_HOST_PORT \
  -e BACKEND_HOST_PORT \
  -e FRONTEND_HOST_PORT \
  "$PYTHON_IMAGE" python /check.py /config.yml; then
  fail "custom host ports were not applied in compose config"
fi

echo "[PASS] custom host ports rendered by docker compose config"
