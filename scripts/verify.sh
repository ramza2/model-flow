#!/usr/bin/env bash
# ModelFlow verification gate.
# Host prerequisites: Docker, Docker Compose plugin, curl, bash.
# Node.js/npm/npx and host Python are NOT required.
# Designed for both local and non-interactive CI (GitHub Actions).
# Never rewrites the caller's project .env; verification credentials live in a temp env file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"
mkdir -p artifacts/screenshots artifacts/verify

NODE_IMAGE="node:22.17-alpine"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"
PYTHON_IMAGE="python:3.11-slim"
REQUIRED_SERVICES=(frontend backend worker postgres mlflow minio)

VERIFY_EXIT=0
VERIFY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
USER_ENV_FILE="$ROOT/.env"
USER_ENV_EXISTED=0
USER_ENV_SHA=""
VERIFY_ENV_FILE=""

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*"; exit 1; }
info() { echo "[INFO] $*"; }

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    docker run --rm -v "$path:/file:ro" "$PYTHON_IMAGE" \
      python -c 'import hashlib,pathlib; print(hashlib.sha256(pathlib.Path("/file").read_bytes()).hexdigest())'
  fi
}

assert_user_env_unchanged() {
  # Return status only — may run from EXIT trap (do not call fail/exit here).
  if [[ "$USER_ENV_EXISTED" -eq 1 ]]; then
    if [[ ! -f "$USER_ENV_FILE" ]]; then
      echo "[FAIL] user .env was deleted during verification" >&2
      return 1
    fi
    local after
    after="$(sha256_file "$USER_ENV_FILE")"
    echo "$USER_ENV_SHA" > artifacts/verify/user-env-sha-before.txt
    echo "$after" > artifacts/verify/user-env-sha-after.txt
    if [[ "$after" != "$USER_ENV_SHA" ]]; then
      echo "[FAIL] user .env checksum changed during verification (before=$USER_ENV_SHA after=$after)" >&2
      return 1
    fi
    pass "user .env checksum unchanged"
  else
    if [[ -e "$USER_ENV_FILE" ]]; then
      echo "[FAIL] verification created a project .env but none existed before" >&2
      return 1
    fi
    pass "no project .env existed; none was created"
  fi
  return 0
}

json_get() {
  local code="$1"
  docker run --rm -i -e ADMIN_EMAIL="${ADMIN_EMAIL:-}" "$PYTHON_IMAGE" python -c "$code"
}

api() {
  curl -fsS -H "Authorization: Bearer $TOKEN" "$@"
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
    echo "user_env_existed=${USER_ENV_EXISTED}"
    echo "user_env_sha_before=${USER_ENV_SHA}"
    echo "verify_env_file=${VERIFY_ENV_FILE}"
    echo "frontend_host_port=${FRONTEND_HOST_PORT:-}"
    echo "backend_host_port=${BACKEND_HOST_PORT:-}"
  } > artifacts/verify/meta.txt

  {
    echo "=== docker compose ps -a ==="
    modelflow_compose ps -a 2>&1 || true
    echo
    echo "=== docker compose ps (format) ==="
    modelflow_compose ps -a --format '{{.Service}}={{.Health}}={{.State}}' 2>&1 || true
  } | tee artifacts/verify/compose-ps-final.txt >/dev/null || true

  if [[ "$ec" -ne 0 ]]; then
    info "Collecting service logs after failure (exit=${ec})"
    for svc in postgres minio mlflow backend worker frontend minio-init; do
      modelflow_compose logs --no-color --tail=200 "$svc" \
        > "artifacts/verify/logs-${svc}.txt" 2>&1 || \
        echo "(no logs for ${svc})" > "artifacts/verify/logs-${svc}.txt"
    done
    modelflow_compose logs --no-color --tail=400 \
      > artifacts/verify/logs-all.txt 2>&1 || true
    echo "FAIL" > artifacts/verify/RESULT.txt
  fi
}

