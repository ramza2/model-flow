#!/usr/bin/env bash
# Classify changed files between two git SHAs for PR Fast Gate routing.
#
# Usage:
#   scripts/ci-classify-changes.sh <base_sha> <head_sha>
#
# Prints a human-readable summary and, when GITHUB_OUTPUT is set, writes:
#   docs_only, backend, frontend, infra  (true|false)
#   changed_count
#
# Exit non-zero if the range is invalid or classification fails.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <base_sha> <head_sha>" >&2
  exit 2
fi

# Operate on the caller's git work tree (CI checkout or test fixture), not the
# script install path. Optional override: REPO_ROOT=/path/to/repo
if [[ -n "${REPO_ROOT:-}" ]]; then
  cd "${REPO_ROOT}"
fi

BASE_SHA="$1"
HEAD_SHA="$2"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not inside a git work tree (cwd=$(pwd))" >&2
  exit 1
fi

if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "base SHA is not a commit: ${BASE_SHA}" >&2
  exit 1
fi
if ! git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
  echo "head SHA is not a commit: ${HEAD_SHA}" >&2
  exit 1
fi

# Triple-dot: changes on HEAD since merge-base with BASE (PR file set).
mapfile -t CHANGED < <(git diff --name-only "${BASE_SHA}...${HEAD_SHA}" | sed '/^$/d' | sort -u)

docs_only="true"
backend="false"
frontend="false"
infra="false"

is_backend_path() {
  case "$1" in
    backend/*) return 0 ;;
  esac
  return 1
}

is_frontend_path() {
  case "$1" in
    frontend/*) return 0 ;;
  esac
  return 1
}

# Explicit infra/config paths — never docs-only.
is_infra_path() {
  case "$1" in
    .github/*|scripts/*|infra/*|samples/*) return 0 ;;
    docker-compose.yml|docker-compose.*.yml) return 0 ;;
    .env|.env.*|.env.example) return 0 ;;
    */Dockerfile|Dockerfile|*/Dockerfile.*) return 0 ;;
    *.yml|*.yaml) return 0 ;;
    package-lock.json|frontend/package-lock.json) return 0 ;;
    backend/requirements.txt|requirements.txt) return 0 ;;
    .cursor/*|.dockerignore|.gitignore|.gitattributes|Makefile|pyproject.toml) return 0 ;;
  esac
  return 1
}

# Markdown / docs trees that may qualify as docs-only when exclusive.
is_docs_path() {
  local path="$1"
  if is_infra_path "$path" || is_backend_path "$path" || is_frontend_path "$path"; then
    return 1
  fi
  case "$path" in
    docs/*) return 0 ;;
    README.md|CHANGELOG.md|CONTRIBUTING.md|LICENSE|LICENSE.md|NOTICE|SECURITY.md) return 0 ;;
    *.md) return 0 ;;
  esac
  return 1
}

if ((${#CHANGED[@]} == 0)); then
  echo "No file changes in ${BASE_SHA}...${HEAD_SHA}; treating as docs-only no-op."
  docs_only="true"
else
  for path in "${CHANGED[@]}"; do
    if is_backend_path "$path"; then
      backend="true"
      docs_only="false"
      continue
    fi
    if is_frontend_path "$path"; then
      frontend="true"
      docs_only="false"
      continue
    fi
    if is_infra_path "$path"; then
      infra="true"
      docs_only="false"
      continue
    fi
    if is_docs_path "$path"; then
      continue
    fi
    # Unknown non-docs path → lightweight infra gate.
    echo "Unclassified path treated as infra: ${path}"
    infra="true"
    docs_only="false"
  done
fi

# Mixed product changes should still exercise compose/script sanity when
# workflow or packaging files did not change, but docs-only stays pure.
# (No automatic infra bump for backend/frontend-only.)

echo "=== PR change classification ==="
echo "base: ${BASE_SHA}"
echo "head: ${HEAD_SHA}"
echo "changed_count: ${#CHANGED[@]}"
if ((${#CHANGED[@]} > 0)); then
  printf 'changed_files:\n'
  printf '  - %s\n' "${CHANGED[@]}"
fi
echo "docs_only: ${docs_only}"
echo "backend: ${backend}"
echo "frontend: ${frontend}"
echo "infra: ${infra}"
if [[ "${docs_only}" == "true" ]]; then
  echo "gate: docs-only lightweight (no Python/Node/Docker full stack)"
else
  echo "gate: PR Fast Gate (conditional backend/frontend/infra jobs)"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "docs_only=${docs_only}"
    echo "backend=${backend}"
    echo "frontend=${frontend}"
    echo "infra=${infra}"
    echo "changed_count=${#CHANGED[@]}"
  } >>"${GITHUB_OUTPUT}"
fi
