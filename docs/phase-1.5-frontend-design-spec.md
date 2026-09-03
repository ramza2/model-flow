# ModelFlow Phase 1.5 Frontend Design Specification

Status: **Proposed implementation baseline**  
Audience: Frontend engineers, Cursor Agents Window, QA  
Companion document: `docs/phase-1.5-ux-architecture.md`

## 1. Purpose

This document turns the Phase 1.5 UX architecture into concrete frontend implementation rules.

The existing React application remains the functional baseline. This specification defines the target shell, visual system normalization, reusable components, page composition, Pipeline Builder layout, execution-state presentation, responsive behavior, and implementation quality bar.

This is **not** permission to replace `frontend/src` wholesale. Implement Phase 1.5 incrementally inside the existing application while preserving supported behavior.

### Functional vs presentation authority

- Backend/API/auth/RBAC/persistence/runtime behavior and supported frontend workflows are the **functional source of truth**.
- `phase-1.5-ux-architecture.md` and this document are the **UX/presentation source of truth**.
- Existing layouts may therefore be restructured even when functionality is preserved.
- Do not invent backend fields or semantics to make a mock layout easier to implement.

## 2. Visual baseline and Phase 9 boundary

The current ModelFlow frontend already uses a dark engineering-oriented identity. Phase 1.5 should systematize that identity rather than introduce a new brand aesthetic.

Recommended normalized values:

```text
Canvas / background      #0F1419
Primary surface          #171E26
Soft surface             #1C2530
Border                   #2A3542
Primary text             #E8EEF4
Muted text               #9AABBC
Primary accent           #3DB8A0
Warm accent              #F0A45D
Success                  #5ECF8A
Warning                  #E0C35A
Danger                   #E86A6A
Technical/code surface   #0A0E12
```

Typography baseline:

- `DM Sans` for interface text,
- `IBM Plex Mono` for code/JSON/log/technical metadata.

These values are an implementation normalization target, **not the final visual redesign**. Phase 9 remains responsible for broader Figma-driven visual/brand polish after IA and core workflows stabilize.

## 3. Visual direction

ModelFlow should feel like a professional MLOps / DevOps / data-engineering product.

Prefer:

- restrained dark UI,
- compact but readable information density,
- clear hierarchy,
- strong lifecycle/status communication,
- reusable engineering patterns,
- technical data that remains easy to inspect.

Avoid:

- consumer-style oversized cards,
- marketing-page typography,
- decorative AI gradients,
- neon/glassmorphism-heavy styling,
- emoji as the final primary navigation icon system,
- excessive shadows,
- excessive whitespace,
- one-off page-specific visual languages.

Current Unicode icons may be replaced incrementally with a consistent accessible icon set, but icon replacement must not become a blocking prerequisite for the structural UX work.

## 4. Layout tokens

Use a 4px base spacing grid.

```text
space-1   4px
space-2   8px
space-3   12px
space-4   16px
space-5   20px
space-6   24px
space-8   32px
space-10  40px
space-12  48px
space-16  64px
```

Recommended radii:

```text
control   8px
card      10px
large     12px
pill      999px
```

Use shadows sparingly, mainly for menus, drawers, and modals.

## 5. Typography

| Token | Size / line-height | Weight | Use |
| --- | --- | --- | --- |
| Display | 32 / 40 | 700 | Rare hero use |
| H1 | 28 / 36 | 700 | Page title |
| H2 | 20 / 28 | 700 | Major section |
| H3 | 16 / 24 | 600 | Card/subsection title |
| Body | 14 / 20 | 400 | Standard text |
| Body Strong | 14 / 20 | 600 | Emphasis |
| Small | 12 / 16 | 400 | Metadata |
| Label | 12 / 16 | 600 | Form labels |
| Eyebrow | 11 / 16 | 700 | Group/category heading |
| Mono | 12 / 18 | 400 | IDs, JSON, SHA, logs |

Do not create page-specific typography scales.

## 6. Standard desktop shell

### Reference viewport

Normal pages should be comfortable around `1440 × 1024`.