on_exit() {
  local ec=$?
  trap - EXIT
  VERIFY_EXIT="$ec"
  collect_diagnostics "$ec" || true
  if [[ -n "${VERIFY_ENV_FILE:-}" && -e "${VERIFY_ENV_FILE}" ]]; then
    rm -f "$VERIFY_ENV_FILE"
  fi
  if ! assert_user_env_unchanged; then
    ec=1
  fi
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
  report="$(modelflow_compose ps --format '{{.Service}}={{.Health}}={{.State}}')"
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

# Capture the caller's .env (if any) and never rewrite it. Host ports from that file
# (or from the process environment / CI) are preserved into a temporary verify env.
if [[ -f "$USER_ENV_FILE" ]]; then
  USER_ENV_EXISTED=1
  USER_ENV_SHA="$(sha256_file "$USER_ENV_FILE")"
  info "Preserving existing project .env (sha256=${USER_ENV_SHA})"
  set -a
  # shellcheck disable=SC1091
  source "$USER_ENV_FILE"
  set +a
  info "Stopping stack with current project env before verification"
  docker compose --profile source down -v --remove-orphans || true
else
  info "No project .env present; verification will not create one"
fi

POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
SOURCE_POSTGRES_HOST_PORT="${SOURCE_POSTGRES_HOST_PORT:-5433}"
MINIO_API_HOST_PORT="${MINIO_API_HOST_PORT:-9000}"
MINIO_CONSOLE_HOST_PORT="${MINIO_CONSOLE_HOST_PORT:-9001}"
MLFLOW_HOST_PORT="${MLFLOW_HOST_PORT:-5000}"
BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-8000}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-3000}"
export POSTGRES_HOST_PORT SOURCE_POSTGRES_HOST_PORT
export MINIO_API_HOST_PORT MINIO_CONSOLE_HOST_PORT
export MLFLOW_HOST_PORT BACKEND_HOST_PORT FRONTEND_HOST_PORT

# Nested forced-fail run: proves EXIT cleanup never mutates the caller's .env.
# Skipped when we *are* the forced-fail child (MODELFLOW_VERIFY_FORCE_FAIL=1).
if [[ "${MODELFLOW_VERIFY_FORCE_FAIL:-}" != "1" ]]; then
  info "0a) Forced-fail .env preservation check"
  set +e
  MODELFLOW_VERIFY_FORCE_FAIL=1 "$ROOT/scripts/verify.sh"
  FORCE_RC=$?
  set -e
  [[ "$FORCE_RC" -ne 0 ]] || fail "expected forced-fail verify to exit non-zero"
  if [[ "$USER_ENV_EXISTED" -eq 1 ]]; then
    FORCE_AFTER="$(sha256_file "$USER_ENV_FILE")"
    [[ "$FORCE_AFTER" == "$USER_ENV_SHA" ]] \
      || fail "forced-fail verify mutated .env (before=$USER_ENV_SHA after=$FORCE_AFTER)"
    echo "$USER_ENV_SHA" > artifacts/verify/user-env-sha-force-before.txt
    echo "$FORCE_AFTER" > artifacts/verify/user-env-sha-force-after.txt
  elif [[ -e "$USER_ENV_FILE" ]]; then
    fail "forced-fail verify created a project .env"
  fi
  pass "forced-fail verify preserves project .env"
fi

VERIFY_ENV_FILE="$(mktemp "$ROOT/artifacts/verify/verify.env.XXXXXX")"
chmod 600 "$VERIFY_ENV_FILE"
export MODELFLOW_ENV_FILE="$VERIFY_ENV_FILE"

info "Generating isolated verification credentials in a temporary env file"
./scripts/init-env.sh --non-interactive-test --output "$VERIFY_ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$VERIFY_ENV_FILE"
set +a
: "${MODELFLOW_BOOTSTRAP_ADMIN_EMAIL:?Missing bootstrap administrator email in verify env}"
: "${MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD:?Missing bootstrap administrator password in verify env}"
ADMIN_EMAIL="$MODELFLOW_BOOTSTRAP_ADMIN_EMAIL"
ADMIN_PASSWORD="$MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD"
export E2E_ADMIN_EMAIL="$ADMIN_EMAIL"
export E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD"

