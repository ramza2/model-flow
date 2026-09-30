# ModelFlow MinIO image (reproducible upstream build)

Default Compose builds MinIO server and `mc` from official upstream source
pins. This replaces unavailable Docker Hub / quay anonymous pulls and rejects
third-party community mirrors as a ModelFlow runtime dependency.

## Pins

| Component | Upstream | Tag | Commit |
|-----------|----------|-----|--------|
| server | https://github.com/minio/minio | `RELEASE.2025-10-15T17-29-55Z` | `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` |
| client (`mc`) | https://github.com/minio/mc | `RELEASE.2025-08-13T08-35-41Z` | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |

Base images (digest-pinned in `Dockerfile`):

- `golang:1.24.8-alpine@sha256:3d78beb141d98f42337f1252ecf2a5f20374109929a4c3f6817f9e4179cc0ae5`
- `alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8`

## Security-support status

MinIO community edition is archived / source-only. The server pin is the
upstream **Security/CVE** release tag. No floating `latest` / `main` / `master`.
AIStor commercial images are intentionally not used (license/deployment
semantics differ).

## Build

```bash
docker compose build minio
docker run --rm --entrypoint minio modelflow/minio:RELEASE.2025-10-15T17-29-55Z --version
docker run --rm --entrypoint mc modelflow/minio:RELEASE.2025-10-15T17-29-55Z --version
```

After a local or CI build, record the image content id / registry digest
(`docker image inspect … Id` / `RepoDigests`) in the PR / verification notes.
Example local content id from a verified build:

`sha256:ca71c6b8e4c399fd744b6cf2478cf84d1f444acc865cb438e6022673a3d035d6`

Prefer publishing that digest to an organization-controlled registry as a
follow-up (Option A) so CI/dev can pull an immutable digest instead of
rebuilding from source every time.
