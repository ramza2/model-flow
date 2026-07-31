# Progress

## Current phase

Release/QA: independent re-verification of merged MVP on latest `main`, plus GitHub Actions CI and Docker image pinning. Draft PR (not merged).

## Baseline

- Branch: `cursor/ci-verify-image-pin-8cea` (from `origin/main`, not reusing PR #2 branch)
- Base commit: `762d892bb7f321cdf56f7b7cd8ab2dddaa3a76e7` — ModelFlow MLOps MVP — end-to-end platform (#2)

## Completed

- [x] Product docs + MVP implementation (merged via #2)
- [x] Fetch `origin/main` and create fresh work branch
- [x] Independent clean-volume baseline: `docker compose down -v` + `./scripts/verify.sh` **PASS**
- [x] GitHub Actions CI workflow (`.github/workflows/ci.yml`)
- [x] Pin external Docker images to pull-verified tags (MinIO, mc, Postgres, Node, nginx)
- [x] Harden `scripts/verify.sh` for non-interactive CI (EXIT trap + diagnostics)
- [x] Docs: README (CI badge, artifacts, security), ACCEPTANCE AC-26–30, DECISIONS, PROGRESS, AGENTS

## Blockers

None for local gate. GitHub Actions run status recorded in the Draft PR after push (do not assume PASS without observed run).

## Latest verify snapshot

Independent baseline on `762d892`: all required services healthy; backend tests; Playwright passed; inference OK.
