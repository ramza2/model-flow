# Architecture & Product Decisions

Format: Decision — Context — Choice — Consequences.

## D-001: Authentication deferred in MVP → superseded by D-018

- **Context:** Local Compose trust boundary; auth delayed the MLOps loop for MVP.
- **Choice (MVP):** Open API/UI.
- **Consequences:** Not safe on public networks. **v1.0 replaces with JWT + RBAC (D-018).**

## D-002: DB-backed job queue instead of Airflow

- **Context:** Airflow excluded from MVP and v1.0.
- **Choice:** Domain job tables + worker poll with `FOR UPDATE SKIP LOCKED`.
- **Consequences:** Simple, replaceable via `TrainingRunner` / `PipelineExecutor` protocols.

## D-003: Separate Postgres databases for app and MLflow

- **Context:** Avoid schema collisions.
- **Choice:** `modelflow` and `mlflow` databases on one Postgres service.
- **Consequences:** One service to operate; clear separation.

## D-004: MinIO for datasets and MLflow artifacts

- **Context:** Need S3-compatible storage without cloud spend.
- **Choice:** Single MinIO with buckets `datasets`, `mlflow`, `batch-results`, `artifacts`.
- **Consequences:** Local object-store credentials are generated into an ignored `.env`.

## D-005: Sklearn trainers for tabular clf/reg

- **Context:** Need reliable sample models without GPU.
- **Choice:** Classification: LogisticRegression, RandomForestClassifier, GradientBoostingClassifier. Regression: Ridge, RandomForestRegressor, GradientBoostingRegressor.
- **Consequences:** Tabular only in v1.0; protocol allows future frameworks.

## D-006: Inference in backend process

- **Context:** Avoid separate model-serving mesh.
- **Choice:** FastAPI loads pyfunc/sklearn model from MLflow URI; in-memory cache per endpoint.
- **Consequences:** Single-node only; fine for Compose self-host.

## D-007: Frontend served as static build behind nginx in Compose

- **Context:** Predictable ports and production-like assets.
- **Choice:** Vite build + nginx; `/api` proxied to backend.
- **Consequences:** Rebuild image for UI changes in Compose; local `npm run dev` for hot reload.

## D-008: MLflow experiment name = `project-{id}`

- **Context:** Map projects to MLflow experiments.
- **Choice:** Auto-create experiment per project.
- **Consequences:** Clear isolation per project.

## D-010: MinIO image tags (superseded by D-016)

Historical; see D-016.

## D-011: Dataset object keys include UUID

- **Context:** Re-uploading reused keys and overwrote objects.
- **Choice:** `project-{id}/{dataset_id}/v{version}/{uuid}/{original_filename}`; original name in metadata.
- **Consequences:** Object storage grows with each version; training reads version-specific key.

## D-012: Endpoint readiness requires model load

- **Context:** Endpoints could be marked ready when load failed.
- **Choice:** Load before Ready; create fails closed.
- **Consequences:** Slightly slower create path.

## D-013: Project-scoped ownership checks

- **Context:** Cross-project binding attacks.
- **Choice:** Membership + project_id FK checks on every resource API; MLflow naming conventions retained as defense in depth.
- **Consequences:** Hard isolation at API layer.

## D-014: Worker heartbeat healthcheck

- **Choice:** Worker writes `worker_heartbeats.last_seen_at`; healthcheck fails if age exceeds threshold.
- **Consequences:** Requires heartbeat table; start_period allows first beat.

## D-015: verify.sh runs tests in containers

- **Choice:** Frontend via pinned Node image; E2E via Playwright image; JSON via python:3.11-slim. Host: Docker, Compose, curl, bash.
- **Consequences:** First verify pull slower; no host Node/Python required.

## D-016: Pin external Docker images to pull-verified tags

- **Choice:** Pin MinIO/mc/Postgres/Node/nginx/Playwright/MLflow/Python tags after pull verification. See compose + verify.sh.
- **Consequences:** Re-verify before upgrades; never invent unverified tags.

## D-017: GitHub Actions CI runs the same verify.sh gate

- **Choice:** `.github/workflows/ci.yml` on PR→main, push→main, workflow_dispatch; concurrency; least privilege; 60m timeout; failure artifacts.
- **Consequences:** CI duration tracks full stack.

## D-018: JWT access tokens + bcrypt passwords (v1.0)

- **Context:** v1.0 requires real multi-user auth without SSO/LDAP.
- **Choice:** bcrypt password hashes; JWT Bearer access tokens (HS256) with configurable expiry and per-user token versions. Bootstrap admin via env vars only.
- **Consequences:** Stateless auth suitable for Compose; password changes, logout, or rotating `MODELFLOW_SECRET_KEY` invalidate tokens.

## D-019: Project roles as membership enum

- **Context:** Need SYSTEM_ADMIN plus project-scoped roles.
- **Choice:** `users.is_system_admin` for SYSTEM_ADMIN; `project_memberships.role` ∈ {PROJECT_ADMIN, ML_ENGINEER, DATA_SCIENTIST, VIEWER}.
- **Consequences:** Simple permission matrix in code; no external IAM.

## D-020: Fernet encryption for data-source secrets

- **Context:** Postgres passwords must not be stored or returned in plaintext.
- **Choice:** Encrypt with Fernet using `MODELFLOW_ENCRYPTION_KEY` (url-safe base64 32-byte key).
- **Consequences:** Key rotation requires re-encrypt migration; never log decrypted secrets.

## D-021: App-owned Model Registry workflow over raw MLflow UI

- **Context:** Need approval states, gates, audit beyond MLflow stages.
- **Choice:** `model_versions` table with lifecycle + gate results; MLflow remains artifact/source of truth for model binary.
- **Consequences:** Dual write on register; promote does not auto-set MLflow stage unless configured.

