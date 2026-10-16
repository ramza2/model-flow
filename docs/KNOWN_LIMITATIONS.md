# Known limitations

Current known limitations for the published **ModelFlow v1.0.0 GA** release.

## Deployment and serving

- **Docker Compose** remains a supported local/self-hosted deployment mode. A single Compose stack is **not** high availability by itself.
- **Helm / Kubernetes** supports replicated **stateless** ModelFlow services. Real HA depends on **operator-managed external** PostgreSQL and S3-compatible object storage (not embedded single-node Postgres/MinIO state). See `docs/DEPLOYMENT_KUBERNETES.md` and D-048.
- Online and batch model execution run in a dedicated internal **`inference-runtime`** service (Phase 8-A). Backend and workers are control-plane clients. The runtime uses service-token auth and is **not** a public serving mesh.
- Compose publishes PostgreSQL, MinIO, MLflow, and API ports for local development. Do **not** expose that raw configuration to the public internet without TLS, network controls, and operational hardening.

## Identity

- Optional **OIDC** Authorization Code + PKCE SSO is supported (`MODELFLOW_OIDC_*`; disabled by default). Local JWT + bcrypt login remains available (including bootstrap / break-glass).
- **LDAP** is not supported.

## Training and runtime product boundaries

- Sklearn **tabular** classification/regression focus; no vision/audio/LLM-specialized training productization.
- **No GPU / distributed training** productization. Worker `gpu` profiles are routing/capability infrastructure only; shipped sklearn workloads do not become GPU workloads automatically.
- Visual pipeline engine is a **DB-worker DAG**, not Airflow/Prefect.
- Soft-deleted projects/users are hidden; hard purge follows retention settings (D-023).
- Inference payloads are not stored by default (`store_inference_payloads=false`; D-024).
- Automation / closed-loop retrain **never auto-promotes** models to PRODUCTION (stops at CANDIDATE; D-025).

## Deferred or constrained capabilities

- Recursive forecasting, panel/entity features, and walk-forward cross-validation remain deferred (Phase 6 outs).
- Visual data preparation executes with **Pandas in-memory** only (no Spark/Dask/distributed/chunked processing).
- If an artifact upload to object storage succeeds but the final DB commit fails, an orphaned object may require cleanup/reconciliation.
- Non-blocking frontend debt: Pipeline Run lifecycle summary and historical Run Detail can maintain independent active-run polling loops while a run is active.

## Dependency security gate

Local `./scripts/verify.sh` and GitHub Actions run the same dependency checks:

1. `pip-audit` against `backend/requirements.txt`
2. Frontend `npm audit`
3. E2E package `npm audit`

`scripts/check-security-audits.py` **fails the gate** when High or Critical findings are present unless each finding is listed in `security/allowlist.json` with package, vulnerability id, reason, and ISO expiry. Scanner/schema failures also fail the gate (fail closed). This is **not** an informational-only scan.

The verify gate runs `npm audit` in **`node:24.8-alpine`** (npm 11.x, audit step only) so reports use the registry **bulk advisory** endpoint. Frontend lint/typecheck/test still use `node:22.17-alpine`. The legacy `/security/audits/quick` endpoint was retired and returns 4xx; npm 10 falls back to it when bulk responses fail. Audit calls retry (up to 5 attempts with backoff) when the registry returns a transient error (for example bulk advisory 503) or a JSON body without `vulnerabilities{}`. GitHub Actions CI timeout for the full gate is **90 minutes**.

## Operational notes

- Rate limit defaults to 120/min; `init-env.sh --non-interactive-test` raises it for CI/verify volume.
- Logout increments `token_version`, invalidating tokens on all devices for that user (D-029).
- PostgreSQL data sources support Host/Port fields or Connection URL/DSN mode; secrets (`password`, `dsn`, `url`) are encrypted and never returned in API responses (`connection_mode` is non-sensitive metadata only; D-034).
