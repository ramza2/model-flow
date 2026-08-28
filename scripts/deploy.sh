#!/usr/bin/env bash
# Deploy ModelFlow with Docker Compose (optional Traefik overlay).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.deploy"
USE_TRAEFIK=true
DO_BUILD=false
DO_MIGRATE=false
FORCE_RECREATE=false
TRAEFIK_NETWORK="traefik_proxy"
TRAEFIK_COMPOSE_FILE="$ROOT/docker-compose.traefik.yml"
BASE_COMPOSE_FILE="$ROOT/docker-compose.yml"
CONFIG_ARTIFACT=""

info() { printf '==> %s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy.sh [options]

Deploy ModelFlow from the current checkout. This script does not run git pull,
reset the tree, or modify your environment file.

Options:
  --traefik            Use docker-compose.traefik.yml overlay (default)
  --no-traefik         Use docker-compose.yml only
  --build              Build images before starting services
  --migrate            Run `alembic upgrade head` before `docker compose up`
  --force-recreate     Pass --force-recreate to `docker compose up -d`
  --env-file PATH      Environment file (default: .env.deploy)
  -h, --help           Show this help

Examples:
  ./scripts/deploy.sh --traefik
  ./scripts/deploy.sh --traefik --build
  ./scripts/deploy.sh --traefik --build --migrate --force-recreate
  ./scripts/deploy.sh --no-traefik --build
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --traefik)
      USE_TRAEFIK=true
      shift
      ;;
    --no-traefik)
      USE_TRAEFIK=false
      shift
      ;;
    --build)
      DO_BUILD=true
      shift
      ;;
    --migrate)
      DO_MIGRATE=true
      shift
      ;;
    --force-recreate)
      FORCE_RECREATE=true
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || { err "--env-file requires a path"; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#--env-file=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$ROOT/$ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  err "Environment file not found: $ENV_FILE"
  err "Create one with: ./scripts/init-env.sh --output .env.deploy"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  err "docker is not installed or not on PATH."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  err "docker compose plugin is not available."
  exit 1
fi

if [[ "$USE_TRAEFIK" == true ]]; then
  if [[ ! -f "$TRAEFIK_COMPOSE_FILE" ]]; then
    err "Missing Traefik overlay: $TRAEFIK_COMPOSE_FILE"
    exit 1
  fi
  if ! docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1; then
    err "Docker network '$TRAEFIK_NETWORK' not found."
    err "Verify the existing Traefik deployment or create the network intentionally."
    err "Example (only when no shared Traefik network exists yet): docker network create $TRAEFIK_NETWORK"
    exit 1
  fi
fi

compose_args=(--env-file "$ENV_FILE" -f "$BASE_COMPOSE_FILE")
if [[ "$USE_TRAEFIK" == true ]]; then
  compose_args+=(-f "$TRAEFIK_COMPOSE_FILE")
fi

compose() {
  docker compose "${compose_args[@]}" "$@"
}

load_deploy_env() {
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

validate_compose_config() {
  info "Validating compose configuration..."
  CONFIG_ARTIFACT="$(mktemp "${TMPDIR:-/tmp}/modelflow-compose-config.XXXXXX")"
  compose config >"$CONFIG_ARTIFACT"

  if [[ "$USE_TRAEFIK" == true ]]; then
    load_deploy_env
    if [[ -z "${MODELFLOW_WEB_HOST:-}" ]]; then
      err "MODELFLOW_WEB_HOST must be set in $ENV_FILE for Traefik deployment."
      exit 1
    fi
    if ! grep -Fq "Host(\`${MODELFLOW_WEB_HOST}\`)" "$CONFIG_ARTIFACT"; then
      err "Traefik router rule for MODELFLOW_WEB_HOST was not rendered in compose config."
      exit 1
    fi
    if ! grep -Fq "traefik.http.routers.modelflow-web.rule" "$CONFIG_ARTIFACT"; then
      err "Missing Traefik router labels on frontend."
      exit 1
    fi
    if ! grep -A40 '^  frontend:$' "$CONFIG_ARTIFACT" | grep -Fq 'traefik_proxy'; then
      err "frontend is not attached to traefik_proxy."
      exit 1
    fi
    if ! grep -A40 '^  frontend:$' "$CONFIG_ARTIFACT" | grep -Fq 'default'; then
      err "frontend is not attached to the default Compose network."
      exit 1
    fi
    if grep -qE '^[[:space:]]+published:' "$CONFIG_ARTIFACT"; then
      err "Traefik mode must not publish host ports (found published: in merged config)."
      exit 1
    fi
  fi
}

wait_for_postgres() {
  load_deploy_env
  : "${POSTGRES_USER:?POSTGRES_USER is required in $ENV_FILE}"
  for attempt in $(seq 1 60); do
    if compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$attempt" -eq 60 ]]; then
      err "PostgreSQL did not become ready for migrations."
      return 1
    fi
    sleep 2
  done
}

run_migrations() {
  info "Running database migrations..."
  compose up -d postgres
  wait_for_postgres
  compose run --rm --no-deps backend alembic upgrade head
}

start_services() {
  info "Starting ModelFlow..."
  local up_args=(-d)
  if [[ "$FORCE_RECREATE" == true ]]; then
    up_args+=(--force-recreate)
  fi
  compose up "${up_args[@]}"
}

cleanup() {
  if [[ -n "$CONFIG_ARTIFACT" && -f "$CONFIG_ARTIFACT" ]]; then
    rm -f "$CONFIG_ARTIFACT"
  fi
}
trap cleanup EXIT

validate_compose_config

if [[ "$DO_BUILD" == true ]]; then
  info "Building images..."
  compose build
fi

if [[ "$DO_MIGRATE" == true ]]; then
  run_migrations
fi

start_services

compose ps

load_deploy_env
if [[ "$USE_TRAEFIK" == true && -n "${MODELFLOW_WEB_HOST:-}" ]]; then
  info "ModelFlow deployment complete."
  printf '\nURL:\nhttps://%s\n' "$MODELFLOW_WEB_HOST"
else
  info "ModelFlow deployment complete."
fi
