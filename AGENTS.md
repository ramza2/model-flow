# AGENTS.md

## Cursor Cloud specific instructions

### Base tooling

Environment is defined by `.cursor/environment.json` → `.cursor/Dockerfile` (Ubuntu 24.04 with Git, Docker/Compose, Python 3.11, Node.js 22, npm, `psql`, curl, make).

- After boot, Docker daemon: `sudo service docker start` (or `sudo dockerd`) if needed. DinD uses `fuse-overlayfs` + `iptables-legacy`.
- Prefer `docker compose` (plugin), not legacy `docker-compose`.
- Prefer `python3.11` for backend work; some base images may still expose `python3` as 3.12.
- `psql` is the PostgreSQL **client** only; the server runs via Compose.
- `install` refreshes `backend/requirements.txt` and `frontend` npm deps only — never `compose up`, migrations, or dev servers.

### MVP day-to-day

ModelFlow MVP stack: FastAPI (`backend`), async worker (`python -m app.workers.runner`), React/Vite UI (`frontend`), Postgres, MLflow, MinIO via `docker compose`.

- Preferred full stack: run `./scripts/init-env.sh`, then `docker compose up --build -d` (see README). Host ports come from `.env` (`FRONTEND_HOST_PORT`, `BACKEND_HOST_PORT`, …); do not edit `docker-compose.yml` for local port conflicts.
- Full gate: `./scripts/verify.sh` (Compose + health + migrations + lint/tests in containers + API flow + Playwright container). Host needs Docker, Compose, curl, bash — not Node/npm/host Python.
- Same gate runs in GitHub Actions (`.github/workflows/ci.yml`) on PRs to `main`, pushes to `main`, and `workflow_dispatch`. Failure artifacts: `artifacts/verify/`, `artifacts/screenshots/`.
- External images are pinned (see `docs/DECISIONS.md` D-016). Do not switch back to `latest` without pull/run verification.
- Sample CSV: `samples/iris.csv` with target column `target`.
- Worker claims training, pipeline, batch inference, drift, and data-import work from Postgres (`FOR UPDATE SKIP LOCKED`) and writes a DB heartbeat for health checks; training uses `SklearnTrainingRunner` (`app/services/training.py`).

### Auth / secrets

ModelFlow v1 requires bearer authentication under `/api/v1`. On a clean database, set
`MODELFLOW_BOOTSTRAP_ADMIN_EMAIL` and `MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD` to create the
first system administrator. `MODELFLOW_SECRET_KEY` signs access tokens;
`MODELFLOW_ENCRYPTION_KEY` protects data-source secrets. Generate all local values with
`./scripts/init-env.sh`; it writes the ignored `.env` and prints bootstrap login
credentials once. Secret generation runs inside a throwaway `python:3.11-slim`
container so the host does not need Python or OpenSSL. Sign in with those
credentials and change the bootstrap password immediately. Compose rejects empty
required credentials. CI generates ephemeral values and must not depend on
production secrets or paid external services.



### Repository development workflow

These rules apply to all new enhancement work unless a task explicitly overrides them.

- Start from the latest `origin/main`; fetch first and report the actual base SHA used.
- Work only on a feature branch. Never commit directly to `main`.
- Create a **Draft PR** after implementation and verification. Do not mark Ready, merge, tag, release, or deploy unless explicitly requested.
- Preserve existing API/auth/RBAC/runtime behavior unless the task explicitly changes it.
- Do not weaken assertions, add broad skips, or remove regression coverage just to make CI pass. Fix the underlying defect.
- Run targeted tests while developing, then run `./scripts/verify.sh` before considering the implementation complete.
- Treat GitHub Actions on the exact PR HEAD as part of the verification evidence; do not claim CI PASS from an older SHA.
- For completion reports, include branch, base SHA, final HEAD SHA, Draft PR URL/number, changed-file count, targeted/full verification results, Alembic head when applicable, known limitations, and an explicit statement that the PR was not merged.
- Keep scope reviewable. Do not fold unrelated refactors, broad redesigns, or future-phase features into the current slice.
- Update roadmap/progress/decision/verification docs when the implementation changes the documented architecture or phase status.
- Current phase/status must come from repository docs (especially `docs/PROGRESS.md` and `docs/ENHANCEMENT_ROADMAP.md`), not from stale assumptions in prompts.

### Data-source connector architecture

Phase 4 establishes the reusable Data Source connector architecture. Read these before connector work:

