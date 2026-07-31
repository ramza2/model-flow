#!/usr/bin/env bash
# ModelFlow verification gate.
# Host prerequisites: Docker, Docker Compose plugin, curl, bash.
# Node.js/npm/npx and host Python are NOT required.
# Designed for both local and non-interactive CI (GitHub Actions).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/screenshots artifacts/verify

NODE_IMAGE="node:22.17-alpine"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.49.1-jammy"
PYTHON_IMAGE="python:3.11-slim"
REQUIRED_SERVICES=(frontend backend worker postgres mlflow minio)

VERIFY_EXIT=0
VERIFY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*"; exit 1; }
info() { echo "[INFO] $*"; }

# Parse JSON from stdin inside a container (no host Python/Node required for scripting).
json_get() {
  local code="$1"
  docker run --rm -i "$PYTHON_IMAGE" python -c "$code"
}

collect_diagnostics() {
  local ec="${1:-$?}"
  mkdir -p artifacts/verify
  {
    echo "verify_started_at=${VERIFY_STARTED_AT}"
    echo "verify_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "exit_code=${ec}"
    echo "cwd=${ROOT}"
    echo "ci=${CI:-false}"
  } > artifacts/verify/meta.txt

  {
    echo "=== docker compose ps -a ==="
    docker compose ps -a 2>&1 || true
    echo
    echo "=== docker compose ps (format) ==="
    docker compose ps -a --format '{{.Service}}={{.Health}}={{.State}}' 2>&1 || true
  } | tee artifacts/verify/compose-ps-final.txt >/dev/null || true

  if [[ "$ec" -ne 0 ]]; then
    info "Collecting service logs after failure (exit=${ec})"
    for svc in postgres minio mlflow backend worker frontend minio-init; do
      docker compose logs --no-color --tail=200 "$svc" \
        > "artifacts/verify/logs-${svc}.txt" 2>&1 || \
        echo "(no logs for ${svc})" > "artifacts/verify/logs-${svc}.txt"
    done
    docker compose logs --no-color --tail=400 \
      > artifacts/verify/logs-all.txt 2>&1 || true
    echo "FAIL" > artifacts/verify/RESULT.txt
  fi
}

on_exit() {
  local ec=$?
  VERIFY_EXIT="$ec"
  collect_diagnostics "$ec" || true
  exit "$ec"
}
trap on_exit EXIT

require_host_tools() {
  for bin in docker curl bash; do
    command -v "$bin" >/dev/null || fail "missing required host tool: $bin"
  done
  docker compose version >/dev/null || fail "docker compose plugin is required"
}

assert_services_healthy() {
  info "Checking docker compose health for: ${REQUIRED_SERVICES[*]}"
  local report
  report="$(docker compose ps --format '{{.Service}}={{.Health}}={{.State}}')"
  echo "$report" | tee artifacts/verify/compose-ps.txt
  local svc health state line
  for svc in "${REQUIRED_SERVICES[@]}"; do
    line="$(echo "$report" | grep "^${svc}=" || true)"
    [[ -n "$line" ]] || fail "service '$svc' not found in docker compose ps"
    health="$(echo "$line" | cut -d= -f2)"
    state="$(echo "$line" | cut -d= -f3)"
    [[ "$state" == "running" ]] || fail "service '$svc' state=$state (expected running)"
    [[ "$health" == "healthy" ]] || fail "service '$svc' health=$health (expected healthy)"
  done
  pass "all required services healthy"
}

require_host_tools

info "1) Docker Compose config"
docker compose config -q
pass "compose config"

info "2) Build & start stack (clean volumes — no host volume reuse)"
docker compose down -v --remove-orphans
docker compose build
docker compose up -d
pass "compose up"

info "3) Wait for HTTP readiness then assert compose health"
# ~4.5 minutes max (90 * 3s) — enough for cold image builds on CI
for i in $(seq 1 90); do
  if curl -sf http://localhost:8000/api/health >/dev/null \
    && curl -sf http://localhost:3000/ >/dev/null \
    && curl -sf http://localhost:5000/health >/dev/null; then
    break
  fi
  sleep 3
  if [[ $i -eq 90 ]]; then
    docker compose ps -a | tee artifacts/verify/compose-ps-timeout.txt || true
    docker compose logs --no-color --tail=80 | tee artifacts/verify/logs-timeout.txt || true
    fail "services did not become HTTP-ready"
  fi
