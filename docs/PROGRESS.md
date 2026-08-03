# Progress

## Current phase

**Release Review remediation COMPLETE** on `cursor/modelflow-v1-rc-71f2` / Draft PR #4 (not merged).

## Baseline

- Base commit: `df2fc421d32fa2c6fbcd7fd86f0fad4c2c10173b`
- Draft PR: https://github.com/ramza2/model-flow/pull/4

## Remediation completed

1. Legacy unauthenticated `/api` router removed (health-only `/api/health`)
2. Hardcoded credentials removed; `scripts/init-env.sh` + required Compose env
3. Server-side model gates (client `gates_passed` removed)
4. Pipeline parallel nodes, condition branches, restart-from-failed, schedules
5. Logout bumps `token_version` (all user tokens revoked)
6. Backup/restore destructive round-trip in verify
7. RBAC isolation tests + Playwright role menus
8. Security gate fails on High/Critical unless allowlisted
9. AC evidence columns; contested items re-verified to PASS

## Latest local gate

```text
docker compose down -v --remove-orphans
rm -f .env
./scripts/init-env.sh --non-interactive-test
./scripts/verify.sh
→ PASS (backend 37; frontend 3; Playwright 5)
```

## Blockers

None.
