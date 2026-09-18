# Phase 4 — Connectors

Status: **Implementation plan — Phase 4-B current**  
Baseline: `main@09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1` (Phase 4-A complete)

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

## Phase 4-B — MySQL / MariaDB

### Source type

One `DataSourceType` value:

- `mysql` — UI label **MySQL / MariaDB**

MySQL and MariaDB share the same connector, driver path (`mysql+pymysql`), and Host/Port + Connection URL semantics. Separate `mariadb` enum values are not introduced.

### SQLAlchemy relational sharing

Shared helpers live in `backend/app/connectors/sql_relational.py`:

- identifier quoting via the engine dialect
- table-name validation
- read-only SELECT / WITH validation (reject mutations and multiple statements)
- Inspector schema/table discovery
- preview wrap + DataFrame read patterns
- engine lifecycle

Concrete connectors keep:

- SQLAlchemy driver / URL construction
- default ports (`postgres` 5432, `mysql` 3306)
- connect args
- dialect-specific read-only transaction setup
  - PostgreSQL: `SET TRANSACTION READ ONLY`
  - MySQL/MariaDB: `SET SESSION TRANSACTION READ ONLY`

### Configuration

Public config (Host/Port mode):

- `host`
- `port` (default 3306)
- `database`
- `user`

Encrypted secrets:

- `password` (Host/Port mode)
- `dsn` / `url` (Connection URL mode)

`connection_mode` metadata (`host_port` | `connection_url`) is returned for both `postgres` and `mysql`. REST remains `null`. Blank password / blank URL on edit keeps the saved secret; mode switches clear stale secret keys.

Vendor URLs such as `mysql://…` and `mariadb://…` are normalized to `mysql+pymysql://…` for the MySQL connector. PostgreSQL continues to store and use DSN/URL values as provided for backward compatibility.

### Import resources

- `schema.table` / `database.table` / bare table name
- read-only `SELECT …`
- safely validated `WITH …`

Materialization reuses the existing worker path:

```text
Connector.read_frame() → DataFrame → CSV bytes → DatasetVersion
```

Lineage: `source_type=mysql`, `data_source_id`, `import_job_id`.

### Disposable fixtures

Compose profile `source` adds:

- `mysql-source` — `mysql:8.4.5`
- `mariadb-source` — `mariadb:11.4.5`

Both seed `customers` via `scripts/init-mysql-source.sql`.

## Phase 4 implementation order

1. **4-A — Connector Foundation + REST API Source** — complete
2. **4-B — MySQL / MariaDB** — current
3. **4-C — Microsoft SQL Server** — next
4. **4-D — Oracle**
5. **4-E — Final Hardening / Connector Regression**

Later SQL connectors should implement the shared contract rather than add database-specific orchestration to API or worker modules.

## Phase 4-B acceptance

- MySQL / MariaDB create/edit/test/schema(database)/table/import through typed UI
- credentials remain encrypted and redacted
- read-only SQL gate rejects mutations and multi-statements
- PostgreSQL and REST regressions remain green
- disposable MySQL and MariaDB fixtures exercise connection → import → DatasetVersion
- Alembic head includes additive `mysql` enum value
- `./scripts/verify.sh` and exact PR HEAD CI pass