done
# Give worker heartbeat a moment after process start
sleep 5
assert_services_healthy

info "4) Alembic"
docker compose exec -T backend alembic current | tee artifacts/verify/alembic.txt
pass "alembic"

info "5) Backend lint + unit tests"
docker compose exec -T backend ruff check app tests
docker compose exec -T backend pytest -q
pass "backend lint/tests"

info "6) Frontend lint/typecheck/test (Node container)"
docker run --rm \
  -v "$ROOT/frontend:/app" \
  -w /app \
  "$NODE_IMAGE" \
  sh -c "npm ci && npm run lint && npm run typecheck && npm run test"
pass "frontend lint/typecheck/test"

info "7) Placeholder / forbidden TODO scan"
set +e
FOUND=$(grep -RIn --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=playwright-report --exclude-dir=artifacts --exclude='verify.sh' \
  -e 'TODO(mvp-block)' -e 'Coming soon' -e 'mockApi' -e 'FAKE_DATA' \
  backend frontend e2e docs)
GREP_RC=$?
set -e
if [[ $GREP_RC -eq 0 ]]; then
  echo "$FOUND"
  fail "forbidden placeholders found"
elif [[ $GREP_RC -ne 1 ]]; then
  fail "placeholder grep failed with code $GREP_RC"
fi
set +e
FOUND=$(grep -RIn --exclude-dir=node_modules --exclude-dir=dist \
  -e '\bKubernetes\b' -e '\bNamespace\b' -e '\bPod\b' frontend/src)
GREP_RC=$?
set -e
if [[ $GREP_RC -eq 0 ]]; then
  echo "$FOUND"
  fail "infra jargon found in frontend"
elif [[ $GREP_RC -ne 1 ]]; then
  fail "jargon grep failed with code $GREP_RC"
fi
pass "placeholder scan"

info "8) API flow: upload → train → register → predict"
PROJECT=$(curl -sf -X POST http://localhost:8000/api/projects \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-$(date +%s)\",\"description\":\"verify\"}")
PID=$(echo "$PROJECT" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
DS=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/datasets" \
  -F "file=@samples/iris.csv;type=text/csv")
DID=$(echo "$DS" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
JOB=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-job\",\"dataset_id\":$DID,\"target_column\":\"target\",\"hyperparameters\":{\"n_estimators\":30}}")
JID=$(echo "$JOB" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')

for i in $(seq 1 90); do
  STATUS=$(curl -sf "http://localhost:8000/api/jobs/$JID" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then
    curl -sf "http://localhost:8000/api/jobs/$JID" | tee artifacts/verify/job-failed.json
    fail "training job failed"
  fi
  sleep 2
  if [[ $i -eq 90 ]]; then fail "training timed out"; fi
done
JOB_JSON=$(curl -sf "http://localhost:8000/api/jobs/$JID")
RUN_ID=$(echo "$JOB_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["mlflow_run_id"])')
[[ -n "$RUN_ID" && "$RUN_ID" != "None" ]] || fail "missing mlflow run id"
pass "training + mlflow run $RUN_ID"

REG=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/models/register" \
  -H 'Content-Type: application/json' \
  -d "{\"run_id\":\"$RUN_ID\",\"model_name\":\"classifier\"}")
MNAME=$(echo "$REG" | json_get 'import sys,json; print(json.load(sys.stdin)["name"])')
MVER=$(echo "$REG" | json_get 'import sys,json; print(json.load(sys.stdin)["version"])')
pass "registry $MNAME v$MVER"

EP=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/endpoints" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-ep\",\"model_name\":\"$MNAME\",\"model_version\":\"$MVER\"}")
EID=$(echo "$EP" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
PRED=$(curl -sf -X POST "http://localhost:8000/api/endpoints/$EID/predict" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
echo "$PRED" | tee artifacts/verify/predict.json
echo "$PRED" | json_get 'import sys,json; d=json.load(sys.stdin); assert "predictions" in d and len(d["predictions"])==1'
pass "inference"

info "9) Playwright E2E (official Playwright container)"
docker run --rm --network host \
  -v "$ROOT:/work" \
  -w /work \
  -e E2E_BASE_URL=http://localhost:3000 \
  -e HOME=/tmp \
  -e CI=true \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npm ci && npx playwright test'
pass "playwright"

assert_services_healthy

info "All verification checks passed."
echo "OK" > artifacts/verify/RESULT.txt
