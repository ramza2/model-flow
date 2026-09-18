# Phase 4 — Connectors

Status: **Implementation plan — Phase 4-A current**  
Baseline: `main@b0c8d517b8e83c57e1b1bcaedb8a4120bc99e620`

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

PostgreSQL moves behind this contract in Phase 4-A with its existing Host/Port and encrypted DSN/URL behavior preserved.

## Phase 4-A — Connector Foundation + REST API Source

### REST configuration

Public configuration:

- `base_url` — absolute HTTP(S) base URL
- `resource_path` — default relative GET resource
- `data_path` — optional dot path selecting the tabular JSON payload
- `timeout_seconds` — 1–60 seconds
- `auth_type` — `none`, `bearer`, or `api_key`
- `api_key_header` — header name for API-key authentication
- `query_params` — optional non-secret JSON object

Encrypted secrets:

- `bearer_token`
- `api_key`

Secret values are never returned in Data Source API responses. Editing an existing REST source leaves credential fields blank; a blank field retains the saved credential only when the authentication mode is unchanged.

### REST response contract

Phase 4-A accepts:

- one JSON object, materialized as one row; or
- an array of JSON objects
- wrapped responses selected with an explicit `data_path`

Nested object fields are flattened to dotted column names through the connector. Empty arrays and scalar-only payloads are rejected as non-tabular.

### Safety and scope boundary

Phase 4-A REST operations are intentionally limited to:

- HTTP(S) GET
- bounded request timeout
- maximum 20 MiB response
- relative resource paths under the configured base URL
- JSON responses only

Explicitly out of scope:

- POST / PUT / PATCH / DELETE connector execution
- arbitrary scripts or user-provided connector code
- automatic pagination or cursor traversal
- streaming ingestion
- webhook ingestion
- OAuth authorization flows
- REST response mutation or server-side transformation beyond JSON flattening

## Phase 4 implementation order

1. **4-A — Connector Foundation + REST API Source**
2. **4-B — MySQL / MariaDB**
3. **4-C — Microsoft SQL Server**
4. **4-D — Oracle**
5. **4-E — Final Hardening / Connector Regression**

Later SQL connectors should implement the shared contract rather than add database-specific orchestration to API or worker modules.

## Phase 4-A acceptance

- existing PostgreSQL create/edit/test/schema/table/import behavior remains unchanged
- PostgreSQL API and worker reads are routed through the connector registry
- REST source can be created and edited through typed UI without exposing saved credentials
- connection test performs configured GET and returns generic failure copy on errors
- REST resource preview returns bounded columns/rows
- REST import creates an existing `DataImportJob` and materializes an immutable DatasetVersion with `source_type=rest_api`
- project/RBAC/source lifecycle rules remain authoritative
- external services are not required for the integrated verification path
- full repository verification and exact PR HEAD CI pass before merge
