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
