#!/usr/bin/env bash
# Render/lint the Phase 8-E Helm deployment without requiring a Kubernetes cluster.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHART="$ROOT/deploy/helm/model-flow"
HELM_BIN="${HELM_BIN:-helm}"

fail() {
  echo "[FAIL] kubernetes helm: $*" >&2
  exit 1
}

command -v "$HELM_BIN" >/dev/null 2>&1 || fail "helm is not installed"
[[ -f "$CHART/Chart.yaml" ]] || fail "chart not found: $CHART"

mkdir -p "$ROOT/artifacts/verify"
DEFAULT_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-default.XXXXXX.yaml")"
HA_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-ha.XXXXXX.yaml")"
INFERENCE_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-inference.XXXXXX.yaml")"
WORKER_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-worker.XXXXXX.yaml")"
MIGRATION_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-migration.XXXXXX.yaml")"
MLFLOW_MIGRATION_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-mlflow-migration.XXXXXX.yaml")"
INGRESS_RENDER="$(mktemp "$ROOT/artifacts/verify/helm-ingress.XXXXXX.yaml")"
trap 'rm -f "$DEFAULT_RENDER" "$HA_RENDER" "$INFERENCE_RENDER" "$WORKER_RENDER" "$MIGRATION_RENDER" "$MLFLOW_MIGRATION_RENDER" "$INGRESS_RENDER"' EXIT

"$HELM_BIN" lint "$CHART"

default_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
)
"$HELM_BIN" "${default_args[@]}" >"$DEFAULT_RENDER"

ha_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
  --set ingress.enabled=true
  --set ingress.host=modelflow.example.test
  --set ingress.tls.enabled=true
  --set ingress.tls.secretName=modelflow-example-tls
  --set worker.gpu.enabled=true
  --set worker.gpu.replicaCount=2
  --set external.objectStore.region=ap-northeast-2
  --set external.objectStore.buckets.mlflow=model-flow-mlflow-artifacts
  --set secret.keys.bootstrapAdminPassword=bootstrap-admin-password
)
"$HELM_BIN" "${ha_args[@]}" >"$HA_RENDER"

inference_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
  --show-only templates/inference-runtime.yaml
  --set external.objectStore.region=ap-northeast-2
)
"$HELM_BIN" "${inference_args[@]}" >"$INFERENCE_RENDER"

worker_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
  --show-only templates/worker.yaml
)
"$HELM_BIN" "${worker_args[@]}" >"$WORKER_RENDER"

migration_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
  --show-only templates/migration-job.yaml
)
"$HELM_BIN" "${migration_args[@]}" >"$MIGRATION_RENDER"

mlflow_migration_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
  --show-only templates/mlflow-migration-job.yaml
)
"$HELM_BIN" "${mlflow_migration_args[@]}" >"$MLFLOW_MIGRATION_RENDER"

ingress_args=(
  template modelflow "$CHART"
  --namespace model-flow
  --kube-version 1.30.0
  --show-only templates/ingress.yaml
  --set ingress.enabled=true
  --set ingress.host=modelflow.example.test
)
"$HELM_BIN" "${ingress_args[@]}" >"$INGRESS_RENDER"

grep -Fq '# Source: model-flow/templates/migration-job.yaml' "$DEFAULT_RENDER" ||
  fail "dedicated migration Job did not render"
grep -Fq '"helm.sh/hook": pre-install,pre-upgrade' "$DEFAULT_RENDER" ||
  fail "migration Job is not a pre-install/pre-upgrade hook"
grep -Fq 'command: ["alembic"]' "$DEFAULT_RENDER" ||
  fail "migration Job does not run alembic"
grep -Fq 'DATABASE_URL_FILE' "$DEFAULT_RENDER" ||
  fail "file-mounted database secret contract is missing"
grep -Fq '# Source: model-flow/templates/mlflow-migration-job.yaml' "$DEFAULT_RENDER" ||
  fail "dedicated MLflow migration Job did not render"
grep -Fq 'mlflow db upgrade "$MLFLOW_BACKEND_STORE_URI"' "$DEFAULT_RENDER" ||
  fail "MLflow migration Job does not upgrade its database"
grep -Fq '/run/model-flow-secrets' "$DEFAULT_RENDER" ||
  fail "runtime secret mount is missing"

for component in backend inference-runtime worker-general mlflow frontend; do
  grep -Fq "app.kubernetes.io/component: $component" "$DEFAULT_RENDER" ||
    fail "missing component deployment: $component"
done

grep -Fq 'path: /api/v1/ready' "$DEFAULT_RENDER" ||
  fail "backend database readiness probe missing"
grep -Fq 'path: /api/health' "$DEFAULT_RENDER" ||
  fail "backend liveness probe missing"
grep -Fq 'path: /ready' "$DEFAULT_RENDER" ||
  fail "inference readiness probe missing"
grep -Fq 'app.workers.healthcheck' "$DEFAULT_RENDER" ||
  fail "worker exec probe missing"
grep -Fq 'kind: PodDisruptionBudget' "$DEFAULT_RENDER" ||
  fail "PodDisruptionBudget did not render"
