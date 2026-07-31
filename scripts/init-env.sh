#!/usr/bin/env bash
# Generate a local ModelFlow environment without committing credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
FORCE=false
NON_INTERACTIVE=false

usage() {
  cat <<'EOF'
Usage: ./scripts/init-env.sh [--force] [--non-interactive-test]

  --force                 Replace an existing .env.
  --non-interactive-test  Generate every value without prompts and replace .env.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    --non-interactive-test)
      NON_INTERACTIVE=true
      FORCE=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -e "$ENV_FILE" && "$FORCE" != true ]]; then
  echo "Refusing to overwrite $ENV_FILE. Re-run with --force to replace it." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then
  echo "python3 or openssl is required to generate secure credentials." >&2
  exit 1
fi

random_hex() {
  local bytes="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_hex($bytes))"
  else
    openssl rand -hex "$bytes"
  fi
}

random_urlsafe() {
  local bytes="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_urlsafe($bytes))"
  else
    openssl rand -base64 "$bytes" | tr '+/' '-_' | tr -d '=\n'
  fi
}

fernet_key() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
try:
    from cryptography.fernet import Fernet
except ImportError:
    import base64
    import secrets
    print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"))
else:
    print(Fernet.generate_key().decode("ascii"))
PY
  else
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n'
  fi
}

MODELFLOW_SECRET_KEY="$(random_hex 48)"
MODELFLOW_ENCRYPTION_KEY="$(fernet_key)"
MODELFLOW_BOOTSTRAP_ADMIN_EMAIL="admin@localhost.local"
MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD="$(random_urlsafe 36)"
POSTGRES_USER="modelflow_$(random_hex 6)"
POSTGRES_PASSWORD="$(random_urlsafe 36)"
POSTGRES_DB="modelflow_$(random_hex 6)"
MINIO_ROOT_USER="modelflow_$(random_hex 8)"
MINIO_ROOT_PASSWORD="$(random_urlsafe 36)"
SOURCE_POSTGRES_USER="source_$(random_hex 6)"
SOURCE_POSTGRES_PASSWORD="$(random_urlsafe 36)"
SOURCE_POSTGRES_DB="source_$(random_hex 6)"
CORS_ORIGINS="http://localhost:3000,http://localhost:5173,http://localhost"
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
  prompt_value CORS_ORIGINS "Allowed CORS origins"
fi

for variable in \
  MODELFLOW_SECRET_KEY MODELFLOW_ENCRYPTION_KEY \
  MODELFLOW_BOOTSTRAP_ADMIN_EMAIL MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD \
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
  SOURCE_POSTGRES_USER SOURCE_POSTGRES_PASSWORD SOURCE_POSTGRES_DB \
  CORS_ORIGINS; do
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
TEMP_FILE="$(mktemp "$ROOT/.env.tmp.XXXXXX")"
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
CORS_ORIGINS=$CORS_ORIGINS
RATE_LIMIT_PER_MINUTE=$RATE_LIMIT_PER_MINUTE
EOF
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

echo
echo "Created $ENV_FILE with mode 600."
echo "Bootstrap administrator credentials (shown once):"
echo "  Email: $MODELFLOW_BOOTSTRAP_ADMIN_EMAIL"
echo "  Password: $MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD"
echo "Sign in and change this password immediately."
