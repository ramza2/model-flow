#!/usr/bin/env bash
# Destructively verifies that backup.sh + restore.sh recover PostgreSQL and MinIO.
# Run only against a disposable verification stack: restore replaces both databases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

if ! modelflow_load_env "$ROOT"; then
  echo "Missing $(modelflow_env_file "$ROOT"); initialize the verification environment first." >&2
  exit 2
fi

: "${MODELFLOW_BOOTSTRAP_ADMIN_EMAIL:?Missing bootstrap administrator email in env}"
: "${MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD:?Missing bootstrap administrator password in env}"
: "${MINIO_ROOT_USER:?Missing MinIO user in env}"
: "${MINIO_ROOT_PASSWORD:?Missing MinIO password in env}"

BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-8000}"
API_BASE="${API_BASE:-http://localhost:${BACKEND_HOST_PORT}/api/v1}"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.11-slim}"
ARTIFACT_DIR="${VERIFY_ARTIFACT_DIR:-$ROOT/artifacts/verify}"
RUN_TAG="$(date +%s)-$$-$RANDOM"
BACKUP_DIR="$ARTIFACT_DIR/backup-roundtrip/$RUN_TAG"
MARKER_FILE="$ARTIFACT_DIR/backup-roundtrip-marker-$RUN_TAG.csv"
mkdir -p "$ARTIFACT_DIR" "$BACKUP_DIR"

fail() {
  echo "[FAIL] backup round-trip: $*" >&2
  exit 1
}

json_get() {
  local code="$1"
  docker run --rm -i \
    -e MODELFLOW_BOOTSTRAP_ADMIN_EMAIL \
    -e PROJECT_ID \
    -e PROJECT_NAME \
    -e DATASET_ID \
    -e DATASET_VERSION_ID \
    -e OBJECT_KEY \
    "$PYTHON_IMAGE" python -c "$code"
}

api() {
  curl -fsS -H "Authorization: Bearer $TOKEN" "$@"
}

object_checksum() {
  modelflow_compose_sh run --rm --no-deps -T \
    -e OBJECT_KEY="$OBJECT_KEY" \
    --entrypoint sh \
    minio-init -c '
      set -eu
      MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
      export MC_HOST_local
      mc cat "local/datasets/$OBJECT_KEY"
    ' | modelflow_compose exec -T backend python -c \
      'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
}

LOGIN_PAYLOAD="{\"email\":\"$MODELFLOW_BOOTSTRAP_ADMIN_EMAIL\",\"password\":\"$MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD\"}"
LOGIN="$(curl -fsS -X POST "$API_BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_PAYLOAD")"
TOKEN="$(echo "$LOGIN" | json_get 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

PROJECT_NAME="backup-roundtrip-$RUN_TAG"
PROJECT="$(api -X POST "$API_BASE/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$PROJECT_NAME\",\"description\":\"Backup restore verification marker\"}")"
PROJECT_ID="$(echo "$PROJECT" | json_get 'import json,sys; print(json.load(sys.stdin)["id"])')"

printf 'marker,value\nroundtrip,%s\n' "$RUN_TAG" > "$MARKER_FILE"
DATASET="$(api -X POST "$API_BASE/projects/$PROJECT_ID/datasets" \
  -F "name=backup-roundtrip-marker" \
  -F "description=Backup restore object marker" \
  -F "file=@$MARKER_FILE;type=text/csv")"
DATASET_ID="$(echo "$DATASET" | json_get 'import json,sys; print(json.load(sys.stdin)["id"])')"
DATASET_VERSION_ID="$(echo "$DATASET" | json_get 'import json,sys; print(json.load(sys.stdin)["version"]["id"])')"
OBJECT_KEY="$(echo "$DATASET" | json_get 'import json,sys; print(json.load(sys.stdin)["version"]["object_key"])')"
ORIGINAL_CHECKSUM="$(object_checksum)"
[[ -n "$ORIGINAL_CHECKSUM" ]] || fail "could not checksum marker object"

{
  echo "project_id=$PROJECT_ID"
  echo "project_name=$PROJECT_NAME"
  echo "dataset_id=$DATASET_ID"
  echo "dataset_version_id=$DATASET_VERSION_ID"
  echo "object_key=$OBJECT_KEY"
  echo "sha256=$ORIGINAL_CHECKSUM"
} > "$ARTIFACT_DIR/backup-roundtrip-marker.txt"

BACKUP_DIR="$BACKUP_DIR" ./scripts/backup.sh \
  | tee "$ARTIFACT_DIR/backup-roundtrip-backup.log"

