# Progress

## Current phase

ModelFlow v1.0 Release Candidate readiness.

## Current baseline

- Branch: `main`
- Current commit: `26953064c487fdc7a9b2f37453d9e4fb09008362`
- Open pull requests: none (documentation Draft PR may be open for this refresh)
- GitHub Releases: none yet (pre-tag documentation only)
- Latest completed compatibility fix: PR #20 — PostgreSQL DSN/URL edit compatibility

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

## Latest verification (counts collected on tip)

| Suite | Count | How measured |
|-------|------:|--------------|
| Backend pytest | **137** collected | `cd backend && python3.11 -m pytest --collect-only -q` |
| Frontend Vitest | **98** passed | `cd frontend && npx vitest run` |
| Playwright E2E | **18** tests | `e2e/*.spec.ts` (`test(` / `test.skip(` count) |

- `./scripts/verify.sh`: run on this documentation branch after updates (isolated Compose project)
- GitHub CI on PR #20 tip: PASS before merge
- Note: push to `main` after PR #20 (`2695306`) reported a Playwright strict-mode failure in `e2e/training-ux.spec.ts` (`heading` name `Datasets` matched two elements). Treat as a **tagging blocker** until re-verified; do not tag `v1.0.0-rc.1` while `main` CI is red. See `docs/KNOWN_LIMITATIONS.md` / release notes remaining work.

## Blockers

- `main` CI after PR #20 merge: Playwright `clone configuration opens editable create form` failed (strict mode: `getByRole('heading', { name: 'Datasets' })`). Documentation-only; fix in a separate follow-up before RC tagging.

## Next step

1. Clear the `main` Playwright CI failure (separate PR).
2. v1.0.0-rc.1 release smoke test and pre-release tagging (no tag/release in this docs PR).