API_BASE="http://localhost:${BACKEND_HOST_PORT}/api/v1"
FRONTEND_BASE_URL="http://localhost:${FRONTEND_HOST_PORT}"
MLFLOW_BASE_URL="http://localhost:${MLFLOW_HOST_PORT}"
export E2E_BASE_URL="$FRONTEND_BASE_URL"
export API_BASE

case ",${CORS_ORIGINS}," in
  *,http://localhost:${FRONTEND_HOST_PORT},*) ;;
  *) fail "CORS_ORIGINS must include http://localhost:${FRONTEND_HOST_PORT}" ;;
esac
pass "CORS_ORIGINS includes frontend host port ${FRONTEND_HOST_PORT}"

# Used by scripts/test-env-preservation.sh to assert EXIT trap never mutates .env.
if [[ "${MODELFLOW_VERIFY_FORCE_FAIL:-}" == "1" ]]; then
  fail "forced failure for env-preservation test (MODELFLOW_VERIFY_FORCE_FAIL=1)"
fi

info "0b) Env preservation unit checks"
./scripts/test-env-preservation.sh --unit-only
pass "env preservation unit checks"

info "1) Docker Compose config (active verify ports)"
modelflow_compose config -q
pass "compose config"

info "1b) Custom host-port compose config fixture"
./scripts/test-compose-host-ports.sh
pass "custom host ports reflected in compose config"

info "1c) Default host-port compose config fixture"
(
  set -a
  # shellcheck disable=SC1090
  source "$VERIFY_ENV_FILE"
  set +a
  export POSTGRES_HOST_PORT=5432 SOURCE_POSTGRES_HOST_PORT=5433
  export MINIO_API_HOST_PORT=9000 MINIO_CONSOLE_HOST_PORT=9001
  export MLFLOW_HOST_PORT=5000 BACKEND_HOST_PORT=8000 FRONTEND_HOST_PORT=3000
  DEFAULT_CONFIG="$(mktemp "$ROOT/artifacts/verify/default-ports.XXXXXX.yml")"
  docker compose --profile source config >"$DEFAULT_CONFIG"
  docker run --rm \
    -v "$DEFAULT_CONFIG:/config.yml:ro" \
    -v "$ROOT/scripts/check-compose-host-ports.py:/check.py:ro" \
    -e POSTGRES_HOST_PORT=5432 \
    -e SOURCE_POSTGRES_HOST_PORT=5433 \
    -e MINIO_API_HOST_PORT=9000 \
    -e MINIO_CONSOLE_HOST_PORT=9001 \
    -e MLFLOW_HOST_PORT=5000 \
    -e BACKEND_HOST_PORT=8000 \
    -e FRONTEND_HOST_PORT=3000 \
    "$PYTHON_IMAGE" python /check.py /config.yml
  rm -f "$DEFAULT_CONFIG"
)
pass "default host ports reflected in compose config"

info "Host ports for this verification run: UI=${FRONTEND_HOST_PORT} API=${BACKEND_HOST_PORT} MLflow=${MLFLOW_HOST_PORT}"

info "2) Build & start stack (clean volumes — no host volume reuse)"
modelflow_compose --profile source down -v --remove-orphans
modelflow_compose build
modelflow_compose up -d
pass "compose up"

info "3) Wait for HTTP readiness and bootstrap administrator"
# 10 minutes max — enough for cold images, migrations, and password hashing on CI.
LOGIN_PAYLOAD="{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
LOGIN=""
for i in $(seq 1 120); do
  if curl -sf "$API_BASE/health" >/dev/null \
    && curl -sf "$FRONTEND_BASE_URL/" >/dev/null \
    && curl -sf "${MLFLOW_BASE_URL}/health" >/dev/null; then
    LOGIN="$(curl -sf -X POST "$API_BASE/auth/login" \
      -H 'Content-Type: application/json' \
      -d "$LOGIN_PAYLOAD" || true)"
  fi
  if [[ "$LOGIN" == *'"access_token"'* ]]; then
    break
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then
    modelflow_compose ps -a | tee artifacts/verify/compose-ps-timeout.txt || true
    modelflow_compose logs --no-color --tail=80 | tee artifacts/verify/logs-timeout.txt || true
    fail "services or bootstrap administrator did not become ready"
  fi
