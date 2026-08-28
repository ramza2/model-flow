#!/usr/bin/env bash
# Generate a local ModelFlow environment without committing credentials.
# Host tools required: bash + docker (Compose/curl used by verify separately).
# Secret generation runs inside python:3.11-slim — no host Python/OpenSSL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
FORCE=false
NON_INTERACTIVE=false
OUTPUT_SET=false
PYTHON_IMAGE="python:3.11-slim"

usage() {
  cat <<'EOF'
Usage: ./scripts/init-env.sh [--force] [--non-interactive-test] [--output PATH]

  --force                 Replace an existing .env (ignored when --output is set).
  --non-interactive-test  Generate every value without prompts.
  --output PATH           Write credentials to PATH instead of .env (never touches .env).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
    --non-interactive-test)
      NON_INTERACTIVE=true
      # Only force-replace the default .env when writing there.
      if [[ "$OUTPUT_SET" != true ]]; then
        FORCE=true
      fi
      shift
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "--output requires a path" >&2; exit 2; }
      ENV_FILE="$2"
      OUTPUT_SET=true
      FORCE=true
      shift 2
      ;;
    --output=*)
      ENV_FILE="${1#--output=}"
      OUTPUT_SET=true
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$OUTPUT_SET" != true && -e "$ENV_FILE" && "$FORCE" != true ]]; then
  echo "Refusing to overwrite $ENV_FILE. Re-run with --force to replace it." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to generate secure credentials (no host Python/OpenSSL)." >&2
  exit 1
fi

# Preserve any already-exported host ports (e.g. from an existing .env or CI).
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
SOURCE_POSTGRES_HOST_PORT="${SOURCE_POSTGRES_HOST_PORT:-5433}"
MINIO_API_HOST_PORT="${MINIO_API_HOST_PORT:-9000}"
MINIO_CONSOLE_HOST_PORT="${MINIO_CONSOLE_HOST_PORT:-9001}"
MLFLOW_HOST_PORT="${MLFLOW_HOST_PORT:-5000}"
BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-8000}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-3000}"

# Emit KEY=VALUE lines for generated secrets (stdlib only).
GENERATED="$(
  docker run --rm -i "$PYTHON_IMAGE" python - <<'PY'
import base64
import secrets


def hex_bytes(n: int) -> str:
    return secrets.token_hex(n)


def urlsafe(n: int) -> str:
    # Avoid a leading '-' so CLI tools (e.g. mc) never treat the value as a flag.
    while True:
        value = secrets.token_urlsafe(n)
        if not value.startswith("-"):
            return value


def identifier(prefix: str, n: int = 6) -> str:
    return f"{prefix}_{hex_bytes(n)}"


def fernet_key() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")


print("MODELFLOW_SECRET_KEY=" + hex_bytes(48))
print("MODELFLOW_ENCRYPTION_KEY=" + fernet_key())
print("MODELFLOW_BOOTSTRAP_ADMIN_EMAIL=admin@localhost.local")
print("MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD=" + urlsafe(36))
print("POSTGRES_USER=" + identifier("modelflow"))
print("POSTGRES_PASSWORD=" + urlsafe(36))
print("POSTGRES_DB=" + identifier("modelflow"))
print("MINIO_ROOT_USER=" + identifier("modelflow", 8))
print("MINIO_ROOT_PASSWORD=" + urlsafe(36))
print("SOURCE_POSTGRES_USER=" + identifier("source"))
print("SOURCE_POSTGRES_PASSWORD=" + urlsafe(36))
print("SOURCE_POSTGRES_DB=" + identifier("source"))
PY
)"

if [[ -z "$GENERATED" ]]; then
  echo "Failed to generate secrets via Docker image $PYTHON_IMAGE." >&2
  exit 1
fi

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  printf -v "$key" '%s' "$value"
done <<< "$GENERATED"

RATE_LIMIT_PER_MINUTE="120"
if [[ "$NON_INTERACTIVE" == true ]]; then
  # Verification/CI issues many authenticated API + browser requests from one IP.
  RATE_LIMIT_PER_MINUTE="10000"
fi

prompt_value() {
  local variable="$1"
  local label="$2"
  local current="${!variable}"
  local entered
  read -r -p "$label [$current]: " entered
  if [[ -n "$entered" ]]; then
    printf -v "$variable" '%s' "$entered"
  fi
}

