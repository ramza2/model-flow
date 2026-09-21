# Phase 4-C Verification — Microsoft SQL Server Connector

Baseline: `main@9c92a4d8e806ef93188e3a880ae21da206a8b573`

Evidence already on `main` before this phase:

- Phase 4-B PR #54 merged at `aa6bae2428390f3c49ff39693abeb3bf169faab4` (CI #259 PASS)
- AGENTS.md connector rules PR #53 at `9c92a4d8e806ef93188e3a880ae21da206a8b573` (CI #262 PASS)

## Scope

Phase 4-C adds `source_type=mssql` (UI: **Microsoft SQL Server**) on the existing connector registry and DataImportJob → immutable DatasetVersion path.

Out of scope: Oracle, CDC / Change Tracking, incremental sync, streaming, SSH tunnels, Windows Auth / AD / Kerberos, stored procedures, write-back, certificate management systems.

## Driver / TLS

- `mssql+pyodbc` + pinned `pyodbc`
- Microsoft ODBC Driver 18 installed in the backend image
- Defaults: `Encrypt=yes`, `TrustServerCertificate=no`
- Connection URL mode requires a non-empty username so SQLAlchemy cannot inject `Trusted_Connection=Yes`
- Connection URL query allowlist: `driver` / `Encrypt` / `TrustServerCertificate` only; Encrypt and TrustServerCertificate values must be `yes` or `no`
- Disposable fixture may set `trust_server_certificate=true` for the self-signed container certificate

## Read-only boundary

SQL Server has no PostgreSQL/MySQL-style transaction READ ONLY statement. Primary safety is application SQL validation in `MssqlConnector` (shared side-effect checks plus MSSQL-specific keyword / `SELECT INTO` rejection). The disposable fixture also uses a SELECT-only login; that fixture privilege is not documented as a guarantee for all production connections.

## Preview

Bounded preview uses `cursor.fetchmany(limit)` so arbitrary `SELECT` / `WITH … SELECT` / `dbo.table` resources are not rewritten with `LIMIT`.

## Fixture

- Image: `mcr.microsoft.com/mssql/server:2022-CU27-ubuntu-22.04`
- Digest verified at pull time: `sha256:4402d880dd4c34bfa7d8705e56a86cd6c88da80a1f6bbbe741f999e76264a090`
- Init: `scripts/init-mssql-source.sh` via `mssql-source-init`

## Regression added

Backend:

- Host/Port URL, 1433 default, password encoding, TLS options
- Connection URL allowlist + cross-dialect rejection + secret redaction
- dbo/schema discovery, table/SELECT/WITH import validation
- `WITH … UPDATE/DELETE/INSERT/MERGE`, `SELECT INTO`, multi-statement rejection
- blank credential edit + mode-switch stale-secret cleanup
- DatasetVersion lineage `source_type=mssql`
- live fixture connection / preview / import / permission-layer mutation failure

Frontend / E2E:

- typed MSSQL form (1433, secret non-display, trust-server-certificate lab checkbox)
- browser Create → Test → dbo/customers import → DatasetVersion → Open Dataset against the real fixture

Verification waits for `postgres-source`, `mysql-source`, `mariadb-source`, and `mssql-source` (plus `mssql-source-init` exit 0).

## Gate checklist (pre-merge)

- targeted backend MSSQL / lifecycle / worker tests PASS
- frontend targeted tests PASS
- PostgreSQL / MySQL / MariaDB / REST regressions PASS
- MSSQL browser E2E PASS
- Alembic head `016_mssql_data_source`
- `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions reviewed separately after Draft PR

Phase 4-C is complete only after merge and the resulting `main` CI passes.
