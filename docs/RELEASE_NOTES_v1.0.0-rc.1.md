# ModelFlow v1.0.0-rc.1

Pre-release documentation for the first Release Candidate. **No GitHub Release or git tag is created by the documentation PR alone.**

## Highlights

- Self-hosted tabular MLOps workflow on Docker Compose
- PostgreSQL and managed file data sources with encrypted secrets
- Dataset versioning, profiling, quality checks, and splits
- Training jobs, MLflow experiments, model registry, and approval lifecycle
- Realtime endpoint inference and batch inference
- Visual pipeline design, publish, and execute
- Drift monitoring, alerts, and retrain requests (no auto PRODUCTION promotion)
- Project RBAC and audit logging
- Backup / restore scripts with verify round-trip
- Full verification gate (`./scripts/verify.sh` + GitHub Actions)

## Release-readiness fixes (recent)

- PostgreSQL typed Host/Port connection UX (PR #18)
- DSN/URL backward compatibility, `connection_mode`, and `clear_secrets` (PR #20)
- Secret handling and E2E assertion hygiene (no plaintext secrets in locators)
- CI / dependency security gate hardening (High/Critical fail closed with allowlist)
- Backup/restore destructive verification in the gate

## Known limitations

See [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md).

## Verification baseline

| Check | Expected |
|-------|----------|
| Backend pytest | 137 collected (tip measurement) |
| Frontend Vitest | 98 passed (tip measurement) |
| Playwright | 18 tests |
| `./scripts/verify.sh` | PASS on documentation PR |
| GitHub CI | Must be green on `main` before tagging |

## Remaining before tag

- Confirm `main` GitHub Actions is green (Playwright heading strict-mode flake observed on `2695306` must be cleared).
- Manual release smoke test against a clean stack.
- Create annotated tag `v1.0.0-rc.1` and GitHub Release **only after** the above.