- `docs/phase-4-connectors.md`
- `docs/ENHANCEMENT_ROADMAP.md`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`
- `backend/app/connectors/base.py`
- `backend/app/connectors/registry.py`
- existing connector implementations and their regression tests

Connector rules:

- Route source-specific connection test, discovery, preview, and tabular reads through the connector registry/contract. Do not add new source-specific orchestration directly to API or worker modules unless the connector contract genuinely cannot represent it.
- Reuse the existing ModelFlow orchestration for project scope, RBAC, audit, Data Source lifecycle, `DataImportJob`, immutable `DatasetVersion` materialization, and lineage. New connector types must not invent parallel job/version tables or bypass that lifecycle.
- Credentials are encrypted secrets. Never return plaintext passwords, DSNs, bearer tokens, API keys, or equivalent secrets through API responses, audit summaries, frontend edit state, logs, or errors.
- When editing a source, blank secret fields should preserve saved credentials only when the mode/auth semantics make that unambiguous. Mode switches must clear stale secrets that could override the newly selected configuration.
- Prefer typed connection forms for common connectors. Keep raw/advanced configuration as progressive disclosure rather than the default path.
- For SQLAlchemy-backed relational connectors, share only behavior that is truly common (identifier quoting, safe read-query validation, inspector discovery, bounded preview/read patterns). Keep driver, URL construction, default ports, connect args, transaction/read-only semantics, and database-specific schema behavior in the concrete connector.
- Preserve or strengthen read-only protections. Table imports and read-only `SELECT`/supported `WITH` queries may be allowed; mutations, DDL, multiple statements, stored-procedure execution, and write-back must not be enabled implicitly.
- Existing PostgreSQL and REST connector behavior is regression-critical. Connector refactors must keep their current tests and backward-compatibility semantics green.
- If a connector claims support for a real database engine, add a disposable integration fixture when practical. Do not rely only on mocks for connection/discovery/import behavior. Pin external service images; do not use `latest`.
- Integrated verification must not depend on paid services, production credentials, or uncontrolled public internet resources.
- New connector support should include backend contract tests, worker/import lineage tests, frontend form/import tests, and a representative browser E2E where practical.
- Security boundaries (secret redaction, URL/host handling, read-only behavior, response/query limits, error sanitization) are part of connector acceptance, not optional polish.

### Phase 1.5 frontend UX

For every Phase 1.5 frontend task, read these documents before changing user-visible behavior:

- `docs/phase-1.5-ux-architecture.md`
- `docs/phase-1.5-frontend-design-spec.md`
- `docs/ENHANCEMENT_ROADMAP.md`

Use this source-of-truth split:

**Functional source of truth**

- backend API contracts and persisted data,
- auth/RBAC/project scoping,
- training, registry, deployment, scheduling, and pipeline runtime semantics,
- existing supported frontend behavior and regression tests.

**UX / presentation source of truth**

- Phase 1.5 information architecture,
- navigation and page hierarchy,
- shared component/layout rules,
- Pipeline Builder / Pipeline Run presentation,
- status/action/validation presentation,
- responsive/accessibility behavior.

Phase 1.5 implementation discipline:

- modify the existing `frontend/src` incrementally; do not replace it wholesale,
- preserve routes and deep links unless a route change is explicitly approved,
- preserve existing API/auth/RBAC/runtime behavior,
- do not invent backend fields or later-phase features to satisfy a visual concept,
- avoid N+1 API requests added only for cosmetic labels,
- preserve multi-output target names and semantics,
- preserve the full model lifecycle (`CANDIDATE`, `VALIDATING`, `PENDING_APPROVAL`, `APPROVED`, `PRODUCTION`, `REJECTED`, `ARCHIVED`),
- preserve Pipeline condition-edge `true` / `false` / `always` semantics,
- historical Pipeline Run graph views must use the exact immutable PipelineVersion used by the run, not the latest graph,
- a minimal read-only PipelineVersion lookup may be added only if needed to render that persisted historical state correctly,
- preserve both project-scoped Audit Logs (`/projects/:projectId/audit`) and system-admin global Audit Logs (`/audit`); navigation must make their scope clear,
- use guided empty states, contextual help, progressive disclosure, and task-oriented copy to help less experienced users without blocking expert workflows,
- keep Advanced JSON as progressive disclosure rather than the default configuration path,
- keep the Phase 1.5 product-language baseline in English; broad localization is a separate decision/scope,
- run relevant unit/Playwright tests and then `./scripts/verify.sh` before merge,
- browser review with realistic data is required for major UX slices,
- work on a feature branch and create a Draft PR,
- do not mark Ready, merge, tag, or release unless explicitly requested.

Phase 1.5 is split into reviewable slices:

1. `1.5-A` — Shell & shared design system
2. `1.5-B` — Pipeline UX
3. `1.5-C` — ML lifecycle UX
4. `1.5-D` — Operations & overview UX

Phase 1.5 normalizes the current dark engineering UI; the broad Figma-driven final visual redesign remains Phase 9.
