#!/usr/bin/env bash
# Shared helpers for scripts that may run against a non-default env file.
# shellcheck shell=bash

# Isolated Compose project used by scripts/verify.sh (never the developer stack).
MODELFLOW_VERIFY_COMPOSE_PROJECT="${MODELFLOW_VERIFY_COMPOSE_PROJECT:-modelflow-verify}"

modelflow_env_file() {
  local root="${1:-.}"
  if [[ -n "${MODELFLOW_ENV_FILE:-}" ]]; then
    printf '%s\n' "$MODELFLOW_ENV_FILE"
  else
    printf '%s\n' "$root/.env"
  fi
}

modelflow_load_env() {
  local root="${1:-.}"
  local env_file
  env_file="$(modelflow_env_file "$root")"
  if [[ ! -f "$env_file" ]]; then
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  return 0
}

# Match Docker Compose v2 default project naming for a checkout directory.
modelflow_default_compose_project() {
  local root="${1:-.}"
  local name
  name="$(basename "$(cd "$root" && pwd)")"
  name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g' | sed -E 's/^-+|-+$//g')"
  printf '%s' "$name"
}

modelflow_compose_volume_name() {
  local project="$1"
  local volume="$2"
  printf '%s_%s' "$project" "$volume"
}

modelflow_compose() {
  local project="${MODELFLOW_COMPOSE_PROJECT_NAME:-}"
  if [[ -n "${MODELFLOW_ENV_FILE:-}" ]]; then
    if [[ -n "$project" ]]; then
      docker compose -p "$project" --env-file "$MODELFLOW_ENV_FILE" "$@"
    else
      docker compose --env-file "$MODELFLOW_ENV_FILE" "$@"
    fi
  else
    if [[ -n "$project" ]]; then
      docker compose -p "$project" "$@"
    else
      docker compose "$@"
    fi
  fi
}

# True when running under Git Bash / MSYS / Cygwin on Windows.
modelflow_is_msys() {
  case "${OSTYPE:-}" in
    msys* | cygwin*) return 0 ;;
  esac
  [[ -n "${MSYSTEM:-}" ]]
}

# Convert a host path for Docker bind mounts (native Windows path on MSYS).
modelflow_docker_host_path() {
  local path="$1"
  if modelflow_is_msys && command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$path"
  else
    printf '%s' "$path"
  fi
}

# Return HOST:CONTAINER[:mode] for use with docker compose -v "$spec".
modelflow_compose_bind_mount_spec() {
  local host_path="$1"
  local container_path="$2"
  local mode="${3:-}"
  local host_native
  host_native="$(modelflow_docker_host_path "$host_path")"
  if [[ "$mode" == "ro" ]]; then
    printf '%s:%s:ro' "$host_native" "$container_path"
  else
    printf '%s:%s' "$host_native" "$container_path"
  fi
}

# Run docker compose with MSYS path conversion disabled for this invocation only.
modelflow_compose_sh() {
  if modelflow_is_msys; then
    MSYS_NO_PATHCONV=1 modelflow_compose "$@"
  else
    modelflow_compose "$@"
  fi
}
