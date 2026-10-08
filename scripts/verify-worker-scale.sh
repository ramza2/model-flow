#!/usr/bin/env bash
# Narrow Phase 8-B Compose scale-out check: two worker replicas with distinct
# identities, fresh heartbeats, and profile=general. Intended to run against an
# already-up ModelFlow Compose project with MODELFLOW_ENV_FILE / compose project
# already configured (see scripts/verify.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

mkdir -p artifacts/verify

info() { echo "[worker-scale] $*"; }
fail() { echo "[worker-scale] FAIL: $*" >&2; exit 1; }
pass() { echo "[worker-scale] PASS: $*"; }

if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
  if ! modelflow_load_env "$ROOT"; then
    fail "POSTGRES_USER/POSTGRES_DB not set and env file missing"
  fi
fi

info "Scaling workers to 2"
modelflow_compose up -d --scale worker=2 worker >/dev/null

info "Waiting for two healthy worker containers"
ready=0
for _ in $(seq 1 60); do
  report="$(modelflow_compose ps --format '{{.Service}}={{.Health}}={{.State}}' | grep '^worker=' || true)"
  healthy=0
  total=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    total=$((total + 1))
    health="$(echo "$line" | cut -d= -f2)"
    state="$(echo "$line" | cut -d= -f3)"
    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      healthy=$((healthy + 1))
    fi
  done <<< "$report"
  if [[ "$total" -ge 2 && "$healthy" -ge 2 ]]; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" -ne 1 ]]; then
  modelflow_compose ps worker || true
  modelflow_compose logs --no-color --tail=80 worker || true
  fail "expected two healthy worker replicas"
fi
pass "two healthy worker replicas"

info "Checking distinct worker heartbeats (profile=general)"
sql=$(
  cat <<'SQL'
SELECT worker_id,
       status_json::json->>'profile' AS profile,
       EXTRACT(EPOCH FROM (NOW() - last_seen_at)) AS age_s
FROM worker_heartbeats
WHERE last_seen_at > NOW() - INTERVAL '60 seconds'
  AND COALESCE(status_json::json->>'profile', '') = 'general'
ORDER BY worker_id;
SQL
)
rows="$(modelflow_compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
       -v ON_ERROR_STOP=1 -At -F '|' -c "$sql")"
count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$count" -lt 2 ]]; then
  echo "$rows"
  fail "expected >=2 fresh general-profile heartbeats, got ${count}"
fi
ids="$(printf '%s\n' "$rows" | cut -d'|' -f1 | sort -u)"
uniq_count="$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$uniq_count" -lt 2 ]]; then
  echo "$rows"
  fail "worker heartbeat IDs were not distinct under --scale worker=2"
fi
pass "distinct worker IDs with fresh general heartbeats"
printf '%s\n' "$rows" | tee artifacts/verify/worker-scale-heartbeats.txt >/dev/null

info "Scaling workers back to 1"
modelflow_compose up -d --scale worker=1 worker >/dev/null

# Wait until a single worker is healthy again before returning to the main gate.
for _ in $(seq 1 45); do
  report="$(modelflow_compose ps --format '{{.Service}}={{.Health}}={{.State}}' | grep '^worker=' || true)"
  healthy=0
  total=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    total=$((total + 1))
    health="$(echo "$line" | cut -d= -f2)"
    state="$(echo "$line" | cut -d= -f3)"
    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      healthy=$((healthy + 1))
    fi
  done <<< "$report"
  if [[ "$total" -eq 1 && "$healthy" -eq 1 ]]; then
    pass "worker scale-out check complete"
    exit 0
  fi
  sleep 2
done
fail "failed to return to a single healthy worker"
