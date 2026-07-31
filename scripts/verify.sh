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
API_BASE="http://localhost:8000/api/v1"

VERIFY_EXIT=0
VERIFY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*"; exit 1; }
info() { echo "[INFO] $*"; }

# Parse JSON from stdin inside a container (no host Python/Node required for scripting).
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

if [[ -f "$ROOT/.env" ]]; then
  info "Stopping stack before rotating verification credentials"
  docker compose --profile source down -v --remove-orphans || true
fi

info "Generating isolated verification credentials"
./scripts/init-env.sh --non-interactive-test --force
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a
: "${MODELFLOW_BOOTSTRAP_ADMIN_EMAIL:?Missing bootstrap administrator email in .env}"
: "${MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD:?Missing bootstrap administrator password in .env}"
ADMIN_EMAIL="$MODELFLOW_BOOTSTRAP_ADMIN_EMAIL"
ADMIN_PASSWORD="$MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD"
export E2E_ADMIN_EMAIL="$ADMIN_EMAIL"
export E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD"

info "1) Docker Compose config"
docker compose config -q
pass "compose config"

info "2) Build & start stack (clean volumes — no host volume reuse)"
docker compose --profile source down -v --remove-orphans
docker compose build
docker compose up -d
pass "compose up"

info "3) Wait for HTTP readiness and bootstrap administrator"
# 10 minutes max — enough for cold images, migrations, and password hashing on CI.
LOGIN_PAYLOAD="{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
LOGIN=""
for i in $(seq 1 120); do
  if curl -sf "$API_BASE/health" >/dev/null \
    && curl -sf http://localhost:3000/ >/dev/null \
    && curl -sf http://localhost:5000/health >/dev/null; then
    LOGIN="$(curl -sf -X POST "$API_BASE/auth/login" \
      -H 'Content-Type: application/json' \
      -d "$LOGIN_PAYLOAD" || true)"
  fi
  if [[ "$LOGIN" == *'"access_token"'* ]]; then
    break
  fi
  sleep 5
  if [[ $i -eq 120 ]]; then
    docker compose ps -a | tee artifacts/verify/compose-ps-timeout.txt || true
    docker compose logs --no-color --tail=80 | tee artifacts/verify/logs-timeout.txt || true
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
  -d '{"name":"target-required","rules":[{"type":"not_null","column":"target"}],"block_training_on_fail":true}')
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

info "8d) Backup smoke + soft dependency advisory scan"
BACKUP_ROOT="$ROOT/artifacts/verify/backup-smoke" ./scripts/backup.sh \
  | tee artifacts/verify/backup-smoke.log >/dev/null
ls artifacts/verify/backup-smoke/*/postgres/modelflow.dump >/dev/null
ls artifacts/verify/backup-smoke/*/postgres/mlflow.dump >/dev/null
pass "backup.sh smoke"
set +e
docker compose exec -T backend sh -c 'pip install -q pip-audit==2.7.3 && pip-audit -r requirements.txt --progress-spinner off' \
  > artifacts/verify/pip-audit.txt 2>&1
PIP_AUDIT_RC=$?
docker run --rm -v "$ROOT/frontend:/app" -w /app "$NODE_IMAGE" \
  sh -c 'npm ci --silent && npm audit --json' > artifacts/verify/npm-audit.json 2>/dev/null
NPM_AUDIT_RC=$?
set -e
{
  echo "pip_audit_rc=${PIP_AUDIT_RC}"
  echo "npm_audit_rc=${NPM_AUDIT_RC}"
} > artifacts/verify/security-scan.txt
# Advisory only — do not fail the gate on known transitive CVEs.
pass "soft dependency advisory scan (non-blocking)"

info "9) Playwright E2E (official Playwright container)"
docker run --rm --network host \
  -v "$ROOT:/work" \
  -w /work \
  -e E2E_BASE_URL=http://localhost:3000 \
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
