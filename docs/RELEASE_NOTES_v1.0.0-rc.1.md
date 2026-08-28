# ModelFlow v1.0.0-rc.1

First Release Candidate for self-hosted tabular MLOps on Docker Compose.

- **Git tag:** `v1.0.0-rc.1`
- **GitHub Release:** [ModelFlow v1.0.0-rc.1](https://github.com/ramza2/model-flow/releases/tag/v1.0.0-rc.1) (pre-release)
- **Baseline commit:** `92c59dbcd7da4f799b65c94c8347c8154aa63d4a`

## Highlights

- Self-hosted tabular MLOps workflow on Docker Compose
- PostgreSQL and managed file data sources with encrypted secrets
- Dataset versioning, profiling, quality checks, and splits
- Training jobs, MLflow experiments, model registry, and approval lifecycle
- Realtime endpoint inference and batch inference
- Visual pipeline design, publish, and execute
- Drift monitoring, alerts, and retrain requests (no auto PRODUCTION promotion)
- Project RBAC and audit logging
- Backup / restore scripts with verified Linux CI and Windows Git Bash/MSYS round-trip; macOS Bash 3.2 compatibility handling included
- Full verification gate (`./scripts/verify.sh` + GitHub Actions)

## RC smoke follow-up fixes (PR #23)

- Windows Git Bash/MSYS PostgreSQL + MinIO backup/restore path handling
- Batch inference history auto-polling for active jobs
- Dataset list **Updated** column uses `latest_version_created_at` (latest version timestamp)

## Release-readiness fixes (earlier)

- PostgreSQL typed Host/Port connection UX (PR #18)
- DSN/URL backward compatibility, `connection_mode`, and `clear_secrets` (PR #20)
- Secret handling and E2E assertion hygiene (no plaintext secrets in locators)
- Playwright training UX `Datasets` heading selector stability (`exact: true`, PR #22; E2E only)
- CI / dependency security gate hardening (High/Critical fail closed with allowlist)
- Backup/restore destructive verification in the gate

## Known limitations

See [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md).

## Verification baseline

| Check | Status on `92c59db` |
|-------|------------------------|
| Backend pytest | **138** passed |
| Frontend Vitest | **105** passed |
| Playwright | **18** passed |
| `./scripts/verify.sh` | PASS |
| GitHub CI on `main` | **SUCCESS** (CI #107, [run](https://github.com/ramza2/model-flow/actions/runs/33142251221)) |
| Manual clean-stack RC smoke | PASS |
| Windows Git Bash backup/restore | PASS |

## What's next

Post-RC enhancement planning: [`ENHANCEMENT_ROADMAP.md`](./ENHANCEMENT_ROADMAP.md). First planned phase: **Scheduling / Automation**.
