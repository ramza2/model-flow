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
- **Follow-up (2026-09):** MinIO server/client images are pulled from `quay.io/minio/*` (same release tags). Docker Hub `minio/minio` / `minio/mc` repositories no longer allow anonymous pulls.

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

## D-035: Training consumes one pinned materialized DatasetVersion

- **Context:** Phase 2 multi-dataset flows (Join/Union and later transforms) produce training-ready tables. TrainingJob historically pins a single `dataset_id` + `dataset_version_id`. Expanding TrainingJob to accept many raw datasets would duplicate Preparation concerns and weaken reproducibility.
- **Choice:** Multi-dataset composition belongs to Dataset Preparation. TrainingJob continues to consume exactly one rectangular materialized DatasetVersion (including Parquet outputs from Preparation). Reproducibility is guaranteed by pinning `dataset_version_id`; upstream multi-dataset lineage is traced via DatasetVersion lineage, not via TrainingJob multi-input tables.
- **Consequences:** No TrainingJob many-to-many input table or migration for Phase 2-D. Frontend handoffs (`Train this result`, Dataset Detail train, Job Create query params) must pass the exact prepared version id and must not silently retarget latest. Pivot / Unpivot remain separate Phase 2 work (Group By is Phase 2-E).

## D-036: Group By uses explicit aliases and SQL-like null/count semantics

- **Context:** Dataset Preparation Group By must produce a stable rectangular schema for Preview, full materialization, and downstream TrainingJob consumption without inventing COUNT(*) / window / custom expression surface area.
- **Choice:** `group_by` requires one or more grouping columns and one or more aggregations with explicit `output` aliases. Execution uses Pandas `groupby(..., dropna=False, sort=False)`. Supported ops are `sum`, `avg` (mean), `min`, `max`, and `count` (non-null values of the named column). SUM/AVG reject non-numeric and boolean columns. Result column order is group keys (config order) then aggregation outputs (config order). Preview that includes Group By on the target ancestor path warns that aggregates are sample-derived.
- **Consequences:** Graph `schema_version` stays `1` with no DB migration. Group By outputs remain ordinary Preparation-produced Parquet DatasetVersions; TrainingJob does not special-case Group By. Pivot remains Phase 2-F2; Unpivot is Phase 2-F1.

## D-037: Unpivot uses explicit identifier/value columns and deterministic wide-to-long semantics

- **Context:** Dataset Preparation needs a Wide → Long reshape that stays explicit, deterministic, and compatible with Preview plus full materialization without inventing automatic non-ID melt, regex column selection, or drop-null options.
- **Choice:** `unpivot` takes explicit `id_columns` (optional, including empty) and `value_columns` (one or more), plus `variable_column` / `value_column` output aliases. Only listed identifier and value columns participate; other source columns are omitted. Null cells still produce output rows. Output schema is `id_columns + [variable_column, value_column]`. Row order follows `value_columns` config order, then input row order within each value column. Heterogeneous value dtypes follow Pandas common-dtype melt semantics (no forced cast). Alias collisions with melt source names are handled via temporary safe names then rename so Pandas internals do not constrain the graph contract. Preview reshapes stored DatasetVersion sample rows; full Run materialization is the authoritative result.
- **Consequences:** Graph `schema_version` stays `1` with no DB migration. Unpivot outputs remain ordinary Preparation-produced Parquet DatasetVersions; TrainingJob does not special-case Unpivot. Pivot stays Phase 2-F2.

## D-038: Pivot uses explicit pivot values and output aliases for stable schemas

