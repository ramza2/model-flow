# Phase 4-A Verification — Connector Foundation + REST API Source

Status: **Complete on main**

Completed: PR #52 merge SHA `09ced60c7a3b5ebaae697c9d4e51dea23b6d23f1`; post-merge CI #254 PASS.

Baseline (start): `main@b0c8d517b8e83c57e1b1bcaedb8a4120bc99e620`

## Invariants

- DataSource credentials remain encrypted and are not returned through API responses.
- DataImportJob remains the asynchronous import lifecycle for PostgreSQL and REST.
- DatasetVersion remains immutable and records `data_source_id`, `import_job_id`, and source type.
- Existing PostgreSQL Host/Port and DSN/URL semantics remain backward compatible.
- Connectors do not bypass project-scoped RBAC or existing Data Source activation rules.

## Backend coverage

Phase 4-A adds regression for:

- REST Bearer authentication, query parameters, and nested `data_path`
- API-key header authentication
- relative-resource enforcement
- invalid/non-tabular REST payload rejection
- REST source secret redaction
- connector-backed preview API contract
- REST import enqueue through the existing DataImportJob API
- worker materialization of connector output into a REST-sourced DatasetVersion

Existing data-source lifecycle and PostgreSQL tests remain authoritative for activation, deactivation, deletion protection, cross-project isolation, schema/table discovery, and DSN compatibility.

## Frontend coverage

Phase 4-A adds regression for:

- typed REST API form instead of raw JSON
- public REST config separated from Bearer/API-key secrets
- saved credential fields remaining blank on edit
- REST preview without SQL schema discovery
- REST resource import using the existing import job status UX

## Browser integration

`e2e/data-sources-ops.spec.ts` uses the disposable Compose backend itself as a deterministic REST source:

`http://backend:8000/api/v1/health`

The browser flow verifies:

1. create REST source
2. test connection
3. preview JSON response
4. start import
5. worker materializes DatasetVersion
6. open imported Dataset

No public internet or paid/external service is required.

## Merge gate

Before merge:

- backend targeted tests PASS
- frontend targeted tests PASS
- existing PostgreSQL data-source regression PASS
- REST browser E2E PASS
- Alembic upgrade supports the additive `rest_api` source enum
- repository `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions PASS
- actual diff final review finds no blocker

Phase 4-A is complete after merge and the resulting `main` CI passed (CI #254).