grep -Fq 'name: MODELFLOW_ENSURE_OBJECT_STORE_BUCKETS' "$DEFAULT_RENDER" ||
  fail "object-store bucket bootstrap control did not render"
grep -A1 -F 'name: MODELFLOW_ENSURE_OBJECT_STORE_BUCKETS' "$DEFAULT_RENDER" |
  grep -Fq 'value: "false"' ||
  fail "Kubernetes must default object-store bucket bootstrap to false"

if grep -Fq 'bootstrap-admin-password' "$DEFAULT_RENDER"; then
  fail "bootstrap admin password must not be permanently required by default"
fi
grep -Fq 'bootstrap-admin-password' "$HA_RENDER" ||
  fail "bootstrap admin secret key did not render when explicitly enabled"

if grep -Fq 'nvidia.com/gpu' "$DEFAULT_RENDER"; then
  fail "GPU resource rendered while gpu worker profile is disabled"
fi
grep -Fq 'app.kubernetes.io/component: worker-gpu' "$HA_RENDER" ||
  fail "gpu worker deployment did not render when enabled"
grep -Fq 'nvidia.com/gpu: 1' "$HA_RENDER" ||
  fail "gpu worker does not request the Kubernetes GPU resource"

GPU_HA_PDB_COUNT="$(grep -c '^kind: PodDisruptionBudget$' "$HA_RENDER")"
[[ "$GPU_HA_PDB_COUNT" -eq 6 ]] ||
  fail "expected 6 PDBs with scaled GPU workers, got $GPU_HA_PDB_COUNT"

grep -Fq 'ap-northeast-2' "$HA_RENDER" ||
  fail "configured object-store region did not render"
grep -Fq -- '--default-artifact-root "s3://model-flow-mlflow-artifacts/"' "$HA_RENDER" ||
  fail "MLflow artifact root did not follow configured object-store bucket"

grep -Fq 'name: MINIO_REGION' "$INFERENCE_RENDER" ||
  fail "inference runtime MINIO_REGION setting missing"
grep -Fq 'ap-northeast-2' "$INFERENCE_RENDER" ||
  fail "inference runtime object-store region did not render"
for required_secret in object-store-access-key object-store-secret-key inference-service-token; do
  grep -Fq "$required_secret" "$INFERENCE_RENDER" ||
    fail "inference runtime secret projection missing: $required_secret"
done
for forbidden_secret in database-url jwt-signing-key encryption-key bootstrap-admin-password; do
  if grep -Fq "$forbidden_secret" "$INFERENCE_RENDER"; then
    fail "inference runtime received unnecessary secret key: $forbidden_secret"
  fi
done

for required_secret in database-url object-store-access-key object-store-secret-key encryption-key inference-service-token; do
  grep -Fq "$required_secret" "$WORKER_RENDER" ||
    fail "worker secret projection missing: $required_secret"
done
for forbidden_secret in jwt-signing-key bootstrap-admin-password; do
  if grep -Fq "$forbidden_secret" "$WORKER_RENDER"; then
    fail "worker received unnecessary secret key: $forbidden_secret"
  fi
done

grep -Fq 'database-url' "$MIGRATION_RENDER" ||
  fail "migration database secret projection missing"
for forbidden_secret in object-store-access-key object-store-secret-key jwt-signing-key encryption-key inference-service-token bootstrap-admin-password; do
  if grep -Fq "$forbidden_secret" "$MIGRATION_RENDER"; then
    fail "migration job received unnecessary secret key: $forbidden_secret"
  fi
done

grep -Fq 'mlflow-database-url' "$MLFLOW_MIGRATION_RENDER" ||
  fail "MLflow migration database secret reference missing"
for forbidden_secret in database-url object-store-access-key object-store-secret-key jwt-signing-key encryption-key inference-service-token bootstrap-admin-password; do
  if grep -Eq "^[[:space:]]+key: ${forbidden_secret}$" "$MLFLOW_MIGRATION_RENDER"; then
    fail "MLflow migration job received unnecessary secret key: $forbidden_secret"
  fi
done

grep -Fq 'kind: Ingress' "$HA_RENDER" ||
  fail "Ingress did not render"
grep -Fq 'host: modelflow.example.test' "$HA_RENDER" ||
  fail "Ingress host did not render"
grep -Fq 'secretName: modelflow-example-tls' "$HA_RENDER" ||
  fail "Ingress TLS secret did not render"

grep -Fq -- '-frontend' "$INGRESS_RENDER" ||
  fail "Ingress must route to frontend service"
for internal_component in backend inference-runtime mlflow worker-general worker-gpu; do
  if grep -Fq -- "-$internal_component" "$INGRESS_RENDER"; then
    fail "Ingress exposed internal component: $internal_component"
  fi
done

if grep -Eq '^[[:space:]]*type:[[:space:]]*(NodePort|LoadBalancer)[[:space:]]*$' "$DEFAULT_RENDER"; then
  fail "internal Services must not render NodePort/LoadBalancer by default"
fi

if grep -Eq '^kind: (StatefulSet|PersistentVolumeClaim)$' "$DEFAULT_RENDER"; then
  fail "chart must not claim embedded stateful HA"
fi

echo "[PASS] Helm chart lint/render and HA contract checks"