prompt_secret() {
  local variable="$1"
  local label="$2"
  local entered
  read -r -s -p "$label [press Enter to use generated value]: " entered
  printf '\n'
  if [[ -n "$entered" ]]; then
    printf -v "$variable" '%s' "$entered"
  fi
}

ensure_frontend_cors_origin() {
  local origin="http://localhost:${FRONTEND_HOST_PORT}"
  if [[ ",${CORS_ORIGINS}," != *",${origin},"* ]]; then
    if [[ -n "${CORS_ORIGINS}" ]]; then
      CORS_ORIGINS="${CORS_ORIGINS},${origin}"
    else
      CORS_ORIGINS="${origin}"
    fi
  fi
}

if [[ "$NON_INTERACTIVE" != true ]]; then
  echo "Press Enter to accept each secure generated default."
  prompt_secret MODELFLOW_SECRET_KEY "ModelFlow token-signing key"
  prompt_secret MODELFLOW_ENCRYPTION_KEY "ModelFlow Fernet encryption key"
  prompt_value MODELFLOW_BOOTSTRAP_ADMIN_EMAIL "Bootstrap administrator email"
  prompt_secret MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD "Bootstrap administrator password"
  prompt_value POSTGRES_USER "PostgreSQL user"
  prompt_secret POSTGRES_PASSWORD "PostgreSQL password"
  prompt_value POSTGRES_DB "PostgreSQL database"
  prompt_value MINIO_ROOT_USER "MinIO root user"
  prompt_secret MINIO_ROOT_PASSWORD "MinIO root password"
  prompt_value SOURCE_POSTGRES_USER "Optional source PostgreSQL user"
  prompt_secret SOURCE_POSTGRES_PASSWORD "Optional source PostgreSQL password"
  prompt_value SOURCE_POSTGRES_DB "Optional source PostgreSQL database"
  echo "Host publish ports (change these instead of editing docker-compose.yml)."
  prompt_value POSTGRES_HOST_PORT "PostgreSQL host port"
  prompt_value SOURCE_POSTGRES_HOST_PORT "Source PostgreSQL host port"
  prompt_value MINIO_API_HOST_PORT "MinIO API host port"
  prompt_value MINIO_CONSOLE_HOST_PORT "MinIO console host port"
  prompt_value MLFLOW_HOST_PORT "MLflow host port"
  prompt_value BACKEND_HOST_PORT "Backend API host port"
  prompt_value FRONTEND_HOST_PORT "Frontend UI host port"
fi

# Traefik production hostname (empty for local/non-Traefik development).
MODELFLOW_WEB_HOST=""

# Always derive CORS from the final frontend host port.
CORS_ORIGINS="http://localhost:${FRONTEND_HOST_PORT},http://localhost:5173,http://localhost"
if [[ "$NON_INTERACTIVE" != true ]]; then
  prompt_value CORS_ORIGINS "Allowed CORS origins"
fi
ensure_frontend_cors_origin

for variable in \
  MODELFLOW_SECRET_KEY MODELFLOW_ENCRYPTION_KEY \
  MODELFLOW_BOOTSTRAP_ADMIN_EMAIL MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD \
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
  SOURCE_POSTGRES_USER SOURCE_POSTGRES_PASSWORD SOURCE_POSTGRES_DB \
  CORS_ORIGINS \
  POSTGRES_HOST_PORT SOURCE_POSTGRES_HOST_PORT \
  MINIO_API_HOST_PORT MINIO_CONSOLE_HOST_PORT \
  MLFLOW_HOST_PORT BACKEND_HOST_PORT FRONTEND_HOST_PORT; do
  if [[ -z "${!variable}" ]]; then
    echo "$variable must not be empty." >&2
    exit 1
  fi
  if [[ ! "${!variable}" =~ ^[A-Za-z0-9_@.,:/+=!?%~-]+$ ]]; then
    echo "$variable contains characters that cannot be written safely to .env." >&2
    echo "Use letters, numbers, or URL-safe punctuation." >&2
    exit 1
  fi
done

