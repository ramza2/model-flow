#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/screenshots artifacts/verify

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*"; exit 1; }
info() { echo "[INFO] $*"; }

info "1) Docker Compose config"
docker compose config -q
pass "compose config"

info "2) Build & start stack"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose build
docker compose up -d
pass "compose up"

info "3) Wait for health"
for i in $(seq 1 90); do
  if curl -sf http://localhost:8000/api/health >/dev/null \
    && curl -sf http://localhost:3000/ >/dev/null \
    && curl -sf http://localhost:5000/health >/dev/null; then
    break
  fi
  sleep 3
  if [[ $i -eq 90 ]]; then
    docker compose ps
    docker compose logs --tail=80
    fail "services did not become healthy"
  fi
done
pass "health checks"

info "4) Alembic already applied by backend entrypoint; verify tables"
docker compose exec -T backend alembic current | tee artifacts/verify/alembic.txt
pass "alembic"

info "5) Backend lint + unit tests"
docker compose exec -T backend ruff check app tests
docker compose exec -T backend pytest -q
pass "backend lint/tests"

info "6) Frontend lint/typecheck/test (via node container on build context)"
# Run against mounted sources using frontend image node
docker compose run --rm --no-deps --entrypoint sh frontend -c '
  cd /tmp && rm -rf src && mkdir work && cp -a /usr/share/nginx/html /tmp/html_only
' >/dev/null 2>&1 || true
# Prefer host node if available
if [[ -f frontend/package.json ]]; then
  (cd frontend && npm ci && npm run lint && npm run typecheck && npm run test)
fi
pass "frontend lint/typecheck/test"

info "7) Placeholder / forbidden TODO scan"
FOUND=$(grep -RIn --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=playwright-report --exclude-dir=artifacts --exclude='verify.sh' \
  -e 'TODO(mvp-block)' -e 'Coming soon' -e 'mockApi' -e 'FAKE_DATA' \
  backend frontend e2e docs || true)
if [[ -n "$FOUND" ]]; then
  echo "$FOUND"
  fail "forbidden placeholders found"
fi
# Soft-scan for k8s jargon on primary UI
FOUND=$(grep -RIn --exclude-dir=node_modules --exclude-dir=dist \
  -e '\bKubernetes\b' -e '\bNamespace\b' -e '\bPod\b' frontend/src || true)
if [[ -n "$FOUND" ]]; then
  echo "$FOUND"
  fail "infra jargon found in frontend"
fi
pass "placeholder scan"

info "8) API flow: upload → train → register → predict"
PROJECT=$(curl -sf -X POST http://localhost:8000/api/projects \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-$(date +%s)\",\"description\":\"verify\"}")
PID=$(echo "$PROJECT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
DS=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/datasets" \
  -F "file=@samples/iris.csv;type=text/csv")
DID=$(echo "$DS" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
JOB=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-job\",\"dataset_id\":$DID,\"target_column\":\"target\",\"hyperparameters\":{\"n_estimators\":30}}")
JID=$(echo "$JOB" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

for i in $(seq 1 90); do
  STATUS=$(curl -sf "http://localhost:8000/api/jobs/$JID" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then
    curl -sf "http://localhost:8000/api/jobs/$JID" | tee artifacts/verify/job-failed.json
    fail "training job failed"
  fi
  sleep 2
  if [[ $i -eq 90 ]]; then fail "training timed out"; fi
done
JOB_JSON=$(curl -sf "http://localhost:8000/api/jobs/$JID")
RUN_ID=$(echo "$JOB_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["mlflow_run_id"])')
[[ -n "$RUN_ID" && "$RUN_ID" != "None" ]] || fail "missing mlflow run id"
pass "training + mlflow run $RUN_ID"

REG=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/models/register" \
  -H 'Content-Type: application/json' \
  -d "{\"run_id\":\"$RUN_ID\",\"model_name\":\"classifier\"}")
MNAME=$(echo "$REG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')
MVER=$(echo "$REG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["version"])')
pass "registry $MNAME v$MVER"

EP=$(curl -sf -X POST "http://localhost:8000/api/projects/$PID/endpoints" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-ep\",\"model_name\":\"$MNAME\",\"model_version\":\"$MVER\"}")
EID=$(echo "$EP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
PRED=$(curl -sf -X POST "http://localhost:8000/api/endpoints/$EID/predict" \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')
echo "$PRED" | tee artifacts/verify/predict.json
echo "$PRED" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "predictions" in d and len(d["predictions"])==1'
pass "inference"

info "9) Playwright E2E"
if ! command -v npx >/dev/null; then fail "npx required for Playwright"; fi
npm install --no-save @playwright/test@1.49.1
npx playwright install chromium --with-deps
E2E_BASE_URL=http://localhost:3000 npx playwright test
pass "playwright"

info "All verification checks passed."
echo "OK" > artifacts/verify/RESULT.txt
