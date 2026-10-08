# Phase 8 — Enterprise / Scale

Phase 8 evolves ModelFlow from a single-host self-managed deployment into a scale-ready enterprise architecture while preserving the existing public API, RBAC, audit, lifecycle, and reproducibility contracts.

The baseline entering Phase 8 is:

```text
main@93b8878971d69a926c8f1dc93c02bad04665f4b1
Phase 7 closeout PR #74
post-merge main CI #358 / run 37559456232 SUCCESS
Alembic head 023_forecasting_training
```

## Why this order

The current production shape is intentionally simple:

```text
frontend → backend FastAPI → Postgres / MLflow / MinIO
                    └──────→ in-process online model cache/predict
worker ────────────────────→ training / pipeline / batch / import / quality / drift
```

Online inference currently executes in the API process, workers share one broad runner role, authentication is local JWT/password based, production secrets are environment-driven, and production deployment is Docker Compose + Traefik.

Kubernetes or HA should not be layered on top of those couplings first. Phase 8 therefore separates stateless runtimes and execution roles before introducing enterprise identity, external secret injection, and multi-replica orchestration.

## Slice plan

| Slice | Scope | Status |
|-------|-------|--------|
| **8-A** | Inference Runtime Separation | **complete** (PR #76; `933ce3dc2b47fb50aaa28d3e727d6b827d26a38c`; post-merge CI #363 PASS) |
| **8-B** | Worker Scale-out & Runner Profiles | **complete** (PR #79; `4ad6f908acd1ad5b0512b7e6e0933ac8c34d1e37`; post-merge CI #373 PASS) |
| **8-C** | Enterprise Identity — OIDC / SSO | planned |
| **8-D** | External Secret Management | planned |
| **8-E** | Kubernetes / HA Deployment | planned |
| **8-F** | Final Hardening / Scale Regression | planned |

```text
8-A Inference Runtime Separation
    ↓
8-B Worker Scale-out & Runner Profiles
    ↓
8-C OIDC / SSO
    ↓
8-D External Secret Management
    ↓
8-E Kubernetes / HA
    ↓
8-F Final Hardening / Scale Regression
```

Phase 8 is a sequence of reviewable slices. A later slice must not be pulled into an earlier PR merely because the target architecture mentions it.

## Phase-wide invariants

1. **Public API compatibility first.** Existing frontend/API routes, auth semantics, project RBAC, audit events, Endpoint lifecycle, prediction payload/response shape, lineage, and model lifecycle remain compatible unless a slice explicitly versions a contract.
2. **Control plane remains authoritative.** The backend owns user/project authorization, lifecycle transitions, audit, prediction observations/statistics, and durable metadata. Scale-out runtimes must not become alternate governance paths.
3. **Internal services are not public APIs.** Inference and worker-internal interfaces stay on private networks and use explicit service authentication where an HTTP/RPC boundary exists.
4. **Stateless services may replicate; stateful HA is not implied.** PostgreSQL, object storage, and MLflow state require shared/external durable services for real HA. Phase 8 must not label single-instance embedded state as HA.
5. **Compose remains supported.** Local development and the current Traefik deployment path stay valid while Kubernetes is added as an additional deployment target.
6. **Secrets never move into code, images, logs, API responses, audit summaries, or checked-in manifests.**
7. **GPU profiles do not invent GPU acceleration.** Existing sklearn workloads keep their current semantics. GPU runner capability/routing is infrastructure foundation for workloads that explicitly support it.
8. **No Phase 9 redesign.** Enterprise UX additions must use the existing design system and routes.

---

## 8-A — Inference Runtime Separation

### Goal

Move model execution out of the FastAPI API process and out of batch-worker model execution into a dedicated internal inference runtime while preserving the current public Endpoint and prediction contracts.

Current coupling:

- `backend/app/api/v1/endpoints.py` calls `app.services.inference.load_model()/predict()` directly.
- `app.services.inference` owns an in-process model cache.
- batch inference is orchestrated by the worker and currently shares inference implementation in the same application image/process family.

Target boundary:

```text
Client
  ↓
Frontend / public API
  ↓
Backend control plane
  ├─ auth / RBAC / Endpoint lifecycle
  ├─ request validation / audit
  ├─ InferenceStat / PredictionObservation
  └─ internal authenticated call
         ↓
   Inference Runtime
   ├─ model loading/cache
   ├─ prediction feature coercion
   ├─ MLflow artifact access
   └─ no public ingress / no ModelFlow user auth

Batch Worker
  ├─ job state / dataset read / result materialization
  └─ bounded internal inference calls → Inference Runtime
```

### 8-A acceptance boundary

- Add an internal `inference-runtime` service with health/readiness checks.
- Runtime has no direct dependency on ModelFlow user/session/RBAC tables. Keep DB ownership in the backend/worker control plane unless a concrete implementation reason is documented.
- Public prediction routes and response shapes stay unchanged.
- Endpoint create/start/swap/rollback verify model loadability through the runtime rather than loading the model into the API process.
- Online prediction uses the runtime; durable request statistics/observations continue to be recorded by the backend.
- Batch prediction keeps asynchronous job orchestration and result storage in the worker but delegates actual model execution to the runtime in bounded batches/chunks.
- Runtime cache is keyed by immutable model identity/URI; replicas may warm independently.
- Internal runtime requests require a server-owned service credential and are never exposed through frontend state or public API responses.
- Compose/Traefik exposes only the existing public frontend; the inference runtime remains internal.
- Failure mapping is sanitized and deterministic; runtime implementation detail must not leak secrets or internal URLs.
- Existing Endpoint RBAC/audit, output-target naming, schema validation, multi-output, forecasting, monitoring, and batch result semantics remain regression-critical.

### Explicitly out of 8-A

OIDC/SSO, Kubernetes, autoscaling, GPU scheduling, external secret manager SDKs, new model algorithms, new public serving protocol, gRPC migration, Phase 9 UI redesign.

### 8-A completion evidence

Internal boundary delivered in the 8-A Draft PR:

```text
backend / worker
  └─ app.services.inference_client  (MODELFLOW_INFERENCE_SERVICE_TOKEN)
         ↓ HTTP (Compose network only)
   inference-runtime :8080
  ├─ GET  /health, /ready
  ├─ POST /v1/models/load-check
  └─ POST /v1/models/predict
         ↓
   app.services.inference (load/cache/normalize/predict)
```

- Compose service `inference-runtime` has no host port publish and no Traefik labels.
- Public Endpoint routes, RBAC, audit, `PredictionObservation`, and `InferenceStat` remain in the backend.
- Batch inference chunks feature rows (`MODELFLOW_INFERENCE_BATCH_CHUNK_SIZE`, default `256`) and preserves row order.
- PR #76 exact final HEAD `6ed6a964d20d11c06d4cd67d30697150f09b25ca`; exact-head CI #362 / run `37572306127` PASS.
- Squash merge to `main`: `933ce3dc2b47fb50aaa28d3e727d6b827d26a38c`.
- Post-merge `main` CI #363 / run `37574052970` PASS.
- Alembic head remains `023_forecasting_training`; no migration.
- Final security hardening disables ambient HTTP(S)/ALL proxy inheritance on the internal inference client (`trust_env=False`).

---

## 8-B — Worker Scale-out & Runner Profiles

### Goal

Make the existing Postgres-backed execution model safe and observable with multiple worker replicas, then add explicit runner capability profiles without changing current model/training semantics.

### Required scope

- Unique worker identity per replica; no shared `WORKER_ID=default` heartbeat collision in scaled deployment.
- Preserve atomic claims with `FOR UPDATE SKIP LOCKED`; add multi-worker regression proving one durable job is not double-executed.
- Define worker capability/profile metadata, at minimum a default/general CPU profile and an optional GPU-capable profile.
- Jobs that do not request a special profile remain runnable by the default profile exactly as today.
- Do not route sklearn work to GPU merely because a GPU worker exists.
- Ensure scheduler/maintenance singleton behavior is safe with multiple workers. Use a DB-backed leader/advisory-lock or equivalent deterministic mechanism instead of assuming one worker process.
- Keep retry, stale-job recovery, pipeline parallelism, scheduling history, lineage, and audit semantics intact.
- Expose enough worker identity/profile/heartbeat information for operational diagnosis without leaking secrets.

### Explicitly out of 8-B

New CUDA algorithms, distributed training frameworks, Ray/Spark adoption, Kubernetes autoscaling implementation, queue-system replacement, Kafka/Redis requirement.

### Completion evidence

- Worker identity: explicit `WORKER_ID` / `MODELFLOW_WORKER_ID`, else container hostname (`resolve_worker_id()` shared by runner + healthcheck). Compose no longer pins `WORKER_ID: default`.
- Profiles: `WORKER_PROFILE=general|gpu` with capabilities `cpu` / `cpu,gpu`. All current workloads require `general`; mismatch and unknown profiles fail closed (GPU workers do not claim sklearn/general jobs).
- Heartbeat `status_json` records profile, capabilities, `max_concurrent_jobs`, `git_sha` (no secrets).
- Scheduler / stale-recovery / cancel-honor run only while holding a Postgres session advisory lock (`SCHEDULER_MAINTENANCE_LOCK_KEY`); non-leaders continue normal job claims.
- Compose verification: `scripts/verify-worker-scale.sh` (`--scale worker=2`) is part of `./scripts/verify.sh`.

Final verification:

- PR #79 final HEAD: `30482b854f198f4a7fdaf12019b611521328feec`
- exact-head PR Fast Gate: #372 / run `37730164986` PASS
- squash merge to `main`: `4ad6f908acd1ad5b0512b7e6e0933ac8c34d1e37`
- post-merge Full Gate: #373 / run `37734775244` PASS
- Alembic head remains `023_forecasting_training`; no migration
- Dataset Preparation special claim path is profile-gated, so GPU workers cannot claim any current general workload


---

## 8-C — Enterprise Identity — OIDC / SSO

### Goal

Add standards-based enterprise sign-in without replacing ModelFlow's existing authorization model.

### Required scope

- OIDC Authorization Code flow with PKCE.
- Stable external identity binding by issuer + subject; email alone must not be the durable identity key.
- Successful OIDC authentication maps to a ModelFlow user and then uses the existing ModelFlow project membership/RBAC model.
- No automatic SYSTEM_ADMIN grant from arbitrary IdP claims.
- Existing local login remains available for bootstrap/break-glass administration unless a later explicit policy disables it.
- ModelFlow may continue issuing its own API access token after successful OIDC login so existing API authorization paths remain stable.
- Login/logout/failure/provider-link events are audited with secrets/tokens redacted.
- Provider discovery/JWKS validation is fail-closed.
- Frontend SSO entry follows the existing auth UX; no product-wide redesign.

### Explicitly out of 8-C

SAML, SCIM provisioning, automatic group-to-project-role synchronization, multi-IdP brokering, IdP administration console redesign.

---

## 8-D — External Secret Management

### Goal

Allow production secrets to be supplied by an external secret delivery mechanism without hard-coding vendor-specific secret APIs into business logic.

### Required scope

- Introduce a single settings/secret-loading boundary that supports current environment variables and file-mounted secret values.
- File-mounted secret support must work with Docker/Kubernetes secrets, CSI-mounted values, Vault Agent style files, and External Secrets Operator outputs without a vendor SDK in ModelFlow core.
- Cover at least JWT signing key, Fernet encryption key, internal service credential, database credentials, MinIO/object-store credentials, OIDC client secret, and optional LLM provider key.
- Secret precedence and missing-secret failures must be deterministic and documented.
- Secret values never appear in rendered configuration diagnostics, logs, audit, API responses, frontend state, or committed manifests.
- Local `.env` development remains supported.
- Key rotation procedures are documented. Multi-key online re-encryption is separate scope unless required by implementation.

### Explicitly out of 8-D

A mandatory Vault/AWS/GCP/Azure SDK, storing secrets in the application DB, silently generating production secrets on startup.

---

## 8-E — Kubernetes / HA Deployment

### Goal

Add a production-oriented Kubernetes deployment path for the now-separated stateless services.

### Required scope

- Deploy frontend, backend control plane, inference runtime, worker profiles, and MLflow-facing stateless components with explicit health/readiness probes.
- Database migration runs as a dedicated one-shot deployment job; do not run concurrent Alembic upgrades in every backend replica.
- Support multiple backend and inference replicas.
- Support multiple worker replicas and profile-specific worker deployments.
- Provide ingress/TLS configuration without requiring the existing Compose Traefik topology.
- Support external/shared PostgreSQL and S3-compatible object storage; document these as prerequisites for actual HA.
- Do not claim HA when using a single embedded PostgreSQL/MinIO instance.
- Include pod disruption / rolling update safety and configurable resource requests/limits.
- GPU worker deployment exposes the appropriate Kubernetes GPU resource request only for GPU-capable profiles.
- Keep Docker Compose + Traefik as a supported non-Kubernetes deployment mode.
- CI validation must render/lint deployment configuration without requiring a paid cloud cluster.

### Explicitly out of 8-E

Operating a production PostgreSQL HA cluster inside ModelFlow, building an object-storage distributed system, service mesh requirement, multi-region active-active, Phase 9 redesign.

---

## 8-F — Final Hardening / Scale Regression

### Goal

Close Phase 8 with failure, concurrency, security, and deployment regression rather than new enterprise features.

### Required coverage

- multi-replica inference consistency and failure recovery
- multi-worker no-double-claim regression
- scheduler singleton behavior under multiple workers
- runner-profile routing/fail-closed behavior
- OIDC happy/failure/token-validation paths and local break-glass regression
- secret redaction and file-secret precedence regression
- migration-job / multi-backend startup safety
- Kubernetes manifest/chart render checks
- internal-service network/auth boundary
- public API compatibility and representative browser regression
- Compose + Traefik regression
- full `./scripts/verify.sh` and exact PR HEAD CI

Phase 8 is marked complete only after 8-F merges and post-merge `main` verification passes.

## Next implementation slice

**8-A — Inference Runtime Separation and 8-B — Worker Scale-out & Runner Profiles are complete on `main`.** The next implementation slice is **8-C — Enterprise Identity — OIDC / SSO**. Start 8-C from the then-current `main`; do not pull 8-D+ scope into the 8-C PR.
