# Phase 8-D — External Secret Management

Phase 8-D adds a vendor-neutral file-secret boundary while preserving the
existing environment-variable and local `.env` workflow.

## Contract

ModelFlow supports the following runtime secret inputs:

| Direct setting | File companion | Used by |
|---|---|---|
| `DATABASE_URL` | `DATABASE_URL_FILE` | backend, worker |
| `MINIO_ACCESS_KEY` | `MINIO_ACCESS_KEY_FILE` | backend, worker, inference runtime |
| `MINIO_SECRET_KEY` | `MINIO_SECRET_KEY_FILE` | backend, worker, inference runtime |
| `MODELFLOW_SECRET_KEY` | `MODELFLOW_SECRET_KEY_FILE` | backend, worker |
| `MODELFLOW_ENCRYPTION_KEY` | `MODELFLOW_ENCRYPTION_KEY_FILE` | backend, worker |
| `MODELFLOW_INFERENCE_SERVICE_TOKEN` | `MODELFLOW_INFERENCE_SERVICE_TOKEN_FILE` | backend, worker, inference runtime |
| `MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD` | `MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD_FILE` | backend |
| `MODELFLOW_OIDC_CLIENT_SECRET` | `MODELFLOW_OIDC_CLIENT_SECRET_FILE` | backend |
| `MODELFLOW_LLM_API_KEY` | `MODELFLOW_LLM_API_KEY_FILE` | backend |

The `*_FILE` variable contains an **in-container path**, not a secret value.

Runtime precedence is deterministic:

1. explicit `Settings(...)` constructor input (tests/internal callers only)
2. supported `*_FILE` value
3. normal process environment variable
4. local `.env`
5. Settings default

If a supported `*_FILE` variable is non-empty, ModelFlow reads that file and
does **not** fall back to the direct environment value when the file is missing,
unreadable, non-UTF-8, empty, contains NUL bytes, or exceeds 64 KiB. Startup
fails closed with the variable name only; the secret value and configured path
are not included in the error.

Trailing CR/LF characters are removed because mounted secret files commonly end
with a newline. Other whitespace is preserved.

## Supported delivery mechanisms

The application core does not call Vault, AWS, GCP, Azure, Kubernetes, CSI, or
External Secrets APIs. Any mechanism that can mount a UTF-8 file and expose its
path through the corresponding `*_FILE` environment variable is supported.

Examples include:

- Docker / Docker Compose mounted secret files
- Kubernetes Secret volume projections
- CSI Secret Store mounts
- Vault Agent rendered files
- External Secrets Operator output projected as files

This keeps secret-provider choice in deployment infrastructure instead of
business logic.

## Docker Compose

Existing local development remains unchanged:

```bash
./scripts/init-env.sh
docker compose up --build -d
```

For file-mounted production secrets, add the optional overlay:

```bash
docker compose --env-file .env.deploy \
  -f docker-compose.yml \
  -f docker-compose.traefik.yml \
  -f docker-compose.secret-files.yml \
  up -d
```

Set `MODELFLOW_SECRET_HOST_DIR` to a host directory with service-specific
subdirectories:

```text
<root>/
  backend/
  worker/
  inference-runtime/
```

The overlay mounts each subdirectory read-only at
`/run/model-flow-secrets` in the matching container. Put only the secrets that
service needs in its subdirectory.

Example path configuration (values are paths, not credentials):

```dotenv
MODELFLOW_SECRET_HOST_DIR=/srv/modelflow/secrets
MODELFLOW_SECRET_KEY_FILE=/run/model-flow-secrets/jwt-signing-key
MODELFLOW_ENCRYPTION_KEY_FILE=/run/model-flow-secrets/fernet-key
MODELFLOW_INFERENCE_SERVICE_TOKEN_FILE=/run/model-flow-secrets/inference-token
MODELFLOW_OIDC_CLIENT_SECRET_FILE=/run/model-flow-secrets/oidc-client-secret
MODELFLOW_LLM_API_KEY_FILE=/run/model-flow-secrets/llm-api-key
DATABASE_URL_FILE=/run/model-flow-secrets/database-url
MINIO_ACCESS_KEY_FILE=/run/model-flow-secrets/object-store-access-key
MINIO_SECRET_KEY_FILE=/run/model-flow-secrets/object-store-secret-key
```

A variable should only be set in a service when its corresponding file exists in
that service's mounted directory.

The embedded PostgreSQL, MinIO, and MLflow containers keep their existing
Compose credentials in the base stack. Phase 8-D changes ModelFlow runtime
secret consumption; Phase 8-E owns the external/shared stateful-service
deployment model required for HA.

## Kubernetes / CSI / external secret operators

Phase 8-D does not add Kubernetes manifests; that is Phase 8-E. The runtime
contract is already Kubernetes-compatible:

1. project or mount the secret into the pod
2. set the matching `*_FILE` variable to that mounted path
3. restart/roll the dependent workload after rotation

No provider-specific SDK or application code change is required.

## Redaction

Secret-bearing Settings fields are excluded from the default Pydantic
representation and serialization. File read failures report only the `*_FILE` variable name and
failure class; they never include the secret content or configured path.

Do not place secret values in:

- Git-tracked files or container images
- frontend state or public API responses
- audit summaries
- application logs
- Compose/Kubernetes manifests committed to the repository

## Rotation

Settings are loaded once when each process starts. Updating a mounted file does
not live-reload the application; restart or roll the dependent service after the
provider has written the new value.

Recommended rotation order:

- **JWT signing key** — replace the mounted key and restart backend/worker.
  Existing ModelFlow access tokens signed by the old key become invalid. Online
  multi-key verification is not part of 8-D.
- **Fernet encryption key** — do not simply replace it while encrypted
  data-source credentials still use the old key. Export/decrypt and re-encrypt
  under a controlled maintenance procedure before retiring the old key.
  Multi-key online re-encryption is separate scope.
- **Inference service token** — update the same new token for backend, worker,
  and inference runtime, then restart those services as one coordinated
  maintenance change.
- **Database / object-store credentials** — rotate at the backing service,
  update mounted files, then restart the dependent ModelFlow services and
  verify health/readiness.
- **OIDC client secret / LLM provider key** — rotate at the provider, update the
  backend-mounted file, restart backend, and verify the corresponding provider
  flow.

Always retain a rollback copy through the maintenance window according to the
operator's secret-management policy; do not commit backup values to Git.

## Scope boundary

Phase 8-D intentionally does not add:

- mandatory Vault/AWS/GCP/Azure SDKs
- application-database secret storage
- automatic production secret generation
- live secret reload
- multi-key online Fernet/JWT rotation
- Kubernetes deployment manifests or HA claims

Those deployment concerns remain separated from the ModelFlow core secret
contract.