Pipeline editing should also be evaluated around `1600 × 1000` because the Canvas requires width.

### Top bar

```text
Height: ~64px
Position: sticky
```

Contents:

```text
ModelFlow | Project picker                              Alerts | User menu
```

The project picker remains a persistent global control. Changing projects navigates to the selected project's Overview.

### Sidebar

Target desktop width: approximately `256px`.

Use this grouped IA:

```text
WORKSPACE
Home
Projects

PROJECT
Overview

DATA
Data Sources
Datasets

BUILD
Pipelines
Training Jobs
Experiments

MODELS & SERVING
Model Registry
Deployments

OPERATIONS
Schedules
Monitoring
Alerts

GOVERNANCE
Audit Logs
```

System administrators additionally see Administration.

Active navigation uses background + stronger text/icon + a structural indicator and must not rely on color alone.

## 7. Content area and Page Header

Normal pages:

```text
Horizontal padding: ~32px
Top padding: 20–24px
Bottom padding: ~64px
```

Builder pages may consume almost all available width.

Shared Page Header:

```text
Page title                           Actions
Short description
```

Normal pages should have one visually dominant primary action.

## 8. Breadcrumbs

Prefer human-readable names where they are already available without wasteful API traffic.

Preferred:

`Projects / Phase1 Smoke Test / Training Jobs / Multi Output Smoke Training`

Acceptable fallback:

`Projects / Phase1 Smoke Test / Training Jobs / #3`

Do not add N+1 entity lookups only to cosmetically replace IDs.

## 9. Buttons

Primary:

```text
Height: ~40px
Padding: 0 16px
Radius: 8px
Background: accent
Font: 14px / 600
```

Secondary:

- transparent or surface background,
- default border,
- primary text.

Danger:

- danger-tinted treatment,
- destructive actions must not compete visually with the normal primary task.

All button families support default, hover, focus-visible, disabled, and loading states where relevant.

## 10. Forms and multi-select

Recommended control height: ~40px.

Labels appear above controls. Field-specific errors appear directly below the affected control.

Use progressive disclosure for advanced technical configuration. Raw JSON is not the default UI for normal configuration.

Targets and similar fields use a reusable multi-select.

```text
Targets
[cooling_load ×] [power_usage ×]
```

Always show actual target names, never target indexes.

## 11. Cards, tables, and technical blocks

### Cards

```text
Background: surface
Border: 1px
Radius: 10px
Padding: 16–20px
```

Keep engineering cards compact.

### Tables

```text
Header height: ~40px
Row min height: ~48px
Cell vertical padding: ~12px
```

Entity name is primary; technical ID/metadata is secondary. Prefer horizontal internal scrolling to illegible compression.

### Technical blocks

Use `IBM Plex Mono`, `#0A0E12`, border, and ~8px radius.

JSON, logs, model URIs, long names, URLs, and SHAs must never escape their container. Use internal scrolling and/or safe wrapping.

## 12. Status Badge and actual state coverage

Every status uses icon + text + semantic treatment.

Recommended badge height: ~24px.

The shared component must safely handle actual product states including, but not limited to:

```text
neutral:
Draft, Stopped, Archived, Unknown, Inactive

progress:
Pending, Queued, Dispatched, Running, Validating,
Pending Approval, Cancel Requested

success:
Succeeded, Passed, Approved, Production, Published, Ready, Active

warning:
Warning, Partial, Degraded, Attention, Skipped

negative:
Failed, Fail, Rejected, Blocked, Error, Cancelled, Critical

pipeline-specific:
Waiting, Reused
```

Display formatting may humanize underscores/case, but transport/persistence values remain unchanged.

## 13. Notices, empty, loading, and confirmations

Notices should explain what happened and what to do next when possible.

Bad:

`400 validation error`

Better:

```text
Pipeline validation failed.
3 steps need configuration.

View issues →
```

Empty states explain why the area is empty and provide a useful next action.

Loading should be localized to the affected content region where possible.

Confirmations are primarily for destructive actions, availability-impacting actions, or unsaved data loss.

