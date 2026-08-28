# Progress

## Current phase

**Enhancement Phase 1 — Scheduling / Automation** complete on feature branch; see [`SCHEDULING.md`](./SCHEDULING.md).

## Current baseline

- Branch: `main` (Phase 1 implemented on `cursor/phase1-scheduling-automation-71f2`)
- Starting main SHA: `9acf964c7c45e52f087306ab4336cc5620caec6d`
- Git tag: `v1.0.0-rc.1` (unchanged)

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
| Backend pytest | **155** passed | `./scripts/verify.sh` |
| Frontend Vitest | **106** passed | `./scripts/verify.sh` section 6 |
| Playwright E2E | **19** passed | `e2e/*.spec.ts` via verify Playwright container |

- `./scripts/verify.sh`: **PASS** on Phase 1 branch (`cursor/phase1-scheduling-automation-71f2`)

## Blockers

None for the v1.0.0-rc.1 baseline.

## Next step

**Enhancement Phase 1.5 — Figma UX Architecture** (see [`ENHANCEMENT_ROADMAP.md`](./ENHANCEMENT_ROADMAP.md)).
