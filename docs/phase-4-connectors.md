# Phase 4 — Connectors

Status: **Implementation plan — Phase 4-C current**  
Baseline: `main@9c92a4d8e805ef93188e3a880ae21da206a8b573` (Phase 4-B complete; AGENTS connector rules on main)

## Purpose

Phase 4 expands ModelFlow data-source connectivity without duplicating source lifecycle, credential storage, import jobs, DatasetVersion materialization, or lineage logic.

The connector contract separates source-specific reads from the existing orchestration:

```text
Data Source config + encrypted secrets
              ↓
        Connector registry
              ↓
 test / discovery / preview / read
              ↓
       DataImportJob worker
              ↓
 immutable DatasetVersion
              ↓
 Preparation / Training / Pipeline
```

## Shared connector contract

A connector may provide:

- connection test
- optional schema/table discovery
- bounded sample preview
- tabular DataFrame read for import
- source-specific cleanup

The API and worker own project scoping, RBAC, auditing, import-job lifecycle, dataset creation, materialization, and lineage. Connectors do not create datasets or write ModelFlow database rows directly.

PostgreSQL moved behind this contract in Phase 4-A with its existing Host/Port and encrypted DSN/URL behavior preserved.

## Phase 4-A — Connector Foundation + REST API Source (complete)

Phase 4-A is complete on `main` (PR #52 / `09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1`, post-merge CI #254 PASS). See [`phase-4a-verification.md`](./phase-4a-verification.md).

## Phase 4-B — MySQL / MariaDB (complete)

Phase 4-B is complete on `main` (PR #54 / `aa6bae2428390f3c49ff39693abeb3bf169faab4`, post-merge CI #259 PASS). See [`phase-4b-verification.md`](./phase-4b-verification.md).

One `DataSourceType` value `mysql` (UI label **MySQL / MariaDB**) covers MySQL and MariaDB through `mysql+pymysql`, Host/Port (3306) + Connection URL modes, and disposable `mysql:8.4.5` / `mariadb:11.4.5` fixtures.

## Phase 4-C — Microsoft SQL Server

### Source type

- `mssql` — UI label **Microsoft SQL Server**
- default port **1433**

### Driver stack

- SQLAlchemy dialect: `mssql+pyodbc`
- Python package: pinned `pyodbc` in `backend/requirements.txt`
- OS: Microsoft ODBC Driver 18 for SQL Server + unixODBC in the backend Dockerfile (Debian 12 / bookworm Microsoft prod repo)

### SQLAlchemy relational sharing

Shared helpers remain in `backend/app/connectors/sql_relational.py`. Concrete `MssqlConnector` owns:

- URL construction and allowlist (`mssql://`, `mssql+pyodbc://` only; bare `mssql://` normalizes to `mssql+pyodbc://`)
- ODBC 18 TLS options (`Encrypt` default yes, `TrustServerCertificate` default no)
- strict read-only validation (SQL Server has no transaction-level READ ONLY equivalent)
- bounded preview via `fetchmany` (no `LIMIT` rewrite)

### Configuration

Public config (Host/Port mode):

- `host`
- `port` (default 1433)
- `database`
- `user`
- optional `encrypt` (default true)
- optional `trust_server_certificate` (default false; lab checkbox for self-signed fixtures)

Encrypted secrets:

- `password` (Host/Port mode)
- `dsn` / `url` (Connection URL mode)

`connection_mode` metadata is returned for `postgres`, `mysql`, and `mssql`. Cross-dialect URLs are rejected without echoing credentials.

### Import resources

- `dbo.customers` / schema.table / bare table name
- read-only `SELECT …`
- safely validated `WITH … SELECT …`

Rejected (application validation):

- `INSERT` / `UPDATE` / `DELETE` / `MERGE` / `EXEC` / `EXECUTE` / DDL / `TRUNCATE`
- `WITH … UPDATE|DELETE|INSERT|MERGE`
- `SELECT … INTO …` (creates a table on SQL Server)
- multiple statements

Fixture SELECT-only logins are an additional disposable defense, not a substitute for validation and not a claim that every production MSSQL account is read-only.

Materialization reuses the existing worker path. Lineage: `source_type=mssql`.

### Disposable fixtures

Compose profile `source` adds:

- `mssql-source` — `mcr.microsoft.com/mssql/server:2022-CU27-ubuntu-22.04` (exact tag; not `latest`)
- `mssql-source-init` — one-shot seed of database, `dbo.customers`, and a SELECT-only login

## Phase 4 implementation order

1. **4-A — Connector Foundation + REST API Source** — complete
2. **4-B — MySQL / MariaDB** — complete
3. **4-C — Microsoft SQL Server** — current
4. **4-D — Oracle** — next
5. **4-E — Final Hardening / Connector Regression**

## Phase 4-C acceptance

- Microsoft SQL Server create/edit/test/schema/table/import through typed UI
- credentials remain encrypted and redacted
- ODBC 18 Encrypt / TrustServerCertificate defaults are explicit
- preview never emits SQL Server-invalid `LIMIT`
- read-only SQL gate rejects mutations, `SELECT INTO`, and multi-statements
- PostgreSQL, MySQL/MariaDB, and REST regressions remain green
- disposable SQL Server fixture exercises connection → import → DatasetVersion
- Alembic head includes additive `mssql` enum value (`016_mssql_data_source`)
- `./scripts/verify.sh` and exact PR HEAD CI pass

Phase 4-C is not marked complete until this Draft PR merges and `main` CI passes.
