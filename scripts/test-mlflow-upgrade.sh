#!/usr/bin/env bash
# Isolated MLflow tracking-store upgrade: 3.11.1 → 3.17.2 with data preserved.
# Uses disposable Postgres + MinIO only. Never point this at production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OLD_TAG="${MLFLOW_UPGRADE_FROM_TAG:-v3.11.1}"
NEW_TAG="${MLFLOW_UPGRADE_TO_TAG:-v3.17.2}"
OLD_IMAGE="${MLFLOW_UPGRADE_OLD_IMAGE:-modelflow-mlflow-upgrade-old:test}"
NEW_IMAGE="${MLFLOW_UPGRADE_NEW_IMAGE:-modelflow-mlflow-upgrade-new:test}"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"
ARTIFACT_DIR="${VERIFY_ARTIFACT_DIR:-$ROOT/artifacts/verify}"
mkdir -p "$ARTIFACT_DIR"

NETWORK="mf-mlflow-upgrade-$$"
PG_NAME="mf-mlu-pg-$$"
MINIO_NAME="mf-mlu-minio-$$"
MLFLOW_NAME="mf-mlu-server-$$"
SEED_FILE="$ARTIFACT_DIR/mlflow-upgrade-seed-$$.json"
VERIFY_OUT="$ARTIFACT_DIR/mlflow-upgrade-verify-$$.json"

PG_USER="mlu_user"
PG_PASSWORD="mlu_password_not_for_prod"
PG_DB="postgres"
MINIO_USER="mlu_minio"
MINIO_PASSWORD="mlu_minio_password_not_for_prod"

# Reuse the Compose-built MinIO image (bundles server + mc; Docker Hub anonymous pulls are denied).
MINIO_IMAGE="${MINIO_UPGRADE_TEST_IMAGE:-modelflow/minio:RELEASE.2025-10-15T17-29-55Z}"
POSTGRES_IMAGE="${POSTGRES_UPGRADE_TEST_IMAGE:-postgres:16.9-alpine}"

fail() {
  echo "[FAIL] mlflow upgrade: $*" >&2
  exit 1
}

pass() {
  echo "[PASS] mlflow upgrade: $*"
}

