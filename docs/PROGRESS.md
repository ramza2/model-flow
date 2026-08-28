# Progress

## Current phase

**v1.0.0-rc.1 release complete** — enhancement planning.

See [`ENHANCEMENT_ROADMAP.md`](./ENHANCEMENT_ROADMAP.md) for post-RC priorities.

## Current baseline

- Branch: `main`
- Current commit: `92c59dbcd7da4f799b65c94c8347c8154aa63d4a`
- Git tag: `v1.0.0-rc.1` (annotated)
- GitHub Release: [ModelFlow v1.0.0-rc.1](https://github.com/ramza2/model-flow/releases/tag/v1.0.0-rc.1) (pre-release)
- Latest merged fixes:
  - PR #23 — RC smoke follow-ups (Windows Git Bash backup/restore, batch inference polling, dataset `latest_version_created_at`)
  - PR #22 — Playwright `Datasets` heading selector (`exact: true`; E2E only)
  - PR #20 — PostgreSQL DSN/URL edit compatibility

## Completed release-readiness work

- Authentication, bootstrap admin, logout token revocation, RBAC
- Generated environment secrets (`scripts/init-env.sh`) and Compose required env
- Dataset versioning, quality rules, splits linked to training
- Training, MLflow experiments, server-side model gate policies, approval lifecycle
- Visual pipeline design / publish / execute
- PostgreSQL and managed-file data sources with encrypted secrets
- Typed Host/Port PostgreSQL UX plus DSN/URL connection mode and `clear_secrets` (PR #18 / #20)
- Endpoint realtime and batch inference; service API keys
- Drift monitoring and operational alerts
- Backup / restore destructive round-trip in verify (Linux CI + Windows Git Bash/MSYS)
- Dependency security gate (High/Critical fail closed with allowlist)
- Playwright E2E suite and GitHub Actions full verification gate
- Annotated tag `v1.0.0-rc.1` and GitHub pre-release published

## Latest verification

| Suite | Count | How measured |
|-------|------:|--------------|
| Backend pytest | **138** passed | `./scripts/verify.sh` / container pytest |
| Frontend Vitest | **105** passed | `./scripts/verify.sh` section 6 |
| Playwright E2E | **18** passed | `e2e/*.spec.ts` via verify Playwright container |

- `./scripts/verify.sh`: **PASS** on `main` at `92c59db`
- GitHub Actions on `main` (CI #107): **SUCCESS** ([run](https://github.com/ramza2/model-flow/actions/runs/33142251221))
- Manual clean-stack RC smoke: **PASS**
- Windows Git Bash/MSYS PostgreSQL + MinIO backup/restore (real environment): **PASS**

## Blockers

None for the v1.0.0-rc.1 baseline.

## Next step

**Enhancement Phase 1 — Scheduling / Automation** (see [`ENHANCEMENT_ROADMAP.md`](./ENHANCEMENT_ROADMAP.md)).
