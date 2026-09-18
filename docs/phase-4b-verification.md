# Phase 4-B Verification — MySQL / MariaDB Connector

Status: **Draft PR verification baseline**

Baseline: `main@09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1` (Phase 4-A complete; PR #52; CI #254 PASS)

## Invariants

- DataSource credentials remain encrypted and are not returned through API responses.
- DataImportJob remains the asynchronous import lifecycle for PostgreSQL, REST, and MySQL/MariaDB.
- DatasetVersion remains immutable and records `data_source_id`, `import_job_id`, and `source_type=mysql`.
- Existing PostgreSQL Host/Port and DSN/URL semantics remain backward compatible.
- Existing REST typed form, GET-only import, and secret redaction remain unchanged.
- Connectors do not bypass project-scoped RBAC or existing Data Source activation rules.
- One source type `mysql` covers MySQL and MariaDB through PyMySQL.

## Backend coverage

Phase 4-B adds regression for:

- MySQL Host/Port URL construction and password URL encoding
- Connection URL / DSN mode with `mysql://` and `mariadb://` normalization to `mysql+pymysql://`
- blank-secret edit and mode-switch stale-secret cleanup
- connection test (`SELECT 1`)
- schema/database and table discovery through SQLAlchemy Inspector
- table import, SELECT import, read-only WITH
- mutation and multiple-statement rejection
- DatasetVersion lineage `source_type=mysql`
- live disposable MySQL and MariaDB fixtures when Compose source credentials are present

Existing PostgreSQL and REST connector tests remain authoritative for their paths.

## Frontend coverage

Phase 4-B adds regression for:

- typed MySQL / MariaDB form (default port 3306)
- password excluded from public config
- blank password / blank URL edit semantics reused from PostgreSQL helpers
- schema(database)/table import and SQL import panels for `mysql`
- PostgreSQL and REST existing form/import tests

## Browser integration

`e2e/data-sources-ops.spec.ts` exercises disposable Compose sources:

- `mysql-source` — Create → Test → Import → DatasetVersion → Open Dataset
- `mariadb-source` — same flow through the shared `mysql` source type

No public internet or paid/external service is required.

## Merge gate

Before merge:

- backend targeted tests PASS
- frontend targeted tests PASS
- PostgreSQL data-source regression PASS
- REST regression PASS
- MySQL and MariaDB browser E2E PASS
- Alembic upgrade supports the additive `mysql` source enum
- repository `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions PASS
- actual diff final review finds no blocker

Phase 4-B is complete only after merge and the resulting `main` CI passes.
