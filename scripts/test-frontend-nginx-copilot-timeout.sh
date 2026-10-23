#!/usr/bin/env bash
# Assert frontend/nginx.conf extends proxy_read_timeout only for Copilot draft/patch.
# Uses a mock upstream (no LLM). Requires: bash, docker, curl, python3 (in container).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NGINX_IMAGE="${NGINX_IMAGE:-nginx:1.27.5-alpine}"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"
NGINX_CONF="$ROOT/frontend/nginx.conf"
MOCK_PY="$ROOT/scripts/mock-slow-backend.py"

NETWORK="mf-nginx-copilot-$$"
BACKEND_NAME="mf-nginx-backend-$$"
NGINX_NAME="mf-nginx-proxy-$$"
ARTIFACT_DIR="$ROOT/artifacts/verify"
mkdir -p "$ARTIFACT_DIR"
HOST_PORT_FILE="$(mktemp "$ARTIFACT_DIR/nginx-copilot-port.XXXXXX")"

fail() {
  echo "[FAIL] nginx copilot timeout: $*" >&2
  exit 1
}

pass() {
  echo "[PASS] nginx copilot timeout: $*"
}

cleanup() {
  docker rm -f "$NGINX_NAME" "$BACKEND_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$HOST_PORT_FILE"
}
trap cleanup EXIT

[[ -f "$NGINX_CONF" ]] || fail "missing $NGINX_CONF"
[[ -f "$MOCK_PY" ]] || fail "missing $MOCK_PY"

# --- Static config assertions (matching + scoped timeout) ---
docker run --rm \
  -v "$NGINX_CONF:/etc/nginx/conf.d/default.conf:ro" \
  "$NGINX_IMAGE" nginx -t >/dev/null \
  || fail "nginx -t failed for frontend/nginx.conf"
pass "nginx -t"

CONF_DUMP="$(docker run --rm \
  -v "$NGINX_CONF:/etc/nginx/conf.d/default.conf:ro" \
  "$NGINX_IMAGE" nginx -T 2>/dev/null)"

echo "$CONF_DUMP" | grep -qE 'location ~ \^/api/v1/projects/\[0-9\]\+/pipeline-copilot/\(draft\|patch\)\$' \
  || fail "Copilot draft/patch regex location missing from nginx -T"
echo "$CONF_DUMP" | grep -A6 'pipeline-copilot/(draft|patch)' | grep -q 'proxy_read_timeout 180s;' \
  || fail "proxy_read_timeout 180s missing on Copilot location"
echo "$CONF_DUMP" | grep -A8 'location /api/' | grep -q 'proxy_read_timeout' \
  && fail "general /api/ location unexpectedly sets proxy_read_timeout" || true
# Confirm general /api/ block has no proxy_read_timeout by extracting that block only.
API_BLOCK="$(echo "$CONF_DUMP" | awk '/location \/api\//,/^[[:space:]]*}/')"
echo "$API_BLOCK" | grep -q 'proxy_pass http://modelflow_backend;' || fail "general /api/ proxy_pass missing"
echo "$API_BLOCK" | grep -q 'proxy_read_timeout' && fail "general /api/ must keep default timeout" || true
pass "Copilot location scoped; general /api/ unchanged"

# --- Runtime: mock backend + nginx on Docker DNS ---
docker network create "$NETWORK" >/dev/null

docker run -d --name "$BACKEND_NAME" --network "$NETWORK" --network-alias backend \
  -v "$MOCK_PY:/mock.py:ro" \
  "$PYTHON_IMAGE" python /mock.py >/dev/null \
  || fail "failed to start mock backend"

docker run -d --name "$NGINX_NAME" --network "$NETWORK" -p 127.0.0.1::80 \
  -v "$NGINX_CONF:/etc/nginx/conf.d/default.conf:ro" \
  "$NGINX_IMAGE" >/dev/null \
  || fail "failed to start nginx"

# Map published host port
HOST_PORT="$(docker port "$NGINX_NAME" 80/tcp | head -n1 | awk -F: '{print $NF}')"
[[ -n "$HOST_PORT" ]] || fail "could not resolve published nginx port"
echo "$HOST_PORT" >"$HOST_PORT_FILE"
BASE="http://127.0.0.1:${HOST_PORT}"

# Wait for nginx + upstream
for _ in $(seq 1 30); do
  if curl -sf "$BASE/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -sf "$BASE/api/v1/health" >/dev/null || fail "fast /api/ proxy not ready"

