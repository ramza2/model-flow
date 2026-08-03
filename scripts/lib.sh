#!/usr/bin/env bash
# Shared helpers for scripts that may run against a non-default env file.
# shellcheck shell=bash

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

modelflow_compose() {
  if [[ -n "${MODELFLOW_ENV_FILE:-}" ]]; then
    docker compose --env-file "$MODELFLOW_ENV_FILE" "$@"
  else
    docker compose "$@"
  fi
}
