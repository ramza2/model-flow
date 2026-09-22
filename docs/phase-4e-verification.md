# Phase 4-E Verification — Final Hardening / Connector Regression

Baseline: `main@18576e6e54b751f416b87e110c39918fe7dc2045`

## Provenance

- Phase 4-D PR #56 squash-merged at `18576e6e54b751f416b87e110c39918fe7dc2045` (CI #273 PASS)
- Phase 4-E current / Phase 4 completion pending merge

## Scope

Close Phase 4-D non-blocking security/UX debt and run a cross-connector regression pass for:

- PostgreSQL
- REST API
- MySQL / MariaDB
- Microsoft SQL Server
- Oracle Database

Out of scope: new connectors, CDC / incremental sync, SSH tunnels, write-back, Instant Client / Thick / Wallet, architecture rewrites.

## Oracle debt closure

| Debt | Resolution |
| --- | --- |
| Autonomous SELECT / UDF | Package-qualified and non-allowlisted bare calls rejected; double-quoted function identifiers such as `"SIDE_EFFECT_PROBE"()` / `APP."SIDE_EFFECT_PROBE"()` also fail-closed (scanned on original SQL before the shared stripper removes `"` tokens), including comment/trivia glue such as `"SIDE_EFFECT_PROBE"/*x*/()`. COUNT/SUM/AVG/NVL/COALESCE/CAST/TO_CHAR/… allowed; quoted column/table identifiers remain allowed. Fixture seeds `side_effect_probe` (autonomous INSERT); live test proves RO bypass for unquoted, `"SIDE_EFFECT_PROBE"()`, and `"SIDE_EFFECT_PROBE"/*probe*/()` plus validator block. |
| Duplicate `service_name` | Fail-closed (case-insensitive), including `SERVICE_NAME` |
| URL-mode stale config | `oracleExtraConfigForUrlMode` strips `host`/`port`/`service_name`/`user`/`database` |
| Import schema default | Prefer username match, else first non-system schema; system schemas remain listed |

## Cross-connector URL hardening

| Connector | Scheme allowlist | Duplicate query | Notes |
| --- | --- | --- | --- |
| PostgreSQL | `postgresql` / `postgres` / `postgresql+psycopg2` | N/A (no allowlisted query mode) | Phase 4-E added scheme allowlist |
| MySQL/MariaDB | existing | N/A | unchanged |
| MSSQL | existing | fail-closed via shared helper | Encrypt/TSC/driver duplicates rejected |
| Oracle | existing | fail-closed via shared helper | `service_name` only |

## Relational regression matrix

| Concern | PG | MySQL | MariaDB | MSSQL | Oracle |
| --- | --- | --- | --- | --- | --- |
| connection | Y | Y | Y | Y | Y |
| schema discovery | Y | Y | Y | Y | Y |
| table discovery | Y | Y | Y | Y | Y |
| preview | Y | Y | Y | Y | Y |
| table import | Y | Y | Y | Y | Y |
| SELECT import | Y | Y | Y | Y | Y |
| WITH SELECT | Y | Y | Y | Y | Y |
| mutation reject | Y | Y | Y | Y | Y |
| DB read-only defense | Y | Y | Y | N* | Y |
| secret redaction | Y | Y | Y | Y | Y |
| mode-switch cleanup | Y | Y | Y | Y | Y |
| DatasetVersion | Y | Y | Y | Y | Y |
| lineage `source_type` | Y | Y | Y | Y | Y |

\* MSSQL: no transaction READ ONLY; application validator + SELECT-only fixture.

## REST regression matrix

| Concern | Covered |
| --- | --- |
| HTTPS/HTTP policy | Y (existing) |
| GET only | Y |
| auth secret redaction | Y |
| response-size bound | Y |
| timeout | Y |
| JSON object/array + dot path | Y |
| DatasetVersion / lineage | Y |

## Verification checklist

- Oracle unit + live autonomous / duplicate / builtin-allow tests
- MSSQL duplicate query tests
- PostgreSQL scheme allowlist + lifecycle DSN normalize assertions
- Lifecycle Oracle URL-mode config cleanup
- Frontend Oracle URL-mode + schema preference unit tests
- Playwright Oracle import with APP credentials / default schema
- Cross-connector regression module `test_phase4e_connector_regression.py`
- `./scripts/verify.sh` full gate

Phase 4 is complete only after this Draft PR merges and the resulting `main` CI passes.
