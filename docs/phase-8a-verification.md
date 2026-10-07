# Phase 8-A Verification — Inference Runtime Separation

Phase 8-A is complete on `main`.

## Baseline

- implementation PR: #76
- final PR HEAD: `6ed6a964d20d11c06d4cd67d30697150f09b25ca`
- exact-head CI: #362 / run `37572306127` — PASS
- squash/main commit: `933ce3dc2b47fb50aaa28d3e727d6b827d26a38c`
- post-merge main CI: #363 / run `37574052970` — PASS
- Alembic head: `023_forecasting_training`
- migration: none

## Delivered boundary

- dedicated internal FastAPI `inference-runtime`
- internal health/readiness plus authenticated model load-check and predict operations
- backend, worker batch, pipeline deployment/batch, and registry gate paths delegate model execution through `app.services.inference_client`
- model load/cache/schema normalization/prediction core remains centralized in `app.services.inference` inside the runtime
- public Endpoint API, RBAC, audit, `InferenceStat`, `PredictionObservation`, counters, latency/p95, and output naming remain control-plane responsibilities
- batch inference uses bounded chunks with default size 256 and preserves row order
- runtime is Compose-internal only; no host port or Traefik ingress
- runtime receives MLflow/object-store access plus a dedicated service token, not ModelFlow user JWT/bootstrap credentials/application DB credentials
- internal inference client uses `trust_env=False` so ambient HTTP(S)/ALL proxy settings cannot route service-token traffic through an environment proxy

## Verification

Implementation branch verification reported:

- targeted inference runtime/client/Endpoint regressions: PASS
- final proxy-hardening targeted suite: `tests/test_inference_runtime.py` — 11 passed
- `./scripts/verify.sh`: PASS
- backend tests: 632 passed at the implementation verification baseline
- frontend tests: 368 passed
- online inference: PASS through the Compose runtime
- batch inference: PASS through the Compose runtime
- Playwright: PASS
- exact PR HEAD GitHub Actions: PASS
- post-merge `main` GitHub Actions: PASS

## Security / lifecycle checks

- no direct control-plane `inference.load_model()` / `inference.predict()` execution retained in the guarded backend/worker paths
- internal runtime credential is server-owned and separate from user JWT signing
- runtime error mapping does not expose service token or internal runtime URL
- environment proxy trust disabled for internal runtime calls
- inference runtime is not a new public API

## Scope retained for later Phase 8 slices

Not included in 8-A:

- worker scale-out / runner profiles
- scheduler singleton coordination
- GPU scheduling
- OIDC / SSO
- external secret management
- Kubernetes / HA
- autoscaling
- gRPC
- new ML algorithms
- Phase 9 visual redesign

The next implementation slice is **8-B — Worker Scale-out & Runner Profiles**.
