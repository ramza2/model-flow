# Kubernetes / HA Deployment

Phase 8-E adds a Helm-based Kubernetes deployment path for ModelFlow while keeping
the existing Docker Compose + Traefik deployment supported.

The Helm chart is located at:

```text
deploy/helm/model-flow
```

## Scope and HA boundary

The chart deploys only ModelFlow stateless/control-plane services:

- frontend
- backend control plane
- inference runtime
- general worker replicas
- optional GPU worker replicas
- MLflow server replicas
- one-shot ModelFlow Alembic migration Job
- one-shot MLflow database migration Job
- Ingress, TLS reference, Services, health probes, and PodDisruptionBudgets

The chart intentionally does **not** deploy PostgreSQL or MinIO.

Production HA therefore requires operators to provide:

1. shared/external PostgreSQL reachable by every backend/worker/MLflow pod
2. shared S3-compatible object storage reachable by every backend/worker/inference/MLflow pod
3. a registry containing the ModelFlow backend, frontend, and MLflow images
4. an existing Kubernetes Secret containing runtime credentials
5. an Ingress controller and TLS Secret/cert-manager flow when public ingress is enabled

Multiple ModelFlow replicas do not make a single embedded database or object store HA.

## Images

Build and push the existing repository images to the target registry:

- backend image: `backend/Dockerfile`
- frontend image: `frontend/Dockerfile`
- MLflow image: `infra/mlflow/Dockerfile`

Override `images.*.repository` and either:

- set an immutable image tag in `images.*.tag`, or
- preferably set `images.*.digest` to an immutable `sha256:...` digest

When `digest` is set, the chart renders `repository@digest`; otherwise it
renders `repository:tag`.

## Runtime Secret contract

The chart never creates or embeds secret values. Pre-create the Secret named by
`secret.existingSecret` (default: `model-flow-runtime-secrets`).

Default required keys:

| Secret key | Consumer |
|---|---|
| `database-url` | backend, workers, migration Job |
| `mlflow-database-url` | MLflow server |
| `object-store-access-key` | backend, workers, inference runtime, MLflow |
| `object-store-secret-key` | backend, workers, inference runtime, MLflow |
| `jwt-signing-key` | backend |
| `encryption-key` | backend, workers |
| `inference-service-token` | backend, workers, inference runtime |

Conditional keys are enabled by setting their key names in values:

- `secret.keys.bootstrapAdminPassword` — required for the first bootstrap on an empty user database; remove the value/key after bootstrap succeeds
- `secret.keys.oidcClientSecret`
- `secret.keys.llmApiKey`

ModelFlow application pods mount service-scoped projections of the Secret
read-only under `/run/model-flow-secrets` and consume them through the Phase
8-D `*_FILE` contract. The inference runtime receives only the object-store
credential pair plus the inference service token; the migration Job receives
only the application database URL. Workers receive only their DB/object-store,
encryption, and inference credentials. MLflow is a third-party process and
consumes the object-store credentials plus its database URI through Kubernetes
`secretKeyRef`.

Example creation from operator-managed local files:

```bash
kubectl -n model-flow create secret generic model-flow-runtime-secrets \
  --from-file=database-url=/secure/modelflow/database-url \
  --from-file=mlflow-database-url=/secure/modelflow/mlflow-database-url \
  --from-file=object-store-access-key=/secure/modelflow/object-store-access-key \
  --from-file=object-store-secret-key=/secure/modelflow/object-store-secret-key \
  --from-file=jwt-signing-key=/secure/modelflow/jwt-signing-key \
  --from-file=encryption-key=/secure/modelflow/encryption-key \
  --from-file=inference-service-token=/secure/modelflow/inference-service-token
```

External Secrets Operator, CSI Secret Store, Vault Agent/controller workflows, or
another secret-delivery system may create/update the same Secret instead.

Do not commit the Secret or decoded values to Git.

## PostgreSQL

`database-url` is the ModelFlow application database connection string.

`mlflow-database-url` is the MLflow backend-store connection string.

They may point to separate databases on the same HA PostgreSQL service or to
separate PostgreSQL services. Both must use durable shared storage and be
reachable from all relevant replicas.

The chart does not operate a PostgreSQL HA cluster.

## Object storage

Configure:

```yaml
external:
  objectStore:
    endpoint: s3.example.internal:443
    secure: true
    region: us-east-1
    buckets:
      datasets: datasets
      mlflow: mlflow
      batch: batch-results
      artifacts: artifacts
```

The endpoint is host[:port] without the URL scheme; `secure` selects HTTP vs
HTTPS. `region` is propagated consistently to ModelFlow's direct boto3 client
and MLflow artifact clients.

The credentials must permit the ModelFlow operations required for the configured
buckets. For least-privilege environments, pre-create the buckets and grant only
the necessary object/bucket permissions.

## Database migrations

Kubernetes backend replicas do **not** run `alembic upgrade head` during
startup.

Instead, the chart renders a dedicated ModelFlow migration Job:

```text
<release>-model-flow-migration
```

It is a Helm `pre-install,pre-upgrade` hook and executes:

```text
alembic upgrade head
```

The Job uses the same backend image and `DATABASE_URL_FILE` secret contract.
A failed migration blocks the Helm install/upgrade before new backend replicas
roll out. This avoids concurrent Alembic upgrades from multiple backend pods.

