#!/usr/bin/env bash
# Rebuild a clean local stack and wait for every service health check.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
else
  echo "Missing .env. Run ./scripts/init-env.sh first." >&2
  exit 1
fi

docker compose --profile source down -v --remove-orphans
docker compose up --build -d --wait --wait-timeout "${RESET_TIMEOUT_SECONDS:-300}"
docker compose ps
echo "ModelFlow development stack is healthy."