- **Context:** Dataset Preparation Pivot (long → wide) must keep Preview and Full Run schemas identical even though Preview only sees sampled source rows. Automatic distinct-value discovery would let sample coverage change output columns between Preview and Full Run.
- **Choice:** `pivot` requires explicit `index_columns` (one or more), one `columns_column`, one `value_column`, one Group By aggregation (`sum` / `avg` / `min` / `max` / `count`), and an ordered `pivot_values` list of `{value, output}` pairs. Output schema is exactly `index_columns + pivot_values[].output` in config order. Pivot values are not auto-discovered from data; unlisted or null `columns_column` values are ignored; configured-but-absent combinations remain null. Null index groups are retained (`dropna=False`) and index rows follow first-seen input order. Preview that includes Pivot on the target ancestor path warns that aggregates are sample-derived; Full Run materialization is authoritative. Optional frontend `value_type` metadata does not change backend execution semantics.
- **Consequences:** Graph `schema_version` stays `1` with no DB migration. Pivot outputs remain ordinary Preparation-produced Parquet DatasetVersions; TrainingJob does not special-case Pivot. Phase 2-F is complete only after this Pivot slice merges; Phase 2-G covers final hardening / end-to-end regression.


## D-039: Data sources use connector contracts; REST API imports are GET-only JSON materialization

- **Context:** PostgreSQL connection, discovery, and import logic was split between API and worker code. Adding MySQL, SQL Server, Oracle, and REST independently would duplicate connection/testing/import behavior and make secret handling inconsistent.
- **Choice:** Phase 4 introduces a connector registry with one source contract for connection testing, optional schema/table discovery, preview, and DataFrame reads. Existing PostgreSQL behavior moves behind that contract without changing its API surface. REST API sources use HTTP(S) GET only, accept JSON objects or arrays of objects (optionally selected through an explicit dot-path), and materialize through the existing DataImportJob → immutable DatasetVersion flow. REST authentication supports none, Bearer token, or a configured API-key header; credential values remain encrypted secrets and are never returned by data-source APIs. Phase 4-A does not add POST/PUT/PATCH execution, arbitrary code, automatic pagination, or streaming ingestion.
- **Consequences:** Later SQL connectors can reuse lifecycle/import orchestration instead of copying it. REST imports are deterministic for one configured request/response and remain bounded by connector timeout and response-size limits. APIs requiring pagination or mutation need an explicit later design rather than hidden connector behavior.

## D-040: MySQL and MariaDB share one `mysql` source type on SQLAlchemy + PyMySQL

- **Context:** Phase 4-B adds relational connectors for MySQL and MariaDB after the Phase 4-A registry. Duplicating PostgresConnector wholesale would fight Phase 4-C/4-D sharing, while inventing a large generic framework would risk PostgreSQL regressions.
- **Choice:** Introduce `SqlAlchemyRelationalConnector` helpers for truly shared behavior (quoting, read-only SELECT/WITH validation, inspector discovery, preview/read). Keep PostgreSQL and MySQL concrete connectors for driver URL, default port, connect args, and dialect-specific read-only transaction statements. PostgreSQL begins a transaction then issues `SET TRANSACTION READ ONLY`. MySQL/MariaDB start the import transaction with `START TRANSACTION READ ONLY` under AUTOCOMMIT so the active transaction itself is read-only (in-transaction `SET SESSION TRANSACTION READ ONLY` is insufficient). Use one `DataSourceType.mysql` with UI label “MySQL / MariaDB”, driver `mysql+pymysql` (PyMySQL), default port 3306, and the same Host/Port + encrypted DSN/URL `connection_mode` semantics as PostgreSQL. Disposable Compose fixtures `mysql:8.4.5` and `mariadb:11.4.5` both exercise the shared connector. No separate `mariadb` enum.
- **Consequences:** SQL Server and Oracle can reuse the relational helper without inheriting MySQL transaction quirks. PostgreSQL DSN values remain stored/returned as provided; MySQL normalizes bare `mysql://` / `mariadb://` URLs to the PyMySQL SQLAlchemy dialect. Import validation also rejects SELECT side-effect forms (`INTO OUTFILE` / `INTO DUMPFILE` / `FOR UPDATE` / `LOCK IN SHARE MODE`) after stripping literals/comments. CDC, binlog, incremental sync, SSH tunnels, stored procedures, and write-back stay out of scope.

