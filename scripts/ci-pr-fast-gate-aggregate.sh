#!/usr/bin/env bash
# Aggregate conditional PR Fast Gate job results into one required check.
#
# Environment (set by GitHub Actions):
#   CLASSIFY_RESULT, DOCS_ONLY, DOCS_CHECK_RESULT
#   BACKEND_NEEDED, BACKEND_RESULT
#   FRONTEND_NEEDED, FRONTEND_RESULT
#   INFRA_NEEDED, INFRA_RESULT
#
# Allowed outcomes for needed jobs: success
# Allowed outcomes for unneeded jobs: skipped (or success)
# Any failure/cancelled → exit 1
set -euo pipefail

need_success() {
  local label="$1"
  local result="$2"
  case "${result}" in
    success) return 0 ;;
    *)
      echo "[FAIL] PR fast gate: ${label} required success, got '${result}'" >&2
      return 1
      ;;
  esac
}

allow_skipped_or_success() {
  local label="$1"
  local result="$2"
  case "${result}" in
    success|skipped) return 0 ;;
    *)
      echo "[FAIL] PR fast gate: ${label} expected skipped/success, got '${result}'" >&2
      return 1
      ;;
  esac
}

: "${CLASSIFY_RESULT:?CLASSIFY_RESULT is required}"
: "${DOCS_ONLY:?DOCS_ONLY is required}"
: "${DOCS_CHECK_RESULT:?DOCS_CHECK_RESULT is required}"
: "${BACKEND_NEEDED:?BACKEND_NEEDED is required}"
: "${BACKEND_RESULT:?BACKEND_RESULT is required}"
: "${FRONTEND_NEEDED:?FRONTEND_NEEDED is required}"
: "${FRONTEND_RESULT:?FRONTEND_RESULT is required}"
: "${INFRA_NEEDED:?INFRA_NEEDED is required}"
: "${INFRA_RESULT:?INFRA_RESULT is required}"

echo "=== PR fast gate aggregate ==="
echo "classify=${CLASSIFY_RESULT} docs_only=${DOCS_ONLY}"
echo "docs-check=${DOCS_CHECK_RESULT}"
echo "backend needed=${BACKEND_NEEDED} result=${BACKEND_RESULT}"
echo "frontend needed=${FRONTEND_NEEDED} result=${FRONTEND_RESULT}"
echo "infra needed=${INFRA_NEEDED} result=${INFRA_RESULT}"

need_success "classify" "${CLASSIFY_RESULT}"

if [[ "${DOCS_ONLY}" == "true" ]]; then
  need_success "docs-check" "${DOCS_CHECK_RESULT}"
  allow_skipped_or_success "backend-fast" "${BACKEND_RESULT}"
  allow_skipped_or_success "frontend-fast" "${FRONTEND_RESULT}"
  allow_skipped_or_success "infra-fast" "${INFRA_RESULT}"
  echo "[PASS] PR fast gate (docs-only)"
  exit 0
fi

allow_skipped_or_success "docs-check" "${DOCS_CHECK_RESULT}"

if [[ "${BACKEND_NEEDED}" == "true" ]]; then
  need_success "backend-fast" "${BACKEND_RESULT}"
else
  allow_skipped_or_success "backend-fast" "${BACKEND_RESULT}"
fi

if [[ "${FRONTEND_NEEDED}" == "true" ]]; then
  need_success "frontend-fast" "${FRONTEND_RESULT}"
else
  allow_skipped_or_success "frontend-fast" "${FRONTEND_RESULT}"
fi

if [[ "${INFRA_NEEDED}" == "true" ]]; then
  need_success "infra-fast" "${INFRA_RESULT}"
else
  allow_skipped_or_success "infra-fast" "${INFRA_RESULT}"
fi

echo "[PASS] PR fast gate"
