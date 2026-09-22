# Phase 4-D Verification — Oracle Connector

Baseline: `main@e8c5af7db26affd29c312f3739fb4b76db366ad6`

## Provenance

- Phase 4-C PR #55 merged at `e8c5af7db26affd29c312f3739fb4b76db366ad6` (CI #268 PASS)
- AGENTS.md connector rules PR #53 at `9c92a4d8e692ef93188e3a880ae21da206a8b573` (CI #262 PASS)

## Scope

Phase 4-D adds `source_type=oracle` (UI: **Oracle Database**) on the existing connector registry and DataImportJob → immutable DatasetVersion path.

Out of scope: Instant Client / Thick mode, Oracle Wallet / Autonomous mTLS, TNS_ADMIN ops configs, SID typed UI, RAC/FAN, Kerberos/external auth, CDC, incremental sync, SSH tunnels, stored procedure execution, write-back.

## Driver / mode

- `oracledb==26.0.0` (install/import/connect verified with SQLAlchemy 2.0.36 / Python 3.11)
- Thin mode (python-oracledb default); no Instant Client in the backend image
- Dialect: `oracle+oracledb`

## Fixture

- Image: `gvenzl/oracle-free:23.26.3-slim-faststart`
- Digest: `sha256:f5ff19033860d662c821cb04eb10483fa94f14f78eae252d054291ea07028093`
- Service name: `FREEPDB1`
- Seeds `CUSTOMERS` under the APP schema and a SELECT-only reader account

## Connection

- Host/Port: host, port (1521), `service_name`, user, password
- Connection URL: `oracle://` / `oracle+oracledb://` only; bare `oracle://` → `oracle+oracledb://`
- URL requires explicit username and `service_name` query parameter
- Unsupported query keys / database-path SID forms are rejected without echoing secrets

## Read-only

- Application validation: shared SELECT/WITH gate + Oracle PL/SQL / procedure / `.NEXTVAL` rejects
- DB defense-in-depth: `SET TRANSACTION READ ONLY` as the first statement of each import/preview transaction
- Live fixture asserts INSERT/UPDATE/DELETE/`FOR UPDATE` fail with ORA-01456 under that transaction

## Preview

- `result.fetchmany(limit)` — SQL is not rewritten with `LIMIT`

## Alembic

- Head: `017_oracle_data_source` (additive enum value `oracle`)

## Verification checklist

- Targeted Oracle unit + live fixture tests
- Lifecycle blank-secret / mode-switch regression
- Worker lineage `source_type=oracle`
- Frontend typed form + Playwright E2E against disposable fixture
- `./scripts/verify.sh` full gate

Phase 4-D is complete on `main` (PR #56 squash `18576e6e54b751f416b87e110c39918fe7dc2045`, CI #273 PASS).