## 14. Modal and Drawer

Default modal width: ~560px.

Right drawer widths:

```text
Default: 400px
Large:   520px
```

Good drawer uses include Schedule Create and compact-width Inspector fallback.

The desktop Pipeline Inspector is normally a persistent panel, not an overlay.

## 15. Common entity-detail pattern

Use the same visual hierarchy for Dataset, Job, Run, Model Version, Deployment, and related detail pages:

```text
Breadcrumb

Entity name                         Status
Context                             Actions

Summary / key metrics
Configuration / metadata
Lineage
Activity / history
Technical details / logs
```

## 16. Role-gated actions

Do not weaken backend authorization.

Prefer keeping readable lifecycle context visible and hiding/disabling mutation actions based on existing role checks.

Role baseline:

- Viewer: read only.
- Data Scientist: datasets/training/experiments.
- ML Engineer: pipelines/registry/deployments/schedules.
- Project Admin: project-wide management/governance.
- System Admin: platform administration/global audit.

## 17. Screen targets

The following 20 states define Phase 1.5 implementation review targets. They are running-product states, not required Figma deliverables.

### 01 — Workspace Home

Purpose: workspace/current-project status and next actions.

Use current data sources for:

- Projects,
- Datasets,
- Training Jobs,
- Failed Jobs,
- Deployments,
- Unread Alerts,
- recent training jobs,
- next actions.

Do not turn this into a marketing landing page.

### 02 — Project Overview

Purpose: lifecycle control center.

Prefer directly measurable summaries such as:

- datasets and latest version signal,
- active/failed training jobs,
- model lifecycle counts when efficiently available,
- ready deployments,
- open alerts.

Do not invent an undocumented `Healthy` formula. If a synthesized health badge is introduced, define its rule explicitly and derive it only from existing metrics.

Members/access remain secondary and only visible to authorized users.

### 03 — Dataset Detail

Header actions:

- `Train on dataset` primary where permitted,
- `Use in pipeline` secondary where permitted.

Organize current data around:

- Overview,
- Versions,
- Schema & Profile,
- Quality,
- Splits where useful,
- Lineage where existing relationships allow it.

Do not hide existing quality-rule/check/split functionality merely to match a simpler mock layout.

### 04 — Training Job Detail

Header actions may include:

- Retrain,
- Clone configuration,
- Open experiment,
- Register model.

Summary:

- Dataset/version,
- Problem type,
- Algorithm,
- Targets,
- Features,
- Split/seed.

Metrics:

- aggregate first,
- per-target by actual target name.

### 05 — Experiments

Primary mental model: compare training executions.

Use search/filter controls, selection checkboxes, clickable run name, status, algorithm, targets, primary metric, started time, and `Compare selected`.

### 06 — Experiment Run Detail

Technical detail page.

Show existing run metadata, logged metrics, parameters, tags, and lineage links that can be derived reliably. Raw MLflow-style keys are acceptable here.

### 07 — Pipeline List

Primary action: `New pipeline`.

Baseline columns supported without additional aggregation:

```text
Pipeline | Status | Version | Type | Created
```

`Last run` or `Updated` may be added only if data is provided efficiently by an existing or separately approved API change. Do not introduce per-row N+1 requests just for these columns.

### 08 — Pipeline Builder / Empty

Use the three-zone Builder defined below.

Empty Canvas:

```text
Build your first workflow

Drag a step from the Node Library
or click a step to add it.
```

A quick-start template action is optional only if it maps to supported behavior; do not fake template application.

### 09 — Pipeline Builder / Configured

This is the Phase 1.5 hero implementation state.

Use the Golden Path graph. Select Training and show its configuration in the Inspector.

### 10 — Pipeline Builder / Validation Errors

Show invalid nodes highlighted, structured Validation Panel, selected issue, and corresponding Inspector context. Field focus is best-effort when backend validation returns only strings.

### 11 — Pipeline Run / Running

Reuse the exact run-version graph in read-only execution mode. Show finished/running/waiting states and execution Inspector.

