# Known limitations (v1.0 RC)

- Single-node Compose deployment only (no Kubernetes / HA).
- Inference runs in the API process (in-memory model cache); not a separate serving mesh.
- No SSO/LDAP; local JWT + bcrypt users only.
- No GPU / distributed training; sklearn tabular models only.
- Visual pipeline engine is DB-worker DAG execution, not Airflow/Prefect.
- Dependency advisory scans (`pip-audit`, `npm audit`) are informational in verify/CI and do not fail the gate (avoid breaking upgrades).
- Default Compose credentials (`minioadmin`, Postgres `modelflow`, bootstrap admin password via env) are for local/self-hosted trust boundaries only — do not expose to the public internet.
- Soft-deleted projects/users are hidden; hard purge follows retention settings.
- Inference payloads are not stored by default (`store_inference_payloads=false`).
- Retrain automation never auto-promotes models to PRODUCTION.
