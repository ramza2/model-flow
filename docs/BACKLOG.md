# Backlog — ModelFlow v1.0 RC

Phases execute sequentially without waiting for user approval. Mark items done in PROGRESS.md as they complete.

## Phase 1 — Foundation

- [x] `/api/v1` versioning; consistent errors; correlation ID; structured logging
- [x] Extend models + Alembic migration(s) for v1.0 schema
- [x] Keep Compose healthchecks; worker heartbeat
- [x] Preserve MVP train path while extending

## Phase 2 — Auth / Users / RBAC

- [x] Bootstrap admin from env
- [x] Login / logout / me / password change
- [x] User CRUD (admin), activate/deactivate
- [x] JWT + expiry; bcrypt; lockout / rate limit
- [x] Project membership; role permissions; 403 path
- [x] Frontend protected routes + role menus

## Phase 3 — Data sources & datasets

- [x] File sources CSV/JSON/Parquet
- [x] Postgres source: register, test, schema/table, import
- [x] Encrypt secrets; no plaintext in API/logs
- [x] Dataset versions, profiling, preview, compare, lineage
- [x] Quality rules + checks; train policy on FAIL
- [x] Train/val/test splits with seed

## Phase 4 — Training & experiments

- [x] Classification: LR, RF, GB
- [x] Regression: Ridge, RF, GB
- [x] Preprocessing + feature select + metrics
- [x] Job lifecycle: queue, cancel, retry, clone, concurrency limits
- [x] MLflow params/metrics/artifacts enrichment
- [x] Experiment UI: filter, sort, compare, charts

## Phase 5 — Visual Pipeline

- [x] React Flow builder; design vs run views
- [x] Node types (load, quality, split, preprocess, train, eval, condition, register, approve, deploy, batch, notify)
- [x] Validate DAG; versions; draft/publish; import/export
- [x] Pipeline engine on worker; parallel independent nodes; restart from failed
- [x] E2E pipeline path to registry

## Phase 6 — Registry & approval

- [x] States: CANDIDATE → … → PRODUCTION / REJECTED / ARCHIVED
- [x] Gates; approve/reject; promote; rollback; audit
- [x] Lineage + version compare

## Phase 7 — Serving & batch

- [x] Endpoint CRUD, start/stop, swap, rollback, health, schema, test predict
- [x] Latency/error counters; feature schema validation
- [x] Batch jobs + MinIO results + download
- [x] Inference log retention setting (default: no raw input)

## Phase 8 — Monitoring / drift / retrain

- [x] Service / data / model monitoring panels (empty states, no fake metrics)
- [x] PSI / KS / categorical distance drift
- [x] Alerts; retrain triggers without auto-prod swap

## Phase 9 — Admin / audit / ops

- [x] Admin screens: users, membership, system, workers, queue, storage, audit, settings, alerts, retention
- [x] Soft vs hard delete policy documented + applied
- [x] Audit search/filter/detail UI

## Phase 10 — UI/UX

- [x] App shell: header, sidebar, project selector, user menu, alerts, breadcrumb
- [x] All menus wired to real APIs; no mock data
- [x] Wizards, toasts, confirmation, a11y basics, pagination

## Phase 11 — Security / performance / scripts

- [x] Security headers, CORS, rate limit, validation, XSS/SQLi hygiene
- [x] `backup.sh` / `restore.sh` / `reset-dev.sh` / `seed-demo.sh`
- [x] Dependency vulnerability scan in CI (High/Critical fail closed; allowlist with expiry)

## Phase 12 — Release verification

- [x] Extend verify.sh for auth + all E2E-01..09 gates
- [x] Playwright scenarios
- [x] Clean volume PASS
- [x] GitHub Actions PASS on `main` tip (`2d2f3da`, run #100)
- [x] Screenshots/video evidence
- [x] Acceptance criteria table maintained; release docs for RC
