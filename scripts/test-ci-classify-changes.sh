#!/usr/bin/env bash
# Unit checks for PR Fast Gate change classification / aggregate helpers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
chmod +x scripts/ci-classify-changes.sh scripts/ci-pr-fast-gate-aggregate.sh

pass() { echo "[PASS] ci-classify: $*"; }
fail() { echo "[FAIL] ci-classify: $*" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/modelflow-ci-classify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

git init -q "$TMP/repo"
cd "$TMP/repo"
git config user.email "ci-classify@example.com"
git config user.name "CI Classify"
echo base >README.md
mkdir -p docs backend/app frontend/src scripts .github/workflows
echo doc >docs/a.md
echo py >backend/app/x.py
echo req >backend/requirements.txt
echo from >backend/Dockerfile
echo ts >frontend/src/x.ts
echo lock >frontend/package-lock.json
echo sh >scripts/x.sh
echo yml >.github/workflows/ci.yml
echo compose >docker-compose.yml
git add -A
git commit -q -m base
BASE="$(git rev-parse HEAD)"

classify() {
  local out
  rm -f "$TMP/out"
  out="$(
    cd "$TMP/repo"
    GITHUB_OUTPUT="$TMP/out" "$ROOT/scripts/ci-classify-changes.sh" "$1" "$2"
  )"
  echo "$out"
  # shellcheck disable=SC1090
  source "$TMP/out"
}

# --- docs-only ---
echo more >>docs/a.md
echo more >>README.md
git add -A && git commit -q -m docs
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "true" ]] || fail "docs-only expected true"
[[ "${backend}" == "false" && "${frontend}" == "false" && "${infra}" == "false" ]] \
  || fail "docs-only should not enable product/infra gates"
pass "docs-only classification"

# --- backend-only ---
git reset -q --hard "$BASE"
echo change >backend/app/x.py
git add -A && git commit -q -m backend
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${backend}" == "true" && "${frontend}" == "false" && "${infra}" == "false" ]] \
  || fail "backend-only mismatch (docs=${docs_only} backend=${backend} frontend=${frontend} infra=${infra})"
pass "backend-only classification"

# --- frontend-only ---
git reset -q --hard "$BASE"
echo change >frontend/src/x.ts
git add -A && git commit -q -m frontend
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${backend}" == "false" && "${frontend}" == "true" && "${infra}" == "false" ]] \
  || fail "frontend-only mismatch"
pass "frontend-only classification"

# --- infra-only ---
git reset -q --hard "$BASE"
echo change >docker-compose.yml
echo change >scripts/x.sh
git add -A && git commit -q -m infra
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${infra}" == "true" && "${backend}" == "false" && "${frontend}" == "false" ]] \
  || fail "infra-only mismatch"
pass "infra-only classification"

# --- mixed backend + frontend ---
git reset -q --hard "$BASE"
echo change >backend/app/x.py
echo change >frontend/src/x.ts
git add -A && git commit -q -m mixed
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${backend}" == "true" && "${frontend}" == "true" && "${infra}" == "false" ]] \
  || fail "mixed mismatch"
pass "mixed backend+frontend classification"

# --- overlap: backend Dockerfile → backend + infra ---
git reset -q --hard "$BASE"
echo change >backend/Dockerfile
git add -A && git commit -q -m backend-dockerfile
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${backend}" == "true" && "${infra}" == "true" && "${frontend}" == "false" ]] \
  || fail "backend/Dockerfile overlap mismatch (docs=${docs_only} backend=${backend} frontend=${frontend} infra=${infra})"
pass "backend/Dockerfile enables backend+infra"

# --- overlap: backend requirements → backend + infra ---
git reset -q --hard "$BASE"
echo change >backend/requirements.txt
git add -A && git commit -q -m backend-requirements
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${backend}" == "true" && "${infra}" == "true" && "${frontend}" == "false" ]] \
  || fail "backend/requirements.txt overlap mismatch"
pass "backend/requirements.txt enables backend+infra"

# --- overlap: frontend lockfile → frontend + infra ---
git reset -q --hard "$BASE"
echo change >frontend/package-lock.json
git add -A && git commit -q -m frontend-lock
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${frontend}" == "true" && "${infra}" == "true" && "${backend}" == "false" ]] \
  || fail "frontend/package-lock.json overlap mismatch"
pass "frontend/package-lock.json enables frontend+infra"

# --- .github is never docs-only even for markdown ---
git reset -q --hard "$BASE"
mkdir -p .github
echo '# note' >.github/PULL_REQUEST_TEMPLATE.md
git add -A && git commit -q -m gh-md
HEAD="$(git rev-parse HEAD)"
classify "$BASE" "$HEAD" >/dev/null
[[ "${docs_only}" == "false" && "${infra}" == "true" ]] \
  || fail ".github markdown must be infra, not docs-only"
pass ".github markdown is infra"

# --- aggregate: docs-only success ---
CLASSIFY_RESULT=success DOCS_ONLY=true DOCS_CHECK_RESULT=success \
  BACKEND_NEEDED=false BACKEND_RESULT=skipped \
  FRONTEND_NEEDED=false FRONTEND_RESULT=skipped \
  INFRA_NEEDED=false INFRA_RESULT=skipped \
  "$ROOT/scripts/ci-pr-fast-gate-aggregate.sh" >/dev/null \
  || fail "aggregate docs-only should pass"
pass "aggregate docs-only success"

# --- aggregate: backend failure propagates ---
if CLASSIFY_RESULT=success DOCS_ONLY=false DOCS_CHECK_RESULT=skipped \
  BACKEND_NEEDED=true BACKEND_RESULT=failure \
  FRONTEND_NEEDED=false FRONTEND_RESULT=skipped \
  INFRA_NEEDED=false INFRA_RESULT=skipped \
  "$ROOT/scripts/ci-pr-fast-gate-aggregate.sh" >/dev/null 2>&1; then
  fail "aggregate should fail when backend-fast fails"
fi
pass "aggregate failure propagation"

# --- aggregate: cancelled propagates ---
if CLASSIFY_RESULT=success DOCS_ONLY=false DOCS_CHECK_RESULT=skipped \
  BACKEND_NEEDED=true BACKEND_RESULT=cancelled \
  FRONTEND_NEEDED=true FRONTEND_RESULT=success \
  INFRA_NEEDED=false INFRA_RESULT=skipped \
  "$ROOT/scripts/ci-pr-fast-gate-aggregate.sh" >/dev/null 2>&1; then
  fail "aggregate should fail when a needed job is cancelled"
fi
pass "aggregate cancelled propagation"

# --- aggregate: mixed success ---
CLASSIFY_RESULT=success DOCS_ONLY=false DOCS_CHECK_RESULT=skipped \
  BACKEND_NEEDED=true BACKEND_RESULT=success \
  FRONTEND_NEEDED=true FRONTEND_RESULT=success \
  INFRA_NEEDED=true INFRA_RESULT=success \
  "$ROOT/scripts/ci-pr-fast-gate-aggregate.sh" >/dev/null \
  || fail "aggregate mixed success should pass"
pass "aggregate mixed success"

pass "all classification/aggregate unit checks"
