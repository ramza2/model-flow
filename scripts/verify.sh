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
# npm 11+ for audit only (bulk advisory API). Keep NODE_IMAGE on 22.17 for lint/test.
NODE_AUDIT_IMAGE="node:24.8-alpine"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"
PYTHON_IMAGE="python:3.11-slim"
REQUIRED_SERVICES=(frontend backend worker postgres mlflow minio)

VERIFY_EXIT=0
VERIFY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
USER_ENV_FILE="$ROOT/.env"
USER_ENV_EXISTED=0
USER_ENV_SHA=""
VERIFY_ENV_FILE=""
VERIFY_STACK_STARTED=0

# Host ports for the isolated verification Compose project (same values as CI).
VERIFY_POSTGRES_HOST_PORT=15432
VERIFY_SOURCE_POSTGRES_HOST_PORT=15433
VERIFY_MINIO_API_HOST_PORT=19000
VERIFY_MINIO_CONSOLE_HOST_PORT=19001
VERIFY_MLFLOW_HOST_PORT=15000
VERIFY_BACKEND_HOST_PORT=18000
VERIFY_FRONTEND_HOST_PORT=13000

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

cleanup_verify_stack() {
  # Tear down only the isolated verification project and its dedicated volumes.
  if [[ -z "${MODELFLOW_COMPOSE_PROJECT_NAME:-}" ]]; then
    return 0
  fi
  if [[ -z "${MODELFLOW_ENV_FILE:-}" || ! -f "${MODELFLOW_ENV_FILE}" ]]; then
    return 0
  fi
  info "Stopping isolated verification stack (${MODELFLOW_COMPOSE_PROJECT_NAME})"
  modelflow_compose --profile source down -v --remove-orphans || true
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
    echo "compose_project_name=${MODELFLOW_COMPOSE_PROJECT_NAME:-}"
    echo "verify_stack_started=${VERIFY_STACK_STARTED}"
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
  cleanup_verify_stack || true
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

# Capture the caller's .env checksum (if any) and never rewrite or source it into
# the verification stack. Verification uses an isolated Compose project, dedicated
# host ports, and temporary credentials so the developer stack is left untouched.
if [[ -f "$USER_ENV_FILE" ]]; then
  USER_ENV_EXISTED=1
  USER_ENV_SHA="$(sha256_file "$USER_ENV_FILE")"
  info "Preserving existing project .env (sha256=${USER_ENV_SHA}); developer stack will not be stopped"
else
  info "No project .env present; verification will not create one"
fi

export MODELFLOW_COMPOSE_PROJECT_NAME="${MODELFLOW_COMPOSE_PROJECT_NAME:-$MODELFLOW_VERIFY_COMPOSE_PROJECT}"
info "Verification Compose project: ${MODELFLOW_COMPOSE_PROJECT_NAME}"

export POSTGRES_HOST_PORT="$VERIFY_POSTGRES_HOST_PORT"
export SOURCE_POSTGRES_HOST_PORT="$VERIFY_SOURCE_POSTGRES_HOST_PORT"
export MINIO_API_HOST_PORT="$VERIFY_MINIO_API_HOST_PORT"
export MINIO_CONSOLE_HOST_PORT="$VERIFY_MINIO_CONSOLE_HOST_PORT"
export MLFLOW_HOST_PORT="$VERIFY_MLFLOW_HOST_PORT"
export BACKEND_HOST_PORT="$VERIFY_BACKEND_HOST_PORT"
export FRONTEND_HOST_PORT="$VERIFY_FRONTEND_HOST_PORT"

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

info "0c) MSYS Docker path helper unit checks"
chmod +x ./scripts/test-lib-msys.sh
./scripts/test-lib-msys.sh
pass "MSYS Docker path helper unit checks"

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

info "2) Build & start isolated verification stack (clean verification volumes only)"
modelflow_compose --profile source down -v --remove-orphans
modelflow_compose build
modelflow_compose --profile source up -d
VERIFY_STACK_STARTED=1
pass "compose up (${MODELFLOW_COMPOSE_PROJECT_NAME})"

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

info "8a) Service API Key external inference"
SVC_KEY_JSON=$(api -X POST "$API_BASE/projects/$PID/service-api-keys" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-erp-$RUN_TAG\",\"endpoint_id\":$EID}")
SVC_KEY_ID=$(echo "$SVC_KEY_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
SVC_KEY_PREFIX=$(echo "$SVC_KEY_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["key_prefix"])')
SVC_PLAINTEXT=$(echo "$SVC_KEY_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["key"])')
[[ "$SVC_PLAINTEXT" == mfk_* ]] || fail "service key plaintext missing from create response"
[[ "$SVC_KEY_PREFIX" == mfk_* ]] || fail "service key prefix missing"
echo "$SVC_KEY_JSON" | json_get 'import sys,json; d=json.load(sys.stdin); assert "key_hash" not in d'

SVC_LIST=$(api "$API_BASE/projects/$PID/service-api-keys")
echo "$SVC_LIST" | json_get \
  'import sys,json; rows=json.load(sys.stdin); assert rows; assert all("key" not in r and "key_hash" not in r for r in rows)'
# Ensure list JSON does not embed the one-time plaintext (prefix alone is fine).
if echo "$SVC_LIST" | grep -F -- "$SVC_PLAINTEXT" >/dev/null; then
  fail "service key plaintext leaked into list response"
fi

EXT_PRED=$(curl -fsS -X POST "$API_BASE/inference/endpoints/$EID/predict" \
  -H "Authorization: Bearer $SVC_PLAINTEXT" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
echo "$EXT_PRED" | tee artifacts/verify/external-predict.json
echo "$EXT_PRED" | json_get 'import sys,json; d=json.load(sys.stdin); assert len(d["predictions"])==1 and "model_uri" not in d'

# JWT must not work on external inference
JWT_EXT_CODE=$(curl -sS -o /tmp/verify-jwt-ext.json -w '%{http_code}' \
  -X POST "$API_BASE/inference/endpoints/$EID/predict" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
[[ "$JWT_EXT_CODE" == "401" ]] || fail "user JWT unexpectedly authorized external inference ($JWT_EXT_CODE)"

# Service key must not work on internal prediction
KEY_INT_CODE=$(curl -sS -o /tmp/verify-key-int.json -w '%{http_code}' \
  -X POST "$API_BASE/endpoints/$EID/predict" \
  -H "Authorization: Bearer $SVC_PLAINTEXT" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
[[ "$KEY_INT_CODE" == "401" ]] || fail "service key unexpectedly authorized internal prediction ($KEY_INT_CODE)"

api -X POST "$API_BASE/projects/$PID/service-api-keys/$SVC_KEY_ID/revoke" >/dev/null
REVOKED_CODE=$(curl -sS -o /tmp/verify-key-revoked.json -w '%{http_code}' \
  -X POST "$API_BASE/inference/endpoints/$EID/predict" \
  -H "Authorization: Bearer $SVC_PLAINTEXT" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
[[ "$REVOKED_CODE" == "401" ]] || fail "revoked service key still authorized ($REVOKED_CODE)"
# Clear plaintext from shell environment before continuing
unset SVC_PLAINTEXT
pass "service API key create/list/external predict/auth boundary/revoke"
echo "prefix=${SVC_KEY_PREFIX}" > artifacts/verify/service-api-key-prefix.txt

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

info "8b2) Multi-output regression training"
MO_DS=$(api -X POST "$API_BASE/projects/$PID/datasets" \
  -F "name=verify-multi-output-$RUN_TAG" \
  -F "file=@samples/multi_output_regression.csv;type=text/csv")
MO_DID=$(echo "$MO_DS" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
MO_DVID=$(echo "$MO_DS" | json_get 'import sys,json; print(json.load(sys.stdin)["version"]["id"])')
MO_JOB=$(api -X POST "$API_BASE/projects/$PID/jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-multi-output\",\"dataset_id\":$MO_DID,\"dataset_version_id\":$MO_DVID,\"target_columns\":[\"power_usage\",\"cooling_load\"],\"problem_type\":\"regression\",\"algorithm\":\"ridge\",\"feature_columns\":[\"temperature\",\"pressure\",\"wind\"],\"hyperparameters\":{}}")
MO_JID=$(echo "$MO_JOB" | json_get 'import sys,json; print(json.load(sys.stdin)["id"])')
for i in $(seq 1 120); do
  MO_JOB_JSON=$(api "$API_BASE/projects/$PID/jobs/$MO_JID")
  STATUS=$(echo "$MO_JOB_JSON" | json_get 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" || "$STATUS" == "cancelled" ]]; then
    echo "$MO_JOB_JSON" | tee artifacts/verify/multi-output-job-failed.json
    fail "multi-output regression training entered terminal status $STATUS"
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then fail "multi-output regression training timed out"; fi
done
echo "$MO_JOB_JSON" \
  | json_get 'import sys,json; d=json.load(sys.stdin); assert d["target_columns"] == ["power_usage", "cooling_load"]; assert "rmse" in d["metrics"]'
pass "multi-output regression training (ridge)"

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

# npm registry occasionally returns 503 / non-audit JSON. Retry so transient
# registry outages do not fail an otherwise green verification gate.
# Use NODE_AUDIT_IMAGE (npm 11+) so audit hits the bulk advisory endpoint; the
# legacy /security/audits/quick endpoint was retired and returns 4xx.
npm_audit_report_valid() {
  local report="$1"
  [[ -s "$report" ]] || return 1
  # Prefer host Python so validation does not compete with docker under load.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(data.get("vulnerabilities"), dict) else 1)' \
      "$report" >/dev/null 2>&1
    return $?
  fi
  docker run --rm -v "$report:/report.json:ro" "$PYTHON_IMAGE" \
    python -c 'import json,sys; data=json.load(open("/report.json")); sys.exit(0 if isinstance(data.get("vulnerabilities"), dict) else 1)' \
    >/dev/null 2>&1
}

run_npm_audit_with_retry() {
  local workdir="$1"
  local outfile="$2"
  local errfile="$3"
  local label="$4"
  # Install once, then retry only the audit call. Bulk advisory API may 503 or
  # hang; each attempt is bounded by a host-side docker timeout (hard cap).
  local attempts=5
  local delay=10
  local attempt=1
  local rc=2
  # GHA runners often need >90s for advisories/bulk; keep a hard cap so hangs
  # cannot stall the full gate indefinitely.
  local audit_timeout_sec=360
  local audit_kill_grace_sec=15
  local ci_rc=0
  local audit_workdir=""
  local cname=""

  cleanup_audit_workdir() {
    local dir="$1"
    [[ -n "$dir" && -d "$dir" ]] || return 0
    # node_modules is root-owned from the container; delete via the same image.
    docker run --rm -v "$dir:/app" "$NODE_AUDIT_IMAGE" \
      sh -c 'rm -rf /app/node_modules' >/dev/null 2>&1 || true
    rm -rf "$dir" >/dev/null 2>&1 || true
  }

  # Isolated tree avoids host node_modules / platform noise; only package manifests.
  audit_workdir="$(mktemp -d "$ROOT/artifacts/verify/npm-audit-${label}.XXXXXX")"
  cp "$workdir/package.json" "$workdir/package-lock.json" "$audit_workdir/"

  info "${label}: npm ci (once) for audit"
  set +e
  docker run --rm -v "$audit_workdir:/app" -w /app "$NODE_AUDIT_IMAGE" \
    sh -c 'npm ci --silent' \
    >/dev/null \
    2>"${errfile}.npm-ci"
  ci_rc=$?
  set +e
  if (( ci_rc != 0 )); then
    info "${label}: npm ci failed (exit=${ci_rc}); see ${errfile}.npm-ci"
    cleanup_audit_workdir "$audit_workdir"
    return 2
  fi

  while (( attempt <= attempts )); do
    # Keep non-zero npm audit exits (vulns found => 1) from aborting retries.
    # Host timeout + named container so a hung registry call cannot stall CI;
    # docker rm -f reaps the container if the client is killed first.
    # Do not lower npm fetch-timeout below defaults: GHA bulk advisory latency
    # regularly exceeds 90s and would otherwise fail closed as "network timeout".
    cname="mf-npm-audit-${label}-${attempt}-$$"
    set +e
    # Brace group hides bash "Killed" noise when timeout SIGKILLs the client.
    {
      timeout -k "${audit_kill_grace_sec}" "${audit_timeout_sec}" \
        docker run --name "$cname" --rm \
          -v "$audit_workdir:/app" -w /app "$NODE_AUDIT_IMAGE" \
          sh -c 'npm audit --json' \
          > "$outfile" \
          2> "$errfile"
    } 2>/dev/null
    rc=$?
    docker rm -f "$cname" >/dev/null 2>&1 || true
    set +e
    if npm_audit_report_valid "$outfile"; then
      if (( attempt > 1 )); then
        info "${label}: npm audit succeeded after ${attempt} attempts"
      fi
      # Valid report is authoritative; normalize timeout/OOM exits to 0/1 for the gate.
      if (( rc != 0 && rc != 1 )); then
        rc=1
      fi
      cleanup_audit_workdir "$audit_workdir"
      return "$rc"
    fi
    if (( attempt == attempts )); then
      info "${label}: npm audit produced invalid/unavailable report (attempt ${attempt}/${attempts})"
      break
    fi
    info "${label}: npm audit produced invalid/unavailable report (attempt ${attempt}/${attempts}); retrying in ${delay}s"
    sleep "$delay"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
  cleanup_audit_workdir "$audit_workdir"
  return 2
}

info "8e) Dependency security gate (High/Critical)"
set +e
modelflow_compose exec -T backend sh -c \
  'python -m pip install -q pip-audit && pip-audit -r requirements.txt --progress-spinner off --format json' \
  > artifacts/verify/pip-audit.json \
  2> artifacts/verify/pip-audit.stderr.txt
PIP_AUDIT_RC=$?
set -e
set +e
run_npm_audit_with_retry "$ROOT/frontend" \
  artifacts/verify/npm-audit.json \
  artifacts/verify/npm-audit.stderr.txt \
  "frontend"
NPM_AUDIT_RC=$?
run_npm_audit_with_retry "$ROOT" \
  artifacts/verify/npm-audit-e2e.json \
  artifacts/verify/npm-audit-e2e.stderr.txt \
  "e2e"
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
  fail "npm audit failed to run after retries (exit=$NPM_AUDIT_RC); see artifacts/verify/npm-audit.stderr.txt"
fi
if [[ "$E2E_NPM_AUDIT_RC" -ne 0 && "$E2E_NPM_AUDIT_RC" -ne 1 ]]; then
  fail "E2E npm audit failed to run after retries (exit=$E2E_NPM_AUDIT_RC); see artifacts/verify/npm-audit-e2e.stderr.txt"
fi
if ! npm_audit_report_valid artifacts/verify/npm-audit.json; then
  fail "frontend npm audit report is still invalid after retries"
fi
if ! npm_audit_report_valid artifacts/verify/npm-audit-e2e.json; then
  fail "E2E npm audit report is still invalid after retries"
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
  -e E2E_API_BASE="$API_BASE" \
  -e E2E_ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  -e E2E_SOURCE_POSTGRES_DB="${SOURCE_POSTGRES_DB:-}" \
  -e E2E_SOURCE_POSTGRES_USER="${SOURCE_POSTGRES_USER:-}" \
  -e E2E_SOURCE_POSTGRES_PASSWORD="${SOURCE_POSTGRES_PASSWORD:-}" \
  -e HOME=/tmp \
  -e CI=true \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npm ci && npx playwright test'
pass "playwright"

assert_services_healthy

info "All verification checks passed."
echo "OK" > artifacts/verify/RESULT.txt