for variable in POSTGRES_USER POSTGRES_DB SOURCE_POSTGRES_USER SOURCE_POSTGRES_DB; do
  if [[ ! "${!variable}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "$variable must be a valid unquoted PostgreSQL identifier." >&2
    exit 1
  fi
done

for variable in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD SOURCE_POSTGRES_PASSWORD; do
  if [[ ! "${!variable}" =~ ^[A-Za-z0-9_.~-]+$ ]]; then
    echo "$variable must use URL-safe characters for service connection URIs." >&2
    exit 1
  fi
done

for variable in \
  POSTGRES_HOST_PORT SOURCE_POSTGRES_HOST_PORT \
  MINIO_API_HOST_PORT MINIO_CONSOLE_HOST_PORT \
  MLFLOW_HOST_PORT BACKEND_HOST_PORT FRONTEND_HOST_PORT; do
  if [[ ! "${!variable}" =~ ^[1-9][0-9]{0,4}$ ]] || (( ${!variable} > 65535 )); then
    echo "$variable must be an integer host port between 1 and 65535." >&2
    exit 1
  fi
done

if (( ${#MODELFLOW_SECRET_KEY} < 64 )); then
  echo "MODELFLOW_SECRET_KEY must contain at least 64 characters." >&2
  exit 1
fi
if [[ ! "$MODELFLOW_ENCRYPTION_KEY" =~ ^[A-Za-z0-9_-]{43}=$ ]]; then
  echo "MODELFLOW_ENCRYPTION_KEY must be a valid Fernet key." >&2
  exit 1
fi
for variable in \
  MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD POSTGRES_PASSWORD \
  MINIO_ROOT_PASSWORD SOURCE_POSTGRES_PASSWORD; do
  value="${!variable}"
  if (( ${#value} < 16 )); then
    echo "$variable must contain at least 16 characters." >&2
    exit 1
  fi
done

umask 077
mkdir -p "$(dirname "$ENV_FILE")"
TEMP_FILE="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT
cat > "$TEMP_FILE" <<EOF
# Generated by scripts/init-env.sh. Do not commit this file.
MODELFLOW_SECRET_KEY=$MODELFLOW_SECRET_KEY
MODELFLOW_ENCRYPTION_KEY=$MODELFLOW_ENCRYPTION_KEY
MODELFLOW_BOOTSTRAP_ADMIN_EMAIL=$MODELFLOW_BOOTSTRAP_ADMIN_EMAIL
MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD=$MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
SOURCE_POSTGRES_USER=$SOURCE_POSTGRES_USER
SOURCE_POSTGRES_PASSWORD=$SOURCE_POSTGRES_PASSWORD
SOURCE_POSTGRES_DB=$SOURCE_POSTGRES_DB
POSTGRES_HOST_PORT=$POSTGRES_HOST_PORT
SOURCE_POSTGRES_HOST_PORT=$SOURCE_POSTGRES_HOST_PORT
MINIO_API_HOST_PORT=$MINIO_API_HOST_PORT
MINIO_CONSOLE_HOST_PORT=$MINIO_CONSOLE_HOST_PORT
MLFLOW_HOST_PORT=$MLFLOW_HOST_PORT
BACKEND_HOST_PORT=$BACKEND_HOST_PORT
FRONTEND_HOST_PORT=$FRONTEND_HOST_PORT
MODELFLOW_WEB_HOST=$MODELFLOW_WEB_HOST
CORS_ORIGINS=$CORS_ORIGINS
RATE_LIMIT_PER_MINUTE=$RATE_LIMIT_PER_MINUTE
EOF
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

echo
echo "Created $ENV_FILE with mode 600."
if [[ "$OUTPUT_SET" == true ]]; then
  echo "Wrote verification/alternate env file (project .env was not modified)."
else
  echo "Bootstrap administrator credentials (shown once):"
  echo "  Email: $MODELFLOW_BOOTSTRAP_ADMIN_EMAIL"
  echo "  Password: $MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD"
  echo "Sign in and change this password immediately."
fi
echo "Host ports: UI :${FRONTEND_HOST_PORT}  API :${BACKEND_HOST_PORT}  MLflow :${MLFLOW_HOST_PORT}"
if [[ "$NON_INTERACTIVE" == true ]]; then
  echo "Non-interactive test mode: RATE_LIMIT_PER_MINUTE=$RATE_LIMIT_PER_MINUTE"
fi
