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
trap 'rm -f "$DEFAULT_RENDER" "$HA_RENDER"' EXIT

"$HELM_BIN" lint "$CHART"

"$HELM_BIN" template modelflow "$CHART"   --namespace model-flow   --kube-version 1.30.0   >"$DEFAULT_RENDER"

"$HELM_BIN" template modelflow "$CHART"   --namespace model-flow   --kube-version 1.30.0   --set ingress.enabled=true   --set ingress.host=modelflow.example.test   --set ingress.tls.enabled=true   --set ingress.tls.secretName=modelflow-example-tls   --set worker.gpu.enabled=true   >"$HA_RENDER"

grep -Fq '# Source: model-flow/templates/migration-job.yaml' "$DEFAULT_RENDER"   || fail "dedicated migration Job did not render"
grep -Fq '"helm.sh/hook": pre-install,pre-upgrade' "$DEFAULT_RENDER"   || fail "migration Job is not a pre-install/pre-upgrade hook"
grep -Fq 'command:' "$DEFAULT_RENDER" || fail "rendered manifests have no commands"
grep -Fq -- '- alembic' "$DEFAULT_RENDER"   || fail "migration Job does not run alembic"
grep -Fq 'DATABASE_URL_FILE' "$DEFAULT_RENDER"   || fail "file-mounted database secret contract is missing"
grep -Fq '/run/model-flow-secrets' "$DEFAULT_RENDER"   || fail "runtime secret mount is missing"

for component in backend inference-runtime worker-general mlflow frontend; do
  grep -Fq "app.kubernetes.io/component: $component" "$DEFAULT_RENDER"     || fail "missing component deployment: $component"
done

grep -Fq 'path: /api/health' "$DEFAULT_RENDER"   || fail "backend health probe missing"
grep -Fq 'path: /ready' "$DEFAULT_RENDER"   || fail "inference readiness probe missing"
grep -Fq 'app.workers.healthcheck' "$DEFAULT_RENDER"   || fail "worker exec probe missing"
grep -Fq 'kind: PodDisruptionBudget' "$DEFAULT_RENDER"   || fail "PodDisruptionBudget did not render"

if grep -Fq 'nvidia.com/gpu' "$DEFAULT_RENDER"; then
  fail "GPU resource rendered while gpu worker profile is disabled"
fi
grep -Fq 'app.kubernetes.io/component: worker-gpu' "$HA_RENDER"   || fail "gpu worker deployment did not render when enabled"
grep -Fq 'nvidia.com/gpu: 1' "$HA_RENDER"   || fail "gpu worker does not request the Kubernetes GPU resource"

grep -Fq 'kind: Ingress' "$HA_RENDER" || fail "Ingress did not render"
grep -Fq 'host: modelflow.example.test' "$HA_RENDER"   || fail "Ingress host did not render"
grep -Fq 'secretName: modelflow-example-tls' "$HA_RENDER"   || fail "Ingress TLS secret did not render"

if grep -Eq '^kind: (StatefulSet|PersistentVolumeClaim)$' "$DEFAULT_RENDER"; then
  fail "chart must not claim embedded stateful HA"
fi

echo "[PASS] Helm chart lint/render and HA contract checks"