### 12 — Pipeline Run / Failed

Show failed node, reused upstream nodes after rerun when applicable, error/log details, and `Rerun from failed`.

### 13 — Model Registry

Lifecycle filters must cover the supported lifecycle:

```text
All
Candidate
Validating
Pending Approval
Approved
Production
Rejected
Archived
```

If a state is uncommon, it may be placed in an overflow/filter menu, but it must remain reachable.

Table:

- Model,
- Version,
- Lifecycle,
- Gates,
- Primary metric,
- Registered.

### 14 — Model Version Detail

Represent the actual lifecycle including alternate/terminal paths.

Primary path:

```text
Candidate → Validating (when applicable) → Pending Approval → Approved → Production
```

Alternate path:

```text
Pending Approval → Rejected
```

`Archived` is an inactive terminal state.

Sections:

- Quality / metrics,
- Governance,
- Approval evidence,
- Lineage,
- Deployment context where available.

Preserve existing approval comment visibility.

### 15 — Deployments

Use compact deployment cards/list items with:

- name,
- status,
- model/version,
- request count,
- success rate,
- average/p95 latency where available.

Actions:

- Test prediction primary,
- API usage secondary,
- Stop/start lower-priority operational action.

### 16 — Prediction Test

Use two-column Request / Response layout on desktop.

Show expected input schema, JSON instances, Run prediction, named-output preview, and full response.

For multi-output predictions:

```json
{
  "cooling_load": 8.2226,
  "power_usage": 11.9283
}
```

Long output must remain contained.

### 17 — Monitoring

Organize current monitoring capability around:

- Service Health,
- Data Health,
- Model Health.

Top summary may say `All systems healthy` only when an explicit simple rule is defined from current metrics. Otherwise use factual attention summaries.

Do not invent unsupported SLO/drift workflows.

### 18 — Alerts

Use actionable alert items/cards based on existing fields:

- severity,
- title,
- message,
- timestamp,
- unread/resolved state,
- related-resource link when `link_path` exists,
- Resolve when authorized.

Do not invent a separate structured resource field if the API does not provide one.

### 19 — Schedule Create

Prefer a right-side Drawer while keeping the Schedules context visible.

Basic fields first:

- Name,
- Target type,
- target-dependent resource fields,
- frequency/cron preset,
- Timezone,
- Concurrency,
- Retry policy.

Advanced collapsed:

- raw Cron expression,
- pipeline Parameters JSON where applicable.

Preserve current target-dependent behavior for `pipeline_run`, `batch_inference`, and `data_import`.

### 20 — Responsive Shell

Validate at least:

- `1280 × 900`,
- `1024 × 768`,
- approximately `768px` narrow management/read view.

Complex mobile pipeline editing is out of scope.

## 18. Pipeline Builder core layout

The current mixed sidebar model must converge toward:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Pipeline header / status / actions                                      │
├──────────────┬─────────────────────────────────────┬─────────────────────┤
│ NODE LIBRARY │               CANVAS                │ INSPECTOR           │
│ ~220px       │             flexible                │ ~340px              │
├──────────────┴─────────────────────────────────────┴─────────────────────┤
│ Validation / execution console when needed                              │
└──────────────────────────────────────────────────────────────────────────┘
```

The Canvas owns the remaining width and must remain visually dominant.

## 19. Node Library

Provide search and grouped compact node types:

```text
DATA
Dataset Load
Quality Check
Split
Preprocessing

TRAIN
Training
Evaluation

LOGIC
Condition

MODEL LIFECYCLE
Model Registration
Approval Request

SERVING
Endpoint Deployment
Batch Prediction

OPERATIONS
Notification
```

Interaction intent:

- drag to Canvas,
- click-to-add alternative.

Do not depend exclusively on drag-and-drop.

## 20. Pipeline Node and states

Recommended node width: `190–220px`, minimum height around `96px`.

Show concise information only:

```text
TRAINING
Train demand model

