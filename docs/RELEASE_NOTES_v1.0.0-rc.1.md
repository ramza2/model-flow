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
- Playwright training UX `Datasets` heading selector stability (`exact: true`, PR #22; E2E only)
- CI / dependency security gate hardening (High/Critical fail closed with allowlist)
- Backup/restore destructive verification in the gate

## Known limitations

See [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md).

## Verification baseline

| Check | Status on tip `2d2f3da` |
|-------|-------------------------|
| Backend pytest | **137** passed |
| Frontend Vitest | **98** passed |
| Playwright | **18** passed |
| `./scripts/verify.sh` | PASS |
| GitHub CI on `main` | **SUCCESS** (Actions run [#100](https://github.com/ramza2/model-flow/actions/runs/32930610543)) |

## Remaining before tag

- Manual release smoke test against a clean stack
- Create annotated tag `v1.0.0-rc.1` and GitHub Release **only after** smoke test sign-off