MLflow has its own SQL schema lifecycle. The chart therefore renders a second
hook Job:

```text
<release>-model-flow-mlflow-migration
```

using the MLflow image and only the `mlflow-database-url` Secret key. It runs:

```text
mlflow db upgrade "$MLFLOW_BACKEND_STORE_URI"
```

before MLflow replicas roll out. This keeps MLflow schema upgrades out of
multi-replica server startup.

## Backend bootstrap under multiple replicas

Each backend still checks whether an initial administrator must be created.
Phase 8-E makes the unique-email race idempotent: when two fresh backend replicas
race, the replica that loses the unique insert re-reads the committed admin row
and continues startup instead of failing.

For a fresh empty user database, temporarily configure:

```yaml
secret:
  keys:
    bootstrapAdminPassword: bootstrap-admin-password
```

and provide that key in the existing Secret. After the administrator is created
and the password is changed, set `bootstrapAdminPassword: ""` on a later upgrade
and remove the stale Secret key. Existing installations with users can leave the
value empty from the start.

## Replicas and rollout safety

Default values use multiple replicas for:

- frontend: 2
- backend: 2
- inference runtime: 2
- general workers: 2
- MLflow: 2

The counts are configurable.

Frontend/backend/inference/MLflow use rolling updates with
`maxUnavailable: 0` and `maxSurge: 1`. General/GPU workers use bounded rolling
updates suitable for durable Postgres-backed job claiming.

PodDisruptionBudgets are rendered for multi-replica frontend, backend, inference
runtime, MLflow, and general workers.

For node/zone fault tolerance, production values should additionally set the
provided `affinity`, `nodeSelector`, and `tolerations` fields according to
the cluster topology. The chart does not claim zone-level HA merely from a
replica count.

## Health and readiness

The chart configures explicit probes:

| Component | Readiness / liveness |
|---|---|
| frontend | HTTP `/` |
| backend | readiness `/api/v1/ready` (database) / liveness `/api/health` |
| inference runtime | `/ready` / `/health` |
| workers | `python -m app.workers.healthcheck` |
| MLflow | HTTP `/health` with allowed Host header |

Only the frontend is intended for public Ingress.

Backend, inference runtime, and MLflow remain ClusterIP-only internal services.

## GPU worker profile

GPU workers are disabled by default:

```yaml
worker:
  gpu:
    enabled: false
```

When enabled, the GPU deployment uses `WORKER_PROFILE=gpu` and requests:

```yaml
nvidia.com/gpu: 1
```

in both requests and limits by default.

This does **not** make existing sklearn workloads GPU-accelerated. Phase 8-B
routing remains fail-closed: current general workloads are not silently moved to
GPU workers. Enable GPU workers only when a workload/profile that explicitly
supports them is introduced.

## Ingress and TLS

Ingress is disabled by default. Example:

```yaml
ingress:
  enabled: true
  className: nginx
  host: modelflow.example.com
  path: /
  tls:
    enabled: true
    secretName: modelflow-tls
```

The Ingress routes only to the frontend Service. The frontend's Kubernetes
Nginx ConfigMap proxies `/api/` to the release-scoped backend Service.

TLS certificate issuance is intentionally external to this chart. Supply an
existing TLS Secret or controller annotations for the cluster's certificate
workflow.

## OIDC and LLM configuration

Non-secret OIDC and LLM values live in Helm values.

When OIDC is enabled, set the OIDC client-secret Secret key name:

```yaml
secret:
  keys:
    oidcClientSecret: oidc-client-secret
```

For an authenticated LLM provider, set:

```yaml
secret:
  keys:
    llmApiKey: llm-api-key
```

The actual values remain in the existing Kubernetes Secret.

## Install

Create the namespace, Secret, external databases/buckets, and registry images
first. Then provide a production values file containing only non-secret
configuration and secret key names.

Example:

```bash
helm upgrade --install modelflow deploy/helm/model-flow \
  --namespace model-flow \
  --create-namespace \
  -f values-production.yaml \
  --wait \
  --timeout 15m
```

The migration hook must complete before the new release proceeds.

## Upgrade and rollback

Before an upgrade:

1. back up the application database according to the PostgreSQL operator policy
2. confirm the new backend image contains the expected Alembic migration head
3. verify image digests/tags and Secret references
4. run `helm lint` / `helm template` through CI

A Helm rollback can restore Deployment configuration/images, but it does not
automatically reverse database migrations. Database migration rollback must
follow the migration-specific recovery plan.

## Compose compatibility

Phase 8-E does not remove or alter the current Docker Compose + Traefik
deployment path.

Use:

- Compose/Traefik for the existing single-host deployment
- Helm/Kubernetes when stateless replica scaling and external shared state are
  required

Do not combine both deployment modes against the same production database unless
that topology has been intentionally designed and tested.

## CI validation

`scripts/test-kubernetes-helm.sh` runs without a Kubernetes cluster and checks:

- `helm lint`
- default manifest rendering
- Ingress/TLS rendering
- dedicated ModelFlow + MLflow migration Jobs
- file-mounted secret paths and service-scoped Secret projections
- configured object-store region and MLflow artifact bucket derivation
- component probes and PodDisruptionBudgets
- GPU resource isolation
- absence of embedded StatefulSet/PVC resources

PR infrastructure CI and post-merge full CI both execute this render gate.