Ridge
2 targets
3 features
```

Detailed configuration belongs in Inspector.

Visual states should support:

- default,
- selected,
- warning,
- error,
- running,
- succeeded,
- waiting/pending,
- skipped,
- reused.

Avoid excessive animation.

## 21. Pipeline Inspector

No node selected:

- pipeline name,
- description,
- version,
- status.

Training selected:

```text
TRAINING
Step name

INPUT
Dataset / version
Available columns

CONFIGURATION
Targets
Problem type
Algorithm
Features
Hyperparameters

ADVANCED
JSON configuration (collapsed)

DANGER
Remove step
```

Use upstream dataset information where available instead of making the user re-enter schema context.

## 22. Condition UX and backward compatibility

Condition branching should be visually explicit on the graph.

```text
          Condition
         /    |    \
      TRUE  FALSE  ALWAYS
```

TRUE/FALSE are the primary decision branches. `ALWAYS` remains supported because the existing graph contract persists `true`, `false`, and `always` edge semantics.

Do not delete, reinterpret, or silently migrate existing `always` edges as part of a visual refactor.

## 23. Save / Validate / Publish / Run

These are different actions and should not look interchangeable.

Dirty:

```text
Draft v5    Unsaved changes
Primary: Save version
Publish: disabled
Run: disabled
```

Saved draft:

```text
Draft v5
Validate
Publish
Run according to current supported runtime semantics
```

Published:

```text
Published v4
Validate
Schedule
Primary: Run pipeline
```

Important: the UI may strongly guide users toward publishing before operational use, but Phase 1.5 must **not falsely claim** that the backend forbids every run of an unpublished valid version if the current API does not enforce that rule.

Preserve dirty-state blocking for Publish/Run as it exists today.

## 24. Unsaved navigation guard

When leaving with dirty Pipeline changes:

```text
Unsaved pipeline changes

Your latest changes have not been saved as a pipeline version.

Discard changes        Keep editing
```

Do not imply graph auto-save.

## 25. Validation Panel

Represent validation as structured issues even when the backend response starts as a string list.

```text
VALIDATION
3 issues

Training
Target selection is required                         →

Split
Train + validation + test ratios must equal 1.0     →

Endpoint Deployment
Model source is missing                              →
```

Selecting an issue should, where technically practical:

- center/focus the node,
- select it,
- open Inspector context,
- identify the affected field.

Do not invent structured backend error fields that do not exist.

## 26. Golden Path

Use this representative graph:

```text
Dataset Load
    ↓
Quality Check
    ↓
Split
    ↓
Training
    ↓
Evaluation
    ↓
Condition
  ↙      ↘
TRUE    FALSE
 ↓        ↓
Model    Notification
Registration
 ↓
Approval Request
 ↓
Endpoint Deployment
 ↓
