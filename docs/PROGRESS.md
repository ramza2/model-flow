# Progress

## Current phase

ModelFlow v1.0 Release Candidate readiness.

## Current baseline

- Branch: `main`
- Current commit: `2d2f3dac9e2013b2c19f814f950134437d91b004`
- Open pull requests: documentation Draft PR #21 (this refresh); no other release blockers
- GitHub Releases: none yet (pre-tag documentation only)
- Latest merged fixes:
  - PR #20 — PostgreSQL DSN/URL edit compatibility
  - PR #22 — Playwright `Datasets` heading selector (`exact: true`; E2E only)

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
- Backup / restore destructive round-trip in verify
- Dependency security gate (High/Critical fail closed with allowlist)
- Playwright E2E suite and GitHub Actions full verification gate
- Training E2E empty-state heading selector hardened (PR #22)

## Latest verification

| Suite | Count | How measured |
|-------|------:|--------------|
| Backend pytest | **137** passed | `./scripts/verify.sh` / container pytest |
| Frontend Vitest | **98** passed | `./scripts/verify.sh` section 6 |
| Playwright E2E | **18** passed | `e2e/*.spec.ts` via verify Playwright container |

- `./scripts/verify.sh`: **PASS** on documentation branch after merge of `main`
- GitHub Actions on `main` tip `2d2f3da`: **SUCCESS** (run [#100](https://github.com/ramza2/model-flow/actions/runs/32930610543))
- Production code unchanged by this documentation PR

## Blockers

None.

## Next step

v1.0.0-rc.1 release smoke test and pre-release tagging (no tag/release in this docs PR).
