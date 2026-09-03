# Progress

## Current phase

**Enhancement Phase 1.5 — UX Architecture & Frontend UX Refactoring** is the current implementation phase.

Phase 1.5 implementation baseline documents are on `main`:

- [`phase-1.5-ux-architecture.md`](./phase-1.5-ux-architecture.md)
- [`phase-1.5-frontend-design-spec.md`](./phase-1.5-frontend-design-spec.md)

Phase **1.5-A — Shell & shared design system** is in progress on branch `cursor/phase1.5a-shell-design-system`.

The implementation strategy is direct incremental refactoring of the existing React frontend. Figma is optional, not a required handoff step.

## Current baseline

- Branch baseline: `main`
- Current main SHA at Phase 1.5 planning start: `4b8fd392d61bc0578012b1ec1e34fea519aeb2ef`
- Git tag: `v1.0.0-rc.1` (unchanged)
- Production domain: `modelflow.openlink.kr`

## Completed enhancement phases

### Phase 1 — Scheduling / Automation

Complete.

- DB-backed worker scheduler
- cron/timezone schedules
- data import, batch inference, pipeline run targets
- concurrency and retry policy
- run-now and schedule history UX

### Phase 1.1 — Retraining Foundation

Complete.

- canonical full-retraining flow
- explicit retrain lineage
- inherited configuration with fresh estimator and MLflow run
- retraining frontend flow and production smoke

### Phase 1.2 — Multi-output Regression

Complete implementation and deployed to production.

- multi-target regression training
- aggregate/per-target metrics
- MLflow/registry metadata
- named online multi-output predictions
- multi-column batch prediction output
- retrain/clone/retry compatibility
- production smoke follow-up fixes merged in PR #31

PR #31 also addressed:

- authenticated batch-result download
- model registration naming UX
- multi-output metric labels
- regression primary-metric selection logic
- prediction preview overflow
- approval comment preservation behavior
- Experiment Run detail
- deploy/runtime Git SHA propagation

## Latest verification baseline

At PR #31 merge:

| Suite | Result |
| --- | ---: |
| Backend pytest | **243 passed** |
| Frontend Vitest | **131 passed** |
| Playwright E2E | **21 passed** |
| `./scripts/verify.sh` | **PASS** |
| GitHub Actions | **PASS** |

Production deployment after PR #31 returned backend health `status: ok`, and post-deploy Git SHA propagation was verified with:

`4b8fd392d61bc0578012b1ec1e34fea519aeb2ef`

### Remaining targeted Phase 1.2 production revalidation

Implementation is complete, but two targeted UI/governance checks should not be silently treated as manually revalidated until explicitly confirmed:

1. newly registered post-deploy regression model displays the intended aggregate regression primary metric,
2. approval-request comment remains preserved when approval is submitted with a blank replacement comment.

These are follow-up production confirmation items, not blockers for drafting Phase 1.5 architecture.

## Phase 1.5 implementation order

### 1.5-A — Shell & shared design system

- grouped information architecture
- AppShell / Sidebar / Breadcrumb cleanup
- shared Page Header, status, action, form, table, and notice patterns
- existing dark engineering UI token normalization

### 1.5-B — Pipeline UX

- Node Library / Canvas / Inspector
- graph-readable condition branches while preserving `true` / `false` / `always`
- Validation Panel and dirty-state protection
- exact historical PipelineVersion graph support for Pipeline Run where needed
- graph-based execution view
- rerun-from-failed / reused-step presentation

### 1.5-C — ML lifecycle UX

- Dataset / Job / Experiment / Model / Deployment detail consistency
- lineage links
- full model lifecycle presentation
- multi-output target/metric presentation
- Prediction Test refinement

### 1.5-D — Operations & overview UX

- Workspace Home
- Project Overview
- Schedules
- Monitoring
- Alerts
- responsive refinements

## Phase 1.5 implementation rules

- Existing backend/API/auth/RBAC/runtime behavior is the functional source of truth.
- Phase 1.5 UX documents are the presentation/IA source of truth.
- Do not replace the frontend wholesale.
- Do not invent later-phase features.
- Use feature branches and Draft PRs.
- Run targeted tests and the full verification gate before merge.
- Browser review with realistic data is part of the UX acceptance process.

## Blockers

No architecture blocker is currently known.

The graph-based historical Pipeline Run UX may require a minimal read-only PipelineVersion lookup endpoint because the Run stores `pipeline_version_id` while the current Pipeline detail route returns the latest graph. This should be handled as a small Phase 1.5-B compatibility/read endpoint if confirmed during implementation.

## Next step

Complete review/merge of PR #32, then begin **Phase 1.5-A — Shell & shared design system** in a new feature branch.