cleanup() {
  docker rm -f "$MLFLOW_NAME" "$MINIO_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$SEED_FILE" "$VERIFY_OUT"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker is required"

docker network create "$NETWORK" >/dev/null

docker run -d --name "$PG_NAME" --network "$NETWORK" --network-alias postgres \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  -v "$ROOT/scripts/init-databases.sql:/docker-entrypoint-initdb.d/01-init-databases.sql:ro" \
  "$POSTGRES_IMAGE" >/dev/null \
  || fail "failed to start disposable Postgres"

docker run -d --name "$MINIO_NAME" --network "$NETWORK" --network-alias minio \
  -e MINIO_ROOT_USER="$MINIO_USER" \
  -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" \
  "$MINIO_IMAGE" server /data >/dev/null \
  || fail "failed to start disposable MinIO"

for _ in $(seq 1 90); do
  if docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 \
    && docker exec "$MINIO_NAME" curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null \
  || fail "Postgres not ready"
docker exec "$MINIO_NAME" curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null \
  || fail "MinIO not ready"

# Ensure mlflow DB exists even if init script raced.
if ! docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_NAME" \
  psql -U "$PG_USER" -d "$PG_DB" -Atqc "SELECT 1 FROM pg_database WHERE datname='mlflow'" \
  | grep -qx 1; then
  docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_NAME" \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE mlflow;" >/dev/null
fi

docker run --rm --network "$NETWORK" \
  -e MINIO_ROOT_USER="$MINIO_USER" \
  -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" \
  --entrypoint sh \
  "$MINIO_IMAGE" -c \
  'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb -p local/mlflow' \
  >/dev/null \
  || fail "failed to create mlflow bucket"

build_mlflow_image() {
  local image="$1"
  local tag="$2"
  echo "[INFO] mlflow upgrade: building $image from $tag"
  docker build -q \
    --build-arg "MLFLOW_VERSION=$tag" \
    -t "$image" \
    "$ROOT/infra/mlflow" >/dev/null \
    || fail "docker build failed for $tag"
}

build_mlflow_image "$OLD_IMAGE" "$OLD_TAG"
build_mlflow_image "$NEW_IMAGE" "$NEW_TAG"
pass "built MLflow images $OLD_TAG and $NEW_TAG"

start_mlflow() {
  local image="$1"
  docker rm -f "$MLFLOW_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$MLFLOW_NAME" --network "$NETWORK" --network-alias mlflow \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e MLFLOW_S3_ENDPOINT_URL=http://minio:9000 \
    -e AWS_ACCESS_KEY_ID="$MINIO_USER" \
    -e AWS_SECRET_ACCESS_KEY="$MINIO_PASSWORD" \
    -e AWS_DEFAULT_REGION=us-east-1 \
    --entrypoint sh \
    "$image" -c '
      set -eu
      URI="postgresql+psycopg2://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/mlflow"
      exec mlflow server \
        --host 0.0.0.0 \
        --port 5000 \
        --allowed-hosts mlflow:5000,localhost:*,127.0.0.1:* \
        --backend-store-uri "$URI" \
        --default-artifact-root s3://mlflow/ \
        --serve-artifacts
    ' >/dev/null \
    || fail "failed to start MLflow from $image"

  for _ in $(seq 1 90); do
    if docker exec "$MLFLOW_NAME" python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health')" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$MLFLOW_NAME" >&2 || true
  fail "MLflow health check failed for $image"
}

start_mlflow "$OLD_IMAGE"
pass "MLflow $OLD_TAG server healthy"

docker run --rm --network "$NETWORK" \
  -v "$ROOT/scripts/mlflow_upgrade_seed.py:/seed.py:ro" \
  -v "$ARTIFACT_DIR:/out" \
  -e SEED_OUT="/out/$(basename "$SEED_FILE")" \
  -e MLFLOW_TRACKING_URI=http://mlflow:5000 \
  -e MLFLOW_S3_ENDPOINT_URL=http://minio:9000 \
  -e AWS_ACCESS_KEY_ID="$MINIO_USER" \
  -e AWS_SECRET_ACCESS_KEY="$MINIO_PASSWORD" \
  -e AWS_DEFAULT_REGION=us-east-1 \
  -e GIT_PYTHON_REFRESH=quiet \
  "$PYTHON_IMAGE" \
  sh -c 'pip install -q "mlflow==3.11.1" boto3 >/dev/null && python /seed.py' \
  >/dev/null \
  || fail "failed to seed MLflow $OLD_TAG data"
[[ -s "$SEED_FILE" ]] || fail "missing seed file $SEED_FILE"
pass "seeded experiment/run/metric/artifact/registered model on $OLD_TAG"

echo "[INFO] mlflow upgrade: stopping $OLD_TAG server before schema upgrade"
docker rm -f "$MLFLOW_NAME" >/dev/null 2>&1 || true

echo "[INFO] mlflow upgrade: running mlflow db upgrade with $NEW_TAG image"
docker run --rm --network "$NETWORK" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  --entrypoint sh \
  "$NEW_IMAGE" -c '
    set -eu
    URI="postgresql+psycopg2://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/mlflow"
    mlflow db upgrade "$URI"
  ' >/dev/null \
  || fail "mlflow db upgrade failed"
pass "mlflow db upgrade completed with $NEW_TAG"

start_mlflow "$NEW_IMAGE"
pass "MLflow $NEW_TAG server healthy after upgrade"

docker run --rm --network "$NETWORK" \
  -v "$ROOT/scripts/mlflow_upgrade_verify.py:/verify.py:ro" \
  -v "$ARTIFACT_DIR:/out" \
  -e SEED_IN="/out/$(basename "$SEED_FILE")" \
  -e MLFLOW_TRACKING_URI=http://mlflow:5000 \
  -e MLFLOW_S3_ENDPOINT_URL=http://minio:9000 \
  -e AWS_ACCESS_KEY_ID="$MINIO_USER" \
  -e AWS_SECRET_ACCESS_KEY="$MINIO_PASSWORD" \
  -e AWS_DEFAULT_REGION=us-east-1 \
  "$PYTHON_IMAGE" \
  sh -c 'pip install -q "mlflow==3.17.2" boto3 && python /verify.py' \
  >"$VERIFY_OUT" \
  || fail "post-upgrade verification failed"
[[ -s "$VERIFY_OUT" ]] || fail "missing verify output"
pass "preserved pre-upgrade run/metric/artifact/model and logged a new run on $NEW_TAG"

pass "all MLflow upgrade checks"
