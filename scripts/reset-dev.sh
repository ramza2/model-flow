#!/usr/bin/env bash
# Rebuild a clean local stack and wait for every service health check.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose down -v --remove-orphans
docker compose up --build -d --wait --wait-timeout "${RESET_TIMEOUT_SECONDS:-300}"
docker compose ps
echo "ModelFlow development stack is healthy."
