# Phase 4 — Connectors

Status: **Implementation plan — Phase 4-D current**  
Baseline: `main@e8c5af7db26affd29c312f3739fb4b76db366ad6` (Phase 4-C complete)

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

## Phase 4-C — Microsoft SQL Server (complete)

Phase 4-C is complete on `main` (PR #55 / `e8c5af7db26affd29c312f3739fb4b76db366ad6`, post-merge CI #268 PASS). See [`phase-4c-verification.md`](./phase-4c-verification.md).

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

`connection_mode` metadata is returned for `postgres`, `mysql`, `mssql`, and `oracle`. Cross-dialect URLs are rejected without echoing credentials.

### Import resources

- `dbo.customers` / schema.table / bare table name
- read-only `SELECT …`
- safely validated `WITH … SELECT …`

Rejected (application validation):

- `INSERT` / `UPDATE` / `DELETE` / `MERGE` / `EXEC` / `EXECUTE` / DDL / `TRUNCATE`
- `WITH … UPDATE|DELETE|INSERT|MERGE`
- `SELECT … INTO …` (creates a table on SQL Server)
- `NEXT VALUE FOR` (sequence mutation)
- multiple statements

Fixture SELECT-only logins are an additional disposable defense, not a substitute for validation and not a claim that every production MSSQL account is read-only.

Materialization reuses the existing worker path. Lineage: `source_type=mssql`.

### Disposable fixtures

Compose profile `source` adds:

- `mssql-source` — `mcr.microsoft.com/mssql/server:2022-CU27-ubuntu-22.04` (exact tag; not `latest`)
- `mssql-source-init` — one-shot seed of database, `dbo.customers`, and a SELECT-only login

## Phase 4-D — Oracle Database

### Source type

- `oracle` — UI label **Oracle Database**
- default port **1521**

### Driver stack

- SQLAlchemy dialect: `oracle+oracledb`
- Python package: pinned `oracledb` in `backend/requirements.txt` (Thin mode default)
- No Oracle Instant Client / Thick mode in the backend image

### SQLAlchemy relational sharing

Shared helpers remain in `backend/app/connectors/sql_relational.py`. Concrete `OracleConnector` owns:

- URL construction and allowlist (`oracle://`, `oracle+oracledb://` only; bare `oracle://` normalizes to `oracle+oracledb://`)
- Host/Port uses `service_name` query parameter (not database path / SID)
- Connection URL query allowlist: `service_name` only
- `SET TRANSACTION READ ONLY` as the first statement of each import/preview transaction
- bounded preview via `fetchmany` (no `LIMIT` rewrite)

### Configuration

Public config (Host/Port mode):

- `host`
- `port` (default 1521)
- `service_name`
- `user`

Encrypted secrets:

- `password` (Host/Port mode)
- `dsn` / `url` (Connection URL mode)

SID typed mode, wallet / thick / TNS_ADMIN query parameters are out of scope and rejected.

### Import resources

- `MODELFLOW.CUSTOMERS` / schema.table / bare table name
- read-only `SELECT …`
- safely validated `WITH … SELECT …`

Rejected (application validation):

- `INSERT` / `UPDATE` / `DELETE` / `MERGE` / DDL / `TRUNCATE`
- `BEGIN` / `DECLARE` PL/SQL blocks
- `CALL` / `EXEC` / `EXECUTE`
- `SELECT … FOR UPDATE`
- sequence `.NEXTVAL`
- multiple statements

DB-level `SET TRANSACTION READ ONLY` is defense-in-depth alongside validation. Fixture SELECT-only readers are an additional disposable defense.

Materialization reuses the existing worker path. Lineage: `source_type=oracle`.

### Disposable fixtures

Compose profile `source` adds:

- `oracle-source` — `gvenzl/oracle-free:23.26.3-slim-faststart` (exact tag; not `latest`)
- `oracle-source-init` — one-shot seed of `CUSTOMERS` and a SELECT-only reader

## Phase 4 implementation order

1. **4-A — Connector Foundation + REST API Source** — complete
2. **4-B — MySQL / MariaDB** — complete
3. **4-C — Microsoft SQL Server** — complete
4. **4-D — Oracle** — current
5. **4-E — Final Hardening / Connector Regression**

## Phase 4-D acceptance

- Oracle Database create/edit/test/schema/table/import through typed UI
- credentials remain encrypted and redacted
- Connection URL requires username + `service_name` only
- preview never emits Oracle-invalid `LIMIT`
- `SET TRANSACTION READ ONLY` rejects mutations on the live fixture
- PostgreSQL, MySQL/MariaDB, MSSQL, and REST regressions remain green
- disposable Oracle fixture exercises connection → import → DatasetVersion
- Alembic head includes additive `oracle` enum value (`017_oracle_data_source`)
- `./scripts/verify.sh` and exact PR HEAD CI pass

Phase 4-D is not marked complete until this Draft PR merges and `main` CI passes.