done
TOKEN="$(echo "$LOGIN" | json_get 'import sys,json; print(json.load(sys.stdin)["access_token"])')"
api "$API_BASE/auth/me" \
  | json_get 'import os,sys,json; d=json.load(sys.stdin); assert d["email"] == os.environ["ADMIN_EMAIL"]'
pass "bootstrap administrator login"

# Give the worker heartbeat a moment after process start.
sleep 5
assert_services_healthy

info "4) Alembic"
modelflow_compose exec -T backend alembic current | tee artifacts/verify/alembic.txt
pass "alembic"

info "5) Backend lint + unit tests"
modelflow_compose exec -T backend ruff check app tests
modelflow_compose exec -T backend pytest -q
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

info "8) Authenticated API v1 release flow"
RUN_TAG="$(date +%s)-$$"

USER=$(api -X POST "$API_BASE/users" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"verify-$RUN_TAG@example.com\",\"password\":\"$ADMIN_PASSWORD\",\"full_name\":\"Verify User\"}")
echo "$USER" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["email"].startswith("verify-")'
pass "user administration"

PROJECT=$(api -X POST "$API_BASE/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-$RUN_TAG\",\"description\":\"ModelFlow v1 verification\"}")
PID=$(echo "$PROJECT" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')

DS=$(api -X POST "$API_BASE/projects/$PID/datasets" \
  -F "name=verify-iris-$RUN_TAG" \
  -F "file=@samples/iris.csv;type=text/csv")
DID=$(echo "$DS" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
DVID=$(echo "$DS" | json_get 'import sys,json; print(json.load(sys.stdin)["version"]["id"])')

DS2=$(api -X POST "$API_BASE/projects/$PID/datasets" \
  -F "name=verify-iris-$RUN_TAG" \
  -F "file=@samples/iris.csv;type=text/csv")
DVID2=$(echo "$DS2" | json_get 'import sys,json; print(json.load(sys.stdin)["version"]["id"])')
[[ "$DVID" != "$DVID2" ]] || fail "dataset version upload did not create a new version"
pass "project and versioned dataset upload"

RULE=$(api -X POST "$API_BASE/projects/$PID/quality-rules" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"target-required\",\"dataset_id\":$DID,\"rules\":[{\"type\":\"not_null\",\"column\":\"target\",\"severity\":\"fail\"}],\"block_training_on_fail\":true}")
RULE_ID=$(echo "$RULE" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
CHECK=$(api -X POST "$API_BASE/projects/$PID/dataset-versions/$DVID/quality-checks" \
  -H 'Content-Type: application/json' \
  -d "{\"quality_rule_id\":$RULE_ID}")
echo "$CHECK" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["result"] == "PASS"'

SPLIT=$(api -X POST "$API_BASE/projects/$PID/dataset-versions/$DVID/splits" \
  -H 'Content-Type: application/json' \
  -d '{"name":"verify-split","train_ratio":0.7,"val_ratio":0.15,"test_ratio":0.15,"random_seed":42}')
SPLIT_ID=$(echo "$SPLIT" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
pass "quality rule, check, and dataset split"

JOB=$(api -X POST "$API_BASE/projects/$PID/jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-classifier\",\"dataset_id\":$DID,\"dataset_version_id\":$DVID,\"split_id\":$SPLIT_ID,\"target_column\":\"target\",\"problem_type\":\"classification\",\"algorithm\":\"random_forest\",\"feature_columns\":[\"sepal length (cm)\",\"sepal width (cm)\",\"petal length (cm)\",\"petal width (cm)\"],\"hyperparameters\":{\"n_estimators\":30}}")
JID=$(echo "$JOB" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')

for i in $(seq 1 120); do
  JOB_JSON=$(api "$API_BASE/projects/$PID/jobs/$JID")
  STATUS=$(echo "$JOB_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" || "$STATUS" == "cancelled" ]]; then
    echo "$JOB_JSON" | tee artifacts/verify/job-failed.json
    fail "training job entered terminal status $STATUS"
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then fail "training timed out after 10 minutes"; fi
done
RUN_ID=$(echo "$JOB_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["mlflow_run_id"])')
[[ -n "$RUN_ID" && "$RUN_ID" != "None" ]] || fail "missing mlflow run id"
pass "classification training + MLflow run $RUN_ID"

REG=$(api -X POST "$API_BASE/projects/$PID/models/register" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"classifier\",\"training_job_id\":$JID,\"metadata\":{\"feature_schema\":[\"sepal length (cm)\",\"sepal width (cm)\",\"petal length (cm)\",\"petal width (cm)\"]}}")
MVID=$(echo "$REG" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "$REG" \
  | json_get 'import sys,json; d=json.load(sys.stdin); g=d["gate_results"]; assert d["gates_passed"] and g["passed"] and g["computed_by"] == "server"'

api -X POST "$API_BASE/projects/$PID/models/$MVID/request-approval" \
  -H 'Content-Type: application/json' \
  -d '{"comment":"verify gate passed"}' >/dev/null
APPROVED=$(api -X POST "$API_BASE/projects/$PID/models/$MVID/approve" \
  -H 'Content-Type: application/json' \
  -d '{"comment":"verified"}')
echo "$APPROVED" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["lifecycle"] == "APPROVED"'
PROMOTED=$(api -X POST "$API_BASE/projects/$PID/models/$MVID/promote-production")
echo "$PROMOTED" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["lifecycle"] == "PRODUCTION"'
pass "model registration, approval, and production promotion"

EP=$(api -X POST "$API_BASE/projects/$PID/endpoints" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-endpoint\",\"model_version_id\":$MVID}")
EID=$(echo "$EP" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
PRED=$(api -X POST "$API_BASE/endpoints/$EID/predict" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
echo "$PRED" | tee artifacts/verify/predict.json
echo "$PRED" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert len(d["predictions"]) == 1'
pass "endpoint deployment and realtime inference"

BATCH=$(api -X POST "$API_BASE/projects/$PID/batch-jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"dataset_version_id\":$DVID,\"endpoint_id\":$EID,\"result_format\":\"csv\"}")
BATCH_ID=$(echo "$BATCH" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
for i in $(seq 1 120); do
  BATCH_JSON=$(api "$API_BASE/projects/$PID/batch-jobs/$BATCH_ID")
  STATUS=$(echo "$BATCH_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then
    echo "$BATCH_JSON" | tee artifacts/verify/batch-failed.json
    fail "batch inference failed"
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then fail "batch inference timed out after 10 minutes"; fi
done
echo "$BATCH_JSON" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["row_count"] == 150 and d["result_object_key"]'
api "$API_BASE/projects/$PID/batch-jobs/$BATCH_ID/download?stream=true" \
  > artifacts/verify/batch-result.csv
pass "batch inference and result download"

DRIFT=$(api -X POST "$API_BASE/projects/$PID/drift-runs" \
  -H 'Content-Type: application/json' \
  -d "{\"reference_version_id\":$DVID,\"current_version_id\":$DVID2,\"endpoint_id\":$EID,\"thresholds\":{\"watch\":0.1,\"critical\":0.25}}")
DRIFT_ID=$(echo "$DRIFT" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
for i in $(seq 1 120); do
  DRIFT_JSON=$(api "$API_BASE/projects/$PID/drift-runs/$DRIFT_ID")
  STATUS=$(echo "$DRIFT_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then
    echo "$DRIFT_JSON" | tee artifacts/verify/drift-failed.json
    fail "drift run failed"
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then fail "drift run timed out after 10 minutes"; fi
done
echo "$DRIFT_JSON" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["overall_status"] in {"ok","watch","critical"} and d["results"]["columns"]'

AUDIT=$(api "$API_BASE/projects/$PID/audit?limit=100")
echo "$AUDIT" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert len(d) >= 10'
echo "$AUDIT" > artifacts/verify/audit.json
pass "drift monitoring and audit log listing"

info "8b) Regression training"
REG_DS=$(api -X POST "$API_BASE/projects/$PID/datasets" \
  -F "name=verify-regression-$RUN_TAG" \
  -F "file=@samples/regression.csv;type=text/csv")
REG_DID=$(echo "$REG_DS" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
REG_DVID=$(echo "$REG_DS" | json_get 'import sys,json; print(json.load(sys.stdin)["version"]["id"])')
REG_JOB=$(api -X POST "$API_BASE/projects/$PID/jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-regressor\",\"dataset_id\":$REG_DID,\"dataset_version_id\":$REG_DVID,\"target_column\":\"target_value\",\"problem_type\":\"regression\",\"algorithm\":\"ridge\",\"feature_columns\":[\"sepal length (cm)\",\"sepal width (cm)\",\"petal width (cm)\"],\"hyperparameters\":{}}")
REG_JID=$(echo "$REG_JOB" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
for i in $(seq 1 120); do
  REG_JOB_JSON=$(api "$API_BASE/projects/$PID/jobs/$REG_JID")
  STATUS=$(echo "$REG_JOB_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" || "$STATUS" == "cancelled" ]]; then
    echo "$REG_JOB_JSON" | tee artifacts/verify/regression-job-failed.json
    fail "regression training entered terminal status $STATUS"
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then fail "regression training timed out"; fi
done
echo "$REG_JOB_JSON" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert "rmse" in d["metrics"] or "r2" in d["metrics"]'
pass "regression training (ridge)"

info "8c) Visual pipeline publish + execute"
PIPE_BODY=$(DVID="$DVID" docker run --rm -i -e DVID="$DVID" "$PYTHON_IMAGE" python - <<'PY'
import json, os
dvid = int(os.environ["DVID"])
graph = {
  "nodes": [
    {"id": "load", "type": "dataset_load", "data": {"node_type": "dataset_load", "config": {"dataset_version_id": dvid}}},
    {"id": "quality", "type": "quality_check", "data": {"node_type": "quality_check", "config": {"rules": [{"type": "not_null", "column": "target"}], "block_on_fail": True}}},
    {"id": "split", "type": "split", "data": {"node_type": "split", "config": {"train_ratio": 0.7, "val_ratio": 0.15, "test_ratio": 0.15, "random_seed": 42}}},
    {"id": "prep", "type": "preprocessing", "data": {"node_type": "preprocessing", "config": {"scale": True}}},
    {"id": "train", "type": "training", "data": {"node_type": "training", "config": {"target_column": "target", "problem_type": "classification", "algorithm": "logistic_regression", "feature_columns": ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)"], "hyperparameters": {"max_iter": 200}}}},
    {"id": "eval", "type": "evaluation", "data": {"node_type": "evaluation", "config": {"metric": "accuracy", "minimum": 0.5}}},
    {"id": "register", "type": "model_registration", "data": {"node_type": "model_registration", "config": {"name": "pipeline-classifier"}}},
  ],
  "edges": [
    {"id": "e1", "source": "load", "target": "quality", "targetHandle": "data"},
    {"id": "e2", "source": "quality", "target": "split", "targetHandle": "data"},
    {"id": "e3", "source": "split", "target": "prep", "targetHandle": "data"},
    {"id": "e4", "source": "prep", "target": "train", "targetHandle": "data"},
    {"id": "e5", "source": "train", "target": "eval", "targetHandle": "model"},
    {"id": "e6", "source": "eval", "target": "register", "targetHandle": "model"},
  ],
}
print(json.dumps({"name": "verify-pipeline", "description": "e2e", "graph": graph}))
PY
)
[[ -n "$PIPE_BODY" ]] || fail "failed to build pipeline request body"
PIPE=$(api -X POST "$API_BASE/projects/$PID/pipelines" \
  -H 'Content-Type: application/json' \
  -d "$PIPE_BODY")
PIPE_ID=$(echo "$PIPE" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
api -X POST "$API_BASE/projects/$PID/pipelines/$PIPE_ID/publish" >/dev/null
PIPE_RUN=$(api -X POST "$API_BASE/projects/$PID/pipelines/$PIPE_ID/run" \
  -H 'Content-Type: application/json' \
  -d '{"parameters":{},"fail_policy":"stop"}')
PIPE_RUN_ID=$(echo "$PIPE_RUN" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
for i in $(seq 1 120); do
  PIPE_RUN_JSON=$(api "$API_BASE/projects/$PID/pipeline-runs/$PIPE_RUN_ID")
  STATUS=$(echo "$PIPE_RUN_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" || "$STATUS" == "cancelled" ]]; then
    echo "$PIPE_RUN_JSON" | tee artifacts/verify/pipeline-failed.json
    fail "pipeline run entered terminal status $STATUS"
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then fail "pipeline run timed out"; fi
done
echo "$PIPE_RUN_JSON" \
  | json_get 'import sys,json; d=json.load(sys.stdin); states=d.get("node_states") or {}; assert "register" in states or d["status"]=="succeeded"'
echo "$PIPE_RUN_JSON" > artifacts/verify/pipeline-run.json
pass "visual pipeline publish + execute"

info "8d) PostgreSQL + MinIO backup/restore round-trip"
ROUNDTRIP_ENDPOINT_ID="$EID" MODELFLOW_ENV_FILE="$VERIFY_ENV_FILE" \
  ./scripts/verify-backup-roundtrip.sh \
  | tee artifacts/verify/backup-roundtrip.log
pass "backup/restore round-trip"

info "8e) Dependency security gate (High/Critical)"
set +e
modelflow_compose exec -T backend sh -c \
  'python -m pip install -q pip-audit && pip-audit -r requirements.txt --progress-spinner off --format json' \
  > artifacts/verify/pip-audit.json \
  2> artifacts/verify/pip-audit.stderr.txt
PIP_AUDIT_RC=$?
docker run --rm -v "$ROOT/frontend:/app" -w /app "$NODE_IMAGE" \
  sh -c 'npm ci --silent >/dev/null && npm audit --json' \
  > artifacts/verify/npm-audit.json \
  2> artifacts/verify/npm-audit.stderr.txt
NPM_AUDIT_RC=$?
docker run --rm -v "$ROOT:/app" -w /app "$NODE_IMAGE" \
  sh -c 'npm ci --silent >/dev/null && npm audit --json' \
  > artifacts/verify/npm-audit-e2e.json \
  2> artifacts/verify/npm-audit-e2e.stderr.txt
E2E_NPM_AUDIT_RC=$?
set -e
{
  echo "pip_audit_rc=${PIP_AUDIT_RC}"
  echo "npm_audit_rc=${NPM_AUDIT_RC}"
  echo "e2e_npm_audit_rc=${E2E_NPM_AUDIT_RC}"
} > artifacts/verify/security-scan.txt
if [[ "$PIP_AUDIT_RC" -ne 0 && "$PIP_AUDIT_RC" -ne 1 ]]; then
  fail "pip-audit failed to run (exit=$PIP_AUDIT_RC)"
fi
if [[ "$NPM_AUDIT_RC" -ne 0 && "$NPM_AUDIT_RC" -ne 1 ]]; then
  fail "npm audit failed to run (exit=$NPM_AUDIT_RC)"
fi
if [[ "$E2E_NPM_AUDIT_RC" -ne 0 && "$E2E_NPM_AUDIT_RC" -ne 1 ]]; then
  fail "E2E npm audit failed to run (exit=$E2E_NPM_AUDIT_RC)"
fi
set +e
docker run --rm \
  -v "$ROOT:/work:ro" \
  -w /work \
  "$PYTHON_IMAGE" \
  python scripts/check-security-audits.py \
    --pip artifacts/verify/pip-audit.json \
    --npm artifacts/verify/npm-audit.json \
    --npm artifacts/verify/npm-audit-e2e.json \
    --allowlist security/allowlist.json \
  > artifacts/verify/security-gate.json
SECURITY_GATE_RC=$?
set -e
if [[ "$SECURITY_GATE_RC" -ne 0 ]]; then
  fail "dependency security gate rejected findings or invalid scan output (exit=$SECURITY_GATE_RC)"
fi
pass "no unallowlisted High/Critical dependency vulnerabilities"

info "9) Playwright E2E (official Playwright container)"
docker run --rm --network host \
  -v "$ROOT:/work" \
  -w /work \
  -e E2E_BASE_URL="$FRONTEND_BASE_URL" \
  -e E2E_ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  -e HOME=/tmp \
  -e CI=true \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npm ci && npx playwright test'
pass "playwright"

assert_services_healthy

info "All verification checks passed."
echo "OK" > artifacts/verify/RESULT.txt
