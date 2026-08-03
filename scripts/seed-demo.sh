#!/usr/bin/env bash
# Seed a running stack with an authenticated demo project and Iris dataset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

if ! modelflow_load_env "$ROOT"; then
  echo "Missing $(modelflow_env_file "$ROOT"); initialize the environment first." >&2
  exit 2
fi

: "${MODELFLOW_BOOTSTRAP_ADMIN_EMAIL:?Set MODELFLOW_BOOTSTRAP_ADMIN_EMAIL in env}"
: "${MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD:?Set MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD in env}"

BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-8000}"
API_BASE="${MODELFLOW_API_BASE:-http://localhost:${BACKEND_HOST_PORT}/api/v1}"
ADMIN_EMAIL="$MODELFLOW_BOOTSTRAP_ADMIN_EMAIL"
PROJECT_NAME="${DEMO_PROJECT_NAME:-ModelFlow Demo $(date -u +%Y%m%dT%H%M%SZ)}"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"

json_get() {
  local code="$1"
  docker run --rm -i "$PYTHON_IMAGE" python -c "$code"
}

LOGIN_PAYLOAD="$(
  docker run --rm -i \
    -e ADMIN_EMAIL="$ADMIN_EMAIL" \
    -e ADMIN_PASSWORD="$MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD" \
    "$PYTHON_IMAGE" \
    python -c 'import json,os; print(json.dumps({"email": os.environ["ADMIN_EMAIL"], "password": os.environ["ADMIN_PASSWORD"]}))'
)"
LOGIN="$(
  curl -fsS -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "$LOGIN_PAYLOAD"
)"
TOKEN="$(echo "$LOGIN" | json_get 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

PROJECT_PAYLOAD="$(
  docker run --rm -i \
    -e PROJECT_NAME="$PROJECT_NAME" \
    "$PYTHON_IMAGE" \
    python -c 'import json,os; print(json.dumps({"name": os.environ["PROJECT_NAME"], "description": "Seeded Iris classification demo"}))'
)"
PROJECT="$(
  curl -fsS -X POST "$API_BASE/projects" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PROJECT_PAYLOAD"
)"
PROJECT_ID="$(echo "$PROJECT" | json_get 'import json,sys; print(json.load(sys.stdin)["id"])')"

DATASET="$(
  curl -fsS -X POST "$API_BASE/projects/$PROJECT_ID/datasets" \
    -H "Authorization: Bearer $TOKEN" \
    -F "name=Iris Demo" \
    -F "description=Iris classification sample" \
    -F "file=@samples/iris.csv;type=text/csv"
)"
DATASET_ID="$(
  echo "$DATASET" | json_get 'import json,sys; print(json.load(sys.stdin)["id"])'
)"

echo "Seeded project '$PROJECT_NAME' (id=$PROJECT_ID), dataset id=$DATASET_ID"