# Fast general API still works; query string echoed by mock.
FAST_BODY="$(curl -sf "$BASE/api/v1/projects/3/pipelines?x=1")"
echo "$FAST_BODY" | grep -q '"kind": "fast"' || fail "fast general API body unexpected: $FAST_BODY"
echo "$FAST_BODY" | grep -q '"x": "1"' || fail "query string not forwarded on general /api/: $FAST_BODY"
pass "general /api/ fast path + query string"

# Parallel: Copilot draft (65s) must succeed; generic slow /api/ (65s) must 504 at default 60s.
DRAFT_OUT="$(mktemp "$ARTIFACT_DIR/nginx-draft.XXXXXX")"
GENERIC_OUT="$(mktemp "$ARTIFACT_DIR/nginx-generic.XXXXXX")"
DRAFT_CODE_FILE="$(mktemp "$ARTIFACT_DIR/nginx-draft-code.XXXXXX")"
GENERIC_CODE_FILE="$(mktemp "$ARTIFACT_DIR/nginx-generic-code.XXXXXX")"

START_TS="$(date +%s)"
curl -sS -o "$DRAFT_OUT" -w '%{http_code}' \
  -X POST "$BASE/api/v1/projects/3/pipeline-copilot/draft?delay=65&trace=draft" \
  >"$DRAFT_CODE_FILE" &
DRAFT_PID=$!
curl -sS -o "$GENERIC_OUT" -w '%{http_code}' \
  -X POST "$BASE/api/v1/projects/3/slow-generic?delay=65&trace=generic" \
  >"$GENERIC_CODE_FILE" &
GENERIC_PID=$!

wait "$DRAFT_PID" || true
wait "$GENERIC_PID" || true
END_TS="$(date +%s)"
ELAPSED=$((END_TS - START_TS))

DRAFT_CODE="$(cat "$DRAFT_CODE_FILE")"
GENERIC_CODE="$(cat "$GENERIC_CODE_FILE")"
DRAFT_BODY="$(cat "$DRAFT_OUT")"
GENERIC_BODY="$(cat "$GENERIC_OUT")"

[[ "$DRAFT_CODE" == "200" ]] || fail "Copilot draft expected HTTP 200 after >60s, got $DRAFT_CODE body=$DRAFT_BODY"
echo "$DRAFT_BODY" | grep -q '"kind": "copilot"' || fail "draft body missing copilot kind: $DRAFT_BODY"
echo "$DRAFT_BODY" | grep -q '"trace": "draft"' || fail "draft query string not forwarded: $DRAFT_BODY"
[[ "$ELAPSED" -ge 60 ]] || fail "draft returned too quickly (${ELAPSED}s); expected ~65s upstream wait"
pass "Copilot draft proxied after ${ELAPSED}s (HTTP 200)"

[[ "$GENERIC_CODE" == "504" ]] || fail "slow general /api/ expected HTTP 504 at default timeout, got $GENERIC_CODE body=$GENERIC_BODY"
pass "general /api/ still defaults to ~60s (HTTP 504)"

# Patch path also uses the extended timeout (shorter 61s is enough once draft proved 180s).
PATCH_CODE="$(curl -sS -o "$ARTIFACT_DIR/nginx-patch-body.json" -w '%{http_code}' \
  -X POST "$BASE/api/v1/projects/42/pipeline-copilot/patch?delay=61&trace=patch")"
PATCH_BODY="$(cat "$ARTIFACT_DIR/nginx-patch-body.json")"
[[ "$PATCH_CODE" == "200" ]] || fail "Copilot patch expected HTTP 200 after >60s, got $PATCH_CODE body=$PATCH_BODY"
echo "$PATCH_BODY" | grep -q '"kind": "copilot"' || fail "patch body missing copilot kind: $PATCH_BODY"
echo "$PATCH_BODY" | grep -q '"trace": "patch"' || fail "patch query string not forwarded: $PATCH_BODY"
pass "Copilot patch proxied after >60s (HTTP 200)"

# Non-numeric project id must NOT use the Copilot regex (falls through to /api/ default timeout).
# Use a short delay so we only assert matching, not another 60s wait: path should hit fast handler.
NON_NUM_BODY="$(curl -sf -X POST "$BASE/api/v1/projects/abc/pipeline-copilot/draft")"
echo "$NON_NUM_BODY" | grep -q '"kind": "fast"' || fail "non-numeric project id should not match Copilot location: $NON_NUM_BODY"
pass "non-numeric project id does not match Copilot regex"

pass "all frontend nginx Copilot timeout checks"