Notification
```

Existing workflows may also contain `ALWAYS` edges.

Avoid excessive edge crossing.

## 27. Pipeline Run exact-version visual model

Pipeline Run reuses the Builder graph language in read-only mode.

The graph must represent the **exact immutable pipeline version used by the run**, keyed by the run's `pipeline_version_id`; never substitute the current latest graph.

If the frontend cannot fetch that immutable graph through an existing API, Phase 1.5-B may add a minimal read-only lookup endpoint for a persisted PipelineVersion. This is a compatibility/readability addition, not a runtime behavior change.

Selecting a run node may show existing state data:

- Status,
- Started,
- Finished/Elapsed,
- Attempt,
- selected Branch,
- Reason/Error,
- output/input context where already available,
- Logs.

After `Rerun from failed`, reused successful upstream nodes should be clearly labeled `Reused`, and restarted nodes should expose their attempt number.

## 28. Model Registry and Model Version

Registry lifecycle is the central concept. Preserve all supported states:

`CANDIDATE`, `VALIDATING`, `PENDING_APPROVAL`, `APPROVED`, `PRODUCTION`, `REJECTED`, `ARCHIVED`.

Primary metric presentation remains problem-type aware and prefers aggregate regression metrics where appropriate.

Model Version should use a lifecycle stepper/diagram that supports both the production path and rejection/archive states. Do not imply a rejected version has passed through Production.

Approval comments/evidence remain visible according to existing backend data.

## 29. Deployments and Prediction Test

Deployment cards prioritize status, model/version, request count, success rate, and latency already exposed by the Endpoint API.

Operational stop/start actions are lower hierarchy than Test prediction/API usage.

Prediction Test uses readable formatted request/response JSON. Multi-output predictions always display actual target names.

## 30. Monitoring and Alerts

Monitoring groups existing metrics into Service, Data, and Model Health. Charts must support operational interpretation, not decoration.

Alerts remain an actionable inbox. Surface existing message/link/read/resolved data cleanly; do not fabricate richer structured alert metadata.

## 31. Schedule UX

Prefer contextual drawer composition where practical.

Keep current target-dependent schedule behavior and fields. Cron presets/timezone/concurrency/retry settings remain supported.

Raw Cron and pipeline parameter JSON are advanced controls.

A Pipeline-to-Schedule shortcut may preselect a pipeline, but must use the same underlying Schedule API and validation rules.

## 32. Responsive rules

### >= 1280px

- full sidebar,
- normal shell,
- full three-zone Builder.

### 1024–1279px

- compact navigation acceptable,
- Inspector may become collapsible/drawer-like,
- preserve Project Picker.

### < 1024px

- normal read/management pages remain usable,
- tables may scroll,
- navigation may become drawer/rail,
- complex Pipeline editing is not a mobile objective.

If a usable builder cannot be maintained, show an explicit larger-screen recommendation.

## 33. Accessibility

Target at least:

- WCAG AA-readable contrast for normal text,
- visible keyboard focus,
- status not conveyed through color alone,
- form errors include text,
- icon-only buttons have accessible labels,
- reasonable 36–40px interactive hit areas,
- keyboard-accessible alternatives where drag-and-drop is used,
- semantic headings and labels.

Do not regress existing accessibility behavior.

## 34. Animation

Use animation only to communicate state or spatial change.

Acceptable:

- subtle running indicator,
- drawer/modal transition,
- compact loading spinner,
- node selection/focus transition.

Avoid decorative continuous motion.

## 35. Implementation strategy

Implement in reviewable slices.

### 1.5-A — Shell & shared components

- AppShell / Sidebar IA,
- Breadcrumb behavior,
- shared tokens/component styles,
- Page Header/status/action consistency.

### 1.5-B — Pipeline

- split Node Library and Inspector,
- three-zone layout,
- condition branch UX preserving `true`/`false`/`always`,
- Validation Panel,
- dirty-state navigation protection,
- exact historical PipelineVersion read support if needed,
- graph-based Pipeline Run display.

### 1.5-C — ML lifecycle

- Dataset/Job/Run/Registry/Model/Deployment detail consistency,
- lineage,
- multi-output metric/target presentation,
- prediction layout.

### 1.5-D — Operations

- Workspace Home,
- Project Overview,
- Schedules,
- Monitoring,
- Alerts,
- responsive refinement.

Do not implement all Phase 1.5 changes as one frontend rewrite.

## 36. Cursor change discipline

For every implementation slice:

1. Read the current implementation, API types, relevant backend routes, and tests before changing it.
2. Read `docs/phase-1.5-ux-architecture.md` and this document.
3. Identify shared components/styles before adding a new one-off pattern.
4. Preserve backend/API/auth/RBAC/project-scoping/runtime behavior.
5. Preserve deep links and routes unless a route change is explicitly approved.
6. Do not invent backend fields or fake persisted behavior.
7. Avoid N+1 requests added only for cosmetic presentation.
8. Add/update unit tests for changed component behavior.
9. Add/update Playwright coverage for important user flows.
10. Run targeted tests before the full verification gate.
11. Keep changes on a feature branch and create a Draft PR.
12. Do not mark Ready, merge, tag, or release unless explicitly requested.

## 37. Visual review procedure

Because Phase 1.5 is implemented directly in the running frontend rather than handed off from Figma, browser review is part of the design process.

For each major slice:

1. Run the updated application.
2. Review the real screen with realistic data.
3. Verify long names, long JSON, multi-output targets, empty states, error states, and role-gated actions.
4. Verify narrow-width behavior where applicable.
5. Capture screenshots for external review when useful.
6. Fix layout issues before merge.

## 38. Minimum state coverage

When modifying a reusable view, verify applicable states:

- loading,
- normal populated,
- empty,
- error,
- disabled/read-only,
- long content,
- narrow width.

For Pipeline also verify:

- empty graph,
- configured graph,
- dirty,
- validation failure,
- published,
- running,
- failed,
- rerun/reused,
- existing `always` edges.

For Model lifecycle also verify relevant Candidate/Validating/Pending Approval/Approved/Production/Rejected/Archived states.

## 39. Do not do

Do not:

- replace the current React app wholesale,
- add Figma-generated runtime dependencies,
- redesign APIs for cosmetic convenience,
- loosen authorization,
- create future-phase controls that do not work,
- add a Copilot/chat panel in Phase 1.5,
- change multi-output semantics,
- remove existing `always` edge semantics,
- show the latest Pipeline graph for an older historical run,
- expose internal MinIO or infrastructure URLs to browsers,
- reintroduce raw target-index labels,
- allow JSON/logs to overflow containers,
- put destructive actions at the same emphasis level as normal primary actions,
- silently create new health formulas or unsupported operational states.

## 40. Frontend Design Definition of Done

Phase 1.5 frontend design implementation is complete when:

- grouped application IA is implemented consistently,
- shell/navigation/page hierarchy is coherent,
- shared visual tokens and components replace duplicated one-offs where practical,
- common entity-detail layouts are recognizable,
- Pipeline Builder uses Node Library / Canvas / Inspector,
- condition branches are graph-readable and `always` compatibility is preserved,
- pipeline dirty/validation states are clear,
- Pipeline Run uses the exact historical graph version and exposes failed/reused attempts clearly,
- Model Registry/Version represent the full supported lifecycle,
- Prediction Test safely renders multi-output results,
- Monitoring is operationally organized without invented metrics,
- Alerts are actionable using existing alert data,
- Schedule configuration uses progressive disclosure while preserving target-specific behavior,
- desktop and compact layouts remain usable,
- loading/empty/error/long-content states are covered,
- accessibility basics are preserved,
- existing functional behavior and regression tests do not regress.

## 41. Primary current code references

Before implementing the corresponding area, inspect:

```text
frontend/src/App.tsx
frontend/src/AppShell.tsx
frontend/src/ProjectContext.tsx
frontend/src/components.tsx
frontend/src/styles.css
frontend/src/pages/Dashboard.tsx
frontend/src/pages/ProjectOverview.tsx
frontend/src/pages/DataSources.tsx
frontend/src/pages/Datasets.tsx
frontend/src/pages/DatasetDetail.tsx
frontend/src/pages/Jobs.tsx
frontend/src/pages/JobCreate.tsx
frontend/src/pages/JobDetail.tsx
frontend/src/pages/Runs.tsx
frontend/src/pages/RunDetail.tsx
frontend/src/pages/RunCompare.tsx
frontend/src/pages/Pipelines.tsx
frontend/src/pipelineForms.tsx
frontend/src/pipelineHelpers.ts
frontend/src/pages/Registry.tsx
frontend/src/pages/ModelVersion.tsx
frontend/src/pages/Endpoints.tsx
frontend/src/pages/Predict.tsx
frontend/src/pages/DeploymentApiUsage.tsx
frontend/src/pages/BatchInference.tsx
frontend/src/pages/Schedules.tsx
frontend/src/pages/Monitoring.tsx
frontend/src/pages/Alerts.tsx
frontend/src/pages/AuditLogs.tsx
frontend/src/pages/Administration.tsx
frontend/src/api.ts
```

For Pipeline Run exact-version work, also inspect the current pipeline API/service response shape and immutable `PipelineVersion` persistence before choosing the smallest compatible read endpoint.

Inspect the corresponding unit and Playwright tests before changing user-visible behavior.