api -X DELETE "$API_BASE/projects/$PROJECT_ID" >/dev/null
modelflow_compose_sh run --rm --no-deps -T \
  -e OBJECT_KEY="$OBJECT_KEY" \
  --entrypoint sh \
  minio-init -c '
    set -eu
    MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    export MC_HOST_local
    mc rm "local/datasets/$OBJECT_KEY"
  ' >/dev/null

PROJECT_STATUS="$(curl -sS -o "$ARTIFACT_DIR/backup-roundtrip-mutated-project.json" \
  -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/projects/$PROJECT_ID")"
[[ "$PROJECT_STATUS" == "404" ]] || fail "deleted marker project remained visible (HTTP $PROJECT_STATUS)"
if modelflow_compose_sh run --rm --no-deps -T \
  -e OBJECT_KEY="$OBJECT_KEY" \
  --entrypoint sh \
  minio-init -c '
    MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
    export MC_HOST_local
    mc stat "local/datasets/$OBJECT_KEY"
  ' >/dev/null 2>&1; then
  fail "deleted marker object remained in MinIO"
fi

./scripts/restore.sh "$BACKUP_DIR" \
  | tee "$ARTIFACT_DIR/backup-roundtrip-restore.log"

curl -fsS "http://localhost:${BACKEND_HOST_PORT}/api/health" \
  > "$ARTIFACT_DIR/backup-roundtrip-health.json"
LOGIN="$(curl -fsS -X POST "$API_BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_PAYLOAD")"
TOKEN="$(echo "$LOGIN" | json_get 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
echo "$LOGIN" | json_get \
  'import json,os,sys; d=json.load(sys.stdin); assert d["user"]["email"] == os.environ["MODELFLOW_BOOTSTRAP_ADMIN_EMAIL"]'

RESTORED_PROJECT="$(api "$API_BASE/projects/$PROJECT_ID")"
echo "$RESTORED_PROJECT" > "$ARTIFACT_DIR/backup-roundtrip-project.json"
echo "$RESTORED_PROJECT" | PROJECT_ID="$PROJECT_ID" PROJECT_NAME="$PROJECT_NAME" json_get \
  'import json,os,sys; d=json.load(sys.stdin); assert d["id"] == int(os.environ["PROJECT_ID"]); assert d["name"] == os.environ["PROJECT_NAME"]; assert d["description"] == "Backup restore verification marker"'

RESTORED_DATASET="$(api "$API_BASE/projects/$PROJECT_ID/datasets/$DATASET_ID")"
echo "$RESTORED_DATASET" > "$ARTIFACT_DIR/backup-roundtrip-dataset.json"
echo "$RESTORED_DATASET" | DATASET_ID="$DATASET_ID" OBJECT_KEY="$OBJECT_KEY" json_get \
  'import json,os,sys; d=json.load(sys.stdin); assert d["id"] == int(os.environ["DATASET_ID"]); assert d["name"] == "backup-roundtrip-marker"; assert d["object_key"] == os.environ["OBJECT_KEY"]'

RESTORED_VERSION="$(api "$API_BASE/projects/$PROJECT_ID/datasets/$DATASET_ID/versions/1")"
echo "$RESTORED_VERSION" | DATASET_VERSION_ID="$DATASET_VERSION_ID" OBJECT_KEY="$OBJECT_KEY" json_get \
  'import json,os,sys; d=json.load(sys.stdin); assert d["id"] == int(os.environ["DATASET_VERSION_ID"]); assert d["object_key"] == os.environ["OBJECT_KEY"]; assert d["original_filename"].endswith(".csv")'

RESTORED_CHECKSUM="$(object_checksum)"
[[ "$RESTORED_CHECKSUM" == "$ORIGINAL_CHECKSUM" ]] \
  || fail "restored object checksum mismatch ($RESTORED_CHECKSUM != $ORIGINAL_CHECKSUM)"

if [[ -n "${ROUNDTRIP_ENDPOINT_ID:-}" ]]; then
  PREDICTION="$(api -X POST "$API_BASE/endpoints/$ROUNDTRIP_ENDPOINT_ID/predict" \
    -H 'Content-Type: application/json' \
    -d '{"instances":[{"sepal length (cm)":5.1,"sepal width (cm)":3.5,"petal length (cm)":1.4,"petal width (cm)":0.2}]}')"
  echo "$PREDICTION" > "$ARTIFACT_DIR/backup-roundtrip-predict.json"
  echo "$PREDICTION" | json_get \
    'import json,sys; d=json.load(sys.stdin); assert len(d["predictions"]) == 1'
fi

echo "PASS" > "$ARTIFACT_DIR/backup-roundtrip-result.txt"
echo "[PASS] PostgreSQL and MinIO backup/restore round-trip"
