# Enhancement Roadmap

Post–v1.0.0-rc.1 planning. This document tracks **future** work; the RC1 MVP scope is frozen in [`BACKLOG.md`](./BACKLOG.md) and [`RELEASE_NOTES_v1.0.0-rc.1.md`](./RELEASE_NOTES_v1.0.0-rc.1.md).

**Dependency principle:** scheduling and retraining foundations precede broader pipeline/data-prep expansion; enterprise scale and final visual redesign come after core product depth.

---

## Phase 0 — RC1 Baseline

- Release and documentation baseline: **complete** (`v1.0.0-rc.1`, verify gate, acceptance criteria)
- Tagged release / CI baseline: **complete**
- Repository governance / branch protection: **pending**

---

## Phase 1 — Scheduling / Automation

**Status:** complete

Implemented scope:

- Cron and timezone-aware scheduling
- Dataset import, batch prediction, and pipeline run schedules
- `AutomationSchedule` + `AutomationScheduleRun` history
- Concurrency policies and retry policy
- Missed-run coalescing
- Run now, enable/disable, project-scoped REST API, Schedules UI
- Docs: [`SCHEDULING.md`](./SCHEDULING.md)

---

## Phase 1.1 — Retraining Foundation

**Status:** complete

Implemented scope:

- canonical full-retrain flow from a succeeded source Training Job
- explicit `retrain_source_job_id` lineage separate from retry/clone lineage
- inherited training configuration with a fresh estimator and fresh MLflow run
- target dataset-version selection and compatibility validation
- retrain UX and lineage presentation

Retraining here means a new full fit, not incremental/continued training.

---

## Phase 1.2 — Multi-output Regression

**Status:** complete

Implemented scope:

- multiple numeric targets in one regression model
- backward-compatible single-target behavior
- target-aware training, metrics, MLflow metadata, registry metadata, deployment, online prediction, and batch prediction
- aggregate and per-target metrics
- named multi-output prediction responses
- production smoke follow-up fixes for registry UX, prediction overflow, experiment run detail, batch download, approval comment preservation, and deploy Git SHA propagation

---

## Phase 1.5 — UX Architecture & Frontend UX Refactoring

**Status:** current planning / implementation phase

**Goal:** establish a coherent product-wide UX architecture and incrementally refactor the existing React frontend before broader data-prep and pipeline expansion.

Phase 1.5 does **not** require a Figma handoff. The current production React frontend is modified directly using the approved UX documents as the presentation source of truth. Figma may be used later for focused exploration, and Phase 9 remains the final broad visual redesign stage.

### Implementation references

- [`phase-1.5-ux-architecture.md`](./phase-1.5-ux-architecture.md)
- [`phase-1.5-frontend-design-spec.md`](./phase-1.5-frontend-design-spec.md)

### Scope

- lifecycle-first information architecture
- grouped project navigation
- consistent page and entity-detail patterns
- English product terminology normalization; broad localization is out of scope
- shared status/action/validation/error UX
- shared frontend component/token normalization
- three-zone Pipeline Builder: Node Library / Canvas / Inspector
- graph-readable `TRUE` / `FALSE` condition branches while preserving existing `always` edge semantics
- guided pipeline validation recovery
- graph-based Pipeline Run view using the exact immutable pipeline version used by the run
- rerun-from-failed / reused-step presentation
- consistent Dataset / Training / Experiment / Model / Deployment lifecycle UX
- Monitoring, Alerts, Scheduling, Workspace Home, and Project Overview refinement
- desktop-first responsive and accessibility baseline
- browser-based visual review and regression testing

### Implementation slices

1. **Phase 1.5-A — Shell & shared design system**
2. **Phase 1.5-B — Pipeline UX**
3. **Phase 1.5-C — ML lifecycle UX**
4. **Phase 1.5-D — Operations & overview UX**

A minimal read-only PipelineVersion lookup may be added in Phase 1.5-B if needed to render the correct historical graph for a Pipeline Run. This is a compatibility/readability endpoint only, not a runtime-semantic change.

### Principles

1. Existing backend/API/auth/RBAC/runtime behavior remains the functional source of truth.
2. Phase 1.5 documents are the source of truth for IA, navigation, layout, component hierarchy, and presentation.
3. Do not invent future-phase functionality merely to complete a visual concept.
4. Manual training remains supported; pipelines become the preferred repeatable workflow UX.
5. Phase 1.5 normalizes the current dark engineering UI but does not replace Phase 9 final visual polish.

---

## Phase 2 — Multi-dataset & Visual Data Preparation

- Multiple input datasets per workflow
- Join / Union
- Filter / Select / Rename / Type Cast
- Computed Column
- Group By (SUM / AVG / MIN / MAX / COUNT)
- Pivot / Unpivot

**Depends on:** stable Phase 1.5 pipeline interaction patterns and existing dataset versioning.

---

## Phase 3 — End-to-End Pipeline UX

Expand the stabilized Pipeline Canvas across the full lifecycle and the new Phase 2 data-preparation capabilities:

`Source → Transform → Quality → Train → Registry → Deploy → Predict → Monitor`

- shared Node / Inspector / validation / run-state UX across expanded steps
- consistent error and progress surfacing
- end-to-end lifecycle navigation and lineage

**Depends on:** Phase 1.5 UX architecture and Phase 2 transform capabilities.

---

## Phase 4 — Connectors

- REST API data source
- SQL connector abstraction layer
- MySQL / MariaDB
- Microsoft SQL Server
- Oracle

**Depends on:** existing encrypted credential and import patterns plus stable data-source UX.

---

## Phase 5 — Closed-loop MLOps

- Prediction vs ground-truth comparison
- Model quality monitoring over time
- Performance degradation alerts
- Automatic **full retraining pipeline** trigger
- New model version lands as **CANDIDATE**
- **No automatic PRODUCTION promotion** — user approval required

**Depends on:** scheduling, stable pipeline UX/runtime, and monitoring foundations.

---

## Phase 5.1 — Incremental / Continued Training

- supported-algorithm-only continued learning
- `partial_fit`, warm-start, or equivalent capability where technically valid
- explicit distinction from full retraining
- lineage and compatibility rules for continued training

**Depends on:** stable full-retraining semantics and closed-loop workflow foundations.

---

## Phase 6 — Time-series / Multi-step

- time-aware data processing
- Wide-to-Long transforms where useful
- lag features
- rolling windows
- time-aware train/validation splits
- time-series forecasting model support
- multi-step outputs and combinations with multi-output targets where supported

**Depends on:** Phase 2 data-prep capabilities.

---

## Phase 7 — LLM Pipeline Copilot

- natural language → pipeline draft
- pipeline schema validation against ModelFlow definitions
- visual preview before apply
- user confirmation gate
- natural-language modification via graph patch, not free-form execution
- LLM generates ModelFlow Pipeline Definition only; it does not run arbitrary code

**Depends on:** stable pipeline schema and UX.

---

## Phase 8 — Enterprise / Scale

- inference service separation from API/worker
- OIDC / SSO
- external secret management integration
- Kubernetes deployment and HA patterns
- worker scale-out and GPU runner profiles

**Depends on:** production hardening feedback from earlier phases.

---

## Phase 9 — Final Visual Redesign

- Figma-driven product-wide final visual redesign
- final typography, color, spacing, iconography, components, and charts
- accessibility and responsive polish beyond the Phase 1.5 structural baseline
- visual consistency pass after major product workflows have stabilized

**Depends on:** stabilized IA and workflows from Phases 1.5–3 and later product depth.
