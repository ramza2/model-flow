# Enhancement Roadmap

Post–v1.0.0-rc.1 planning. This document tracks **future** work; the RC1 MVP scope is frozen in [`BACKLOG.md`](./BACKLOG.md) and [`RELEASE_NOTES_v1.0.0-rc.1.md`](./RELEASE_NOTES_v1.0.0-rc.1.md).

**Dependency principle:** scheduling and data-prep foundations precede full E2E pipeline UX; connectors and closed-loop MLOps build on stable pipelines; enterprise scale and visual redesign come after core product depth.

---

## Phase 0 — RC1 Baseline

- Release and documentation baseline (`v1.0.0-rc.1`, verify gate, acceptance criteria)
- Repository governance (branch protection, CI, tagged releases)

**Status:** complete at `92c59db`.

---

## Phase 1 — Scheduling / Automation

**Priority:** next

- Cron and timezone-aware scheduling
- Dataset generation / import schedules
- Batch prediction schedules
- Pipeline run schedules
- Run history, retry policy, and concurrency limits

**Depends on:** RC1 job worker and pipeline engine.

---

## Phase 1.5 — Figma UX Architecture

**Goal:** UX structure design, not visual polish.

- Information architecture (IA)
- Pipeline builder UX flows
- Node / Inspector interaction patterns
- Design system draft (components, states, validation feedback)

**Depends on:** Phase 1 requirements sketch; informs Phase 3 and Phase 9.

---

## Phase 2 — Multi Dataset / Visual Data Preparation

- Multiple input datasets per workflow
- Join / Union
- Filter / Select / Rename / Type Cast
- Computed Column
- Group By (SUM / AVG / MIN / MAX / COUNT)
- Pivot / Unpivot

**Depends on:** pipeline node model and dataset versioning from RC1.

---

## Phase 3 — E2E Pipeline UX

Single **Pipeline Canvas** for the full lifecycle:

Source → Transform → Quality → Train → Registry → Deploy → Predict → Monitor

- Shared Node / Inspector / validation / run-state UX across steps
- Consistent error and progress surfacing

**Depends on:** Phase 1.5 IA, Phase 2 transform nodes.

---

## Phase 4 — Data Source / Connector Expansion

- REST API data source
- SQL connector abstraction layer
- MySQL / MariaDB
- Microsoft SQL Server
- Oracle

**Depends on:** existing encrypted credential and import patterns from RC1.

---

## Phase 5 — Closed-loop MLOps

- Prediction vs ground-truth comparison
- Model quality monitoring over time
- Performance degradation alerts
- Automatic **retraining pipeline** trigger
- New model version lands as **CANDIDATE**
- **No** automatic PRODUCTION promotion — user approval required

**Depends on:** Phase 1 scheduling, Phase 3 E2E pipeline, monitoring from RC1.

---

## Phase 6 — Time-series Data Processing

- Wide-to-Long transforms
- Lag features
- Rolling windows
- Time-aware train/validation splits
- Forecasting model support — **out of initial scope**; follow-on after transforms stabilize

**Depends on:** Phase 2 data prep nodes.

---

## Phase 7 — LLM Pipeline Copilot

- Natural language → pipeline draft
- Pipeline schema validation against ModelFlow definitions
- Visual preview before apply
- User confirmation gate
- Natural-language modification via graph patch (not free-form execution)
- LLM generates **ModelFlow Pipeline Definition** only; does not run arbitrary code

**Depends on:** Phase 3 canvas UX and stable pipeline schema.

---

## Phase 8 — Enterprise / Scale-out

- Inference service separation from API/worker
- OIDC / SSO
- External secret management integration
- Kubernetes deployment and HA patterns
- Worker scale-out and GPU runner profiles

**Depends on:** production hardening feedback from earlier phases.

---

## Phase 9 — Final UI/UX Visual Redesign

- Figma-driven full visual redesign
- Typography, color, spacing, components, charts
- Responsive layout and accessibility polish

**Depends on:** Phase 1.5 design system and stabilized IA from Phases 1–3.
