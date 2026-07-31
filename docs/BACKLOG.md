# Backlog — ModelFlow v1.0 RC

Phases execute sequentially without waiting for user approval. Mark items done in PROGRESS.md as they complete.

## Phase 1 — Foundation

- [ ] `/api/v1` versioning; consistent errors; correlation ID; structured logging
- [ ] Extend models + Alembic migration(s) for v1.0 schema
- [ ] Keep Compose healthchecks; worker heartbeat
- [ ] Preserve MVP train path while extending

## Phase 2 — Auth / Users / RBAC

- [ ] Bootstrap admin from env
- [ ] Login / logout / me / password change
- [ ] User CRUD (admin), activate/deactivate
- [ ] JWT + expiry; bcrypt; lockout / rate limit
- [ ] Project membership; role permissions; 403 path
- [ ] Frontend protected routes + role menus

## Phase 3 — Data sources & datasets

- [ ] File sources CSV/JSON/Parquet
- [ ] Postgres source: register, test, schema/table, import
- [ ] Encrypt secrets; no plaintext in API/logs
- [ ] Dataset versions, profiling, preview, compare, lineage
- [ ] Quality rules + checks; train policy on FAIL
- [ ] Train/val/test splits with seed

## Phase 4 — Training & experiments

- [ ] Classification: LR, RF, GB
- [ ] Regression: Ridge, RF, GB
- [ ] Preprocessing + feature select + metrics
- [ ] Job lifecycle: queue, cancel, retry, clone, concurrency limits
- [ ] MLflow params/metrics/artifacts enrichment
- [ ] Experiment UI: filter, sort, compare, charts

## Phase 5 — Visual Pipeline

- [ ] React Flow builder; design vs run views
- [ ] Node types (load, quality, split, preprocess, train, eval, condition, register, approve, deploy, batch, notify)
- [ ] Validate DAG; versions; draft/publish; import/export
- [ ] Pipeline engine on worker; parallel independent nodes; restart from failed
- [ ] E2E pipeline path to registry

## Phase 6 — Registry & approval

- [ ] States: CANDIDATE → … → PRODUCTION / REJECTED / ARCHIVED
- [ ] Gates; approve/reject; promote; rollback; audit
- [ ] Lineage + version compare

## Phase 7 — Serving & batch

- [ ] Endpoint CRUD, start/stop, swap, rollback, health, schema, test predict
- [ ] Latency/error counters; feature schema validation
- [ ] Batch jobs + MinIO results + download
- [ ] Inference log retention setting (default: no raw input)

## Phase 8 — Monitoring / drift / retrain

- [ ] Service / data / model monitoring panels (empty states, no fake metrics)
- [ ] PSI / KS / categorical distance drift
- [ ] Alerts; retrain triggers without auto-prod swap

## Phase 9 — Admin / audit / ops

- [ ] Admin screens: users, membership, system, workers, queue, storage, audit, settings, alerts, retention
- [ ] Soft vs hard delete policy documented + applied
- [ ] Audit search/filter/detail UI

## Phase 10 — UI/UX

- [ ] App shell: header, sidebar, project selector, user menu, alerts, breadcrumb
- [ ] All menus wired to real APIs; no mock data
- [ ] Wizards, toasts, confirmation, a11y basics, pagination

## Phase 11 — Security / performance / scripts

- [ ] Security headers, CORS, rate limit, validation, XSS/SQLi hygiene
- [ ] `backup.sh` / `restore.sh` / `reset-dev.sh` / `seed-demo.sh`
- [ ] Dependency vulnerability scan in CI (informational / non-breaking)

## Phase 12 — Release verification

- [ ] Extend verify.sh for auth + all E2E-01..09 gates
- [ ] Playwright scenarios
- [ ] Clean volume PASS
- [ ] GitHub Actions PASS
- [ ] Screenshots/video evidence
- [ ] Draft PR with full report; AC table all PASS
