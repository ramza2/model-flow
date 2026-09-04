# Known limitations (v1.0 RC)

- Single-node Docker Compose deployment only (no Kubernetes / HA).
- Inference runs in the API process (in-memory model cache); not a separate serving mesh.
- No SSO/LDAP; local JWT + bcrypt users only.
- No GPU / distributed training; sklearn tabular models only.
- Visual pipeline engine is DB-worker DAG execution, not Airflow/Prefect.
- Soft-deleted projects/users are hidden; hard purge follows retention settings.
- Inference payloads are not stored by default (`store_inference_payloads=false`).
- Retrain automation never auto-promotes models to PRODUCTION.
- Compose credentials are generated into an ignored `.env` for local/self-hosted trust boundaries only — do not expose the stack to the public internet.

## Dependency security gate

Local `./scripts/verify.sh` and GitHub Actions run the same dependency checks:

1. `pip-audit` against `backend/requirements.txt`
2. Frontend `npm audit`
3. E2E package `npm audit`

`scripts/check-security-audits.py` **fails the gate** when High or Critical findings are present unless each finding is listed in `security/allowlist.json` with package, vulnerability id, reason, and ISO expiry. Scanner/schema failures also fail the gate (fail closed). This is **not** an informational-only scan.

The verify gate runs `npm audit` in **`node:24.8-alpine`** (npm 11.x, audit step only) so reports use the registry **bulk advisory** endpoint. Frontend lint/typecheck/test still use `node:22.17-alpine`. The legacy `/security/audits/quick` endpoint was retired and returns 4xx; npm 10 falls back to it when bulk responses fail. Audit calls also retry briefly when the registry returns a transient error or a JSON body without `vulnerabilities{}`. GitHub Actions CI timeout for the full gate is **90 minutes**.

## Operational notes

- Rate limit defaults to 120/min; `init-env.sh --non-interactive-test` raises it for CI/verify volume.
- Logout increments `token_version`, invalidating tokens on all devices for that user (D-029).
- PostgreSQL data sources support Host/Port fields or Connection URL/DSN mode; secrets (`password`, `dsn`, `url`) are encrypted and never returned in API responses (`connection_mode` is non-sensitive metadata only; D-034).