## D-022: Visual pipelines via React Flow + DB DAG engine

- **Context:** Avoid Airflow/Prefect dependency.
- **Choice:** Frontend React Flow; backend stores graph JSON; worker executes topological schedule with parallel ready nodes.
- **Consequences:** Good enough for tabular DAGs; not a general workflow SaaS.

## D-023: Soft delete for projects/users; hard delete for ephemeral artifacts per retention

- **Context:** Need recovery vs storage control.
- **Choice:** Users/projects soft-delete (`deleted_at` / `is_active`). Batch results, training logs, inference stats purged by retention job/policy. Audit logs soft-immutable (append-only; purge only via retention).
- **Consequences:** Documented in README; admin UI exposes retention days.

## D-024: Default inference logging stores metadata only

- **Context:** Prediction inputs may be PII.
- **Choice:** Store count/latency/error class by default; raw payload optional via system setting `store_inference_payloads=false`.
- **Consequences:** Safer default; debugging may require temporary enable.

## D-025: Retrain never auto-promotes to PRODUCTION

- **Context:** Drift/retrain automation must not bypass approval.
- **Choice:** Auto-retrain creates candidate + evaluation + PENDING_APPROVAL; human approve required for PRODUCTION.
- **Consequences:** Safer ops; slightly more manual for demos.

## D-026: API versioning under `/api/v1`

- **Context:** Stable surface for clients and verify.sh.
- **Choice:** All app APIs under `/api/v1`; `/api/health` retained for Compose healthchecks.
- **Consequences:** Clients and scripts must use v1 paths.

## D-027: Login lockout after N failures

- **Context:** Brute-force defense without external WAF.
- **Choice:** Per-email counter; lock 15 minutes after 5 failures; audit failures without password.
- **Consequences:** Shared NAT may amplify lockouts; acceptable for self-host.

## D-028: Optional `postgres-source` Compose service for integration tests

- **Context:** Need real Postgres import tests without external SaaS.
- **Choice:** Secondary Postgres on port 5433 with sample `customers` table seeded.
- **Consequences:** Slightly heavier compose; only used when profile/tests enable it.

## D-029: Logout revokes all user tokens

- **Context:** Client-only logout leaves a copied bearer token valid until expiry.
- **Choice:** Logout increments `users.token_version`; token validation rejects every access token carrying an older version.
- **Consequences:** Logout signs the user out on all devices. This is acceptable for v1.0 self-host and avoids a token denylist.

## D-030: Runtime secrets come from an ignored generated environment file

- **Context:** Checked-in development credentials and permissive Compose defaults can escape into shared deployments.
- **Choice:** `scripts/init-env.sh` generates `.env` credentials and cryptographic keys; Compose uses required-variable expansion and the repository does not provide working secret defaults.
- **Consequences:** Operators must initialize `.env` before starting the stack and must back up or rotate its keys deliberately. CI generates isolated test credentials.

## D-031: Registry gates are computed and enforced on the server

- **Context:** Client-supplied gate results could bypass model approval policy.
- **Choice:** The backend computes gate outcomes from stored run/model evidence and persists the gate version and results. Approval and promotion reject missing or failed server-computed gates.
- **Consequences:** UI gate displays are advisory views of backend state; clients cannot promote a model by posting a passing result.

## D-032: Verification performs a destructive backup/restore round-trip

- **Context:** Checking that dump files exist does not prove PostgreSQL or MinIO can be restored.
- **Choice:** Near the end of `scripts/verify.sh`, create a marker project and object on the disposable verification stack, record metadata and checksum, back up both databases and all buckets, delete the markers, restore, and assert metadata, bytes, health, login, and prediction.
- **Consequences:** `scripts/restore.sh` replaces the application and MLflow databases and mirrors bucket contents. The round-trip must only run against the clean disposable stack created by the verification gate; application services are stopped and restarted during restore.

## D-033: High/Critical dependency findings fail closed with expiring exceptions

- **Context:** Advisory-only dependency scans allowed release verification to pass with serious known vulnerabilities.
- **Choice:** `pip-audit` and `npm audit` produce JSON artifacts for Python, frontend, and E2E dependencies; `scripts/check-security-audits.py` blocks unallowlisted High/Critical findings and treats scanner/schema failures as gate failures. Exceptions require package, vulnerability ID, reason, and ISO expiry in `security/allowlist.json`; expired entries never suppress.
- **Consequences:** Dependency updates or a time-bounded, reviewed exception are required to restore the gate. Because `pip-audit` currently omits severity, its findings are treated as High to fail closed.
- **Follow-up (2026-09):** Verify runs `npm audit` in pinned **`node:24.8-alpine`** (npm 11.x, audit step only) so reports use the registry bulk advisory API after retirement of `/security/audits/quick`. Invalid/unavailable audit JSON (including bulk advisory 503) is retried with backoff before fail-closed. CI job timeout is 90 minutes.

## D-034: PostgreSQL data-source connection mode metadata and explicit secret clears

- **Context:** Legacy Postgres sources may store encrypted `dsn`/`url` secrets. Typed Host/Port edit UI must not expose those values, and switching modes must not leave stale DSN/URL secrets that override typed config.
- **Choice:** API responses include non-sensitive `connection_mode` (`host_port` | `connection_url` | null). PATCH accepts `clear_secrets` for explicit removals; empty `secrets: {}` still means keep. Frontend Connection mode selector drives blank-keep vs clear semantics.
- **Consequences:** Name-only edits of DSN/URL sources work without secret disclosure; mode switches clear conflicting secret keys so `_connection_url()` matches the UI mode.
