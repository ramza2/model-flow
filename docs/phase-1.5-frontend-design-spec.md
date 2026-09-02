# ModelFlow Phase 1.5 Frontend Design Specification

Status: **Approved implementation baseline**  
Audience: Frontend engineers, Cursor Agents Window, QA  
Companion document: `docs/phase-1.5-ux-architecture.md`

## 1. Purpose

This document turns the Phase 1.5 UX architecture into concrete frontend implementation rules.

The existing production React application remains the functional baseline. This specification defines the target shell, visual system, reusable components, page composition, Pipeline Builder layout, execution-state presentation, responsive behavior, and implementation quality bar.

This is **not** permission to replace `frontend/src` with a generated frontend. Implement Phase 1.5 incrementally inside the existing application while preserving supported behavior.

## 2. Existing visual baseline

The current ModelFlow frontend already uses a dark engineering-oriented theme with these approximate values:

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

Existing typography is based on:

- `DM Sans` for interface text,
- `IBM Plex Mono` for code/JSON/log/technical metadata.

Phase 1.5 should **systematize and reuse** this identity rather than introduce a different product aesthetic.

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
- emoji as primary navigation icons,
- excessive shadows,
- excessive whitespace,
- one-off page-specific visual languages.

## 4. Layout tokens

Use a 4px base spacing grid.

Recommended spacing tokens:

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

Borders:

```text
default   1px solid var(--border)
focus     2px solid var(--accent)
```

Use shadows sparingly, mainly for menus, drawers, and modals.

## 5. Typography

Recommended hierarchy:

| Token | Size / line-height | Weight | Use |
| --- | --- | --- | --- |
| Display | 32 / 40 | 700 | Rare landing/hero use |
| H1 | 28 / 36 | 700 | Page title |
| H2 | 20 / 28 | 700 | Major section |
| H3 | 16 / 24 | 600 | Card/subsection title |
| Body | 14 / 20 | 400 | Standard text |
| Body Strong | 14 / 20 | 600 | Emphasis |
| Small | 12 / 16 | 400 | Metadata |
| Label | 12 / 16 | 600 | Form labels |
| Eyebrow | 11 / 16 | 700 | Group/category heading |
| Mono | 12 / 18 | 400 | IDs, JSON, SHA, logs |

Eyebrows may use uppercase and moderate letter spacing.

Do not create page-specific typography scales.

## 6. Standard desktop shell

### 6.1 Reference viewport

Normal pages should be comfortable at approximately `1440 × 1024`.

Pipeline editing should also be evaluated at approximately `1600 × 1000` because the Canvas requires width.

### 6.2 Top bar

Target:

```text
Height: 64px
Position: sticky
```

Contents:

```text
ModelFlow | Project picker                              Alerts | User menu
```

The project picker remains a persistent global control.

### 6.3 Sidebar

Target desktop width: approximately `256px`.

Use the IA from `phase-1.5-ux-architecture.md`:

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

### 6.4 Navigation item

Recommended:

```text
Height: 40px
Radius: 8px
Horizontal padding: 12px
Icon: 16–18px
Icon/text gap: 10px
Text: 14px medium
```

Active item:

- soft background,
- primary text,
- accent icon,
- 3px accent left indicator or equivalent,
- accessible current-page state.

## 7. Content area

Normal pages:

```text
Horizontal padding: ~32px
Top padding: 20–24px
Bottom padding: ~64px
```

Avoid constraining complex engineering tables or builder canvases to an artificially narrow marketing-style content column.

For builder pages, allow the workspace to consume almost all available width.

## 8. Breadcrumbs

Recommended font: `12px / 16px`.

Prefer names over IDs.

Example:

`Projects / Phase1 Smoke Test / Training Jobs / Multi Output Smoke Training`

IDs may appear as muted metadata beneath the entity title where needed.

## 9. Page Header component

Shared structure:

```text
Page title                           Actions
Short description
```

Recommended minimum height: ~68px.

Normal pages should have one visually dominant primary action.

Examples:

- Pipelines → `New pipeline`
- Training Jobs → `New training job`
- Model Registry → `Register model`
- Deployments → `New deployment`

Do not make every action a primary filled button.

## 10. Buttons

### Primary

```text
Height: ~40px
Padding: 0 16px
Radius: 8px
Background: accent
Text: dark readable foreground
Font: 14px / 600
```

### Secondary

- transparent or surface background,
- default border,
- primary text.

### Tertiary / link

Use for low-emphasis navigation or inline actions.

### Danger

Use danger-tinted background/border/text. Destructive operational actions should not compete visually with the normal primary task.

### States

Every button family should support:

- default,
- hover,
- focus-visible,
- disabled,
- loading where relevant.

## 11. Forms

Recommended control height: ~40px.

Label above control with ~8px gap.

Error treatment:

- danger border on affected field,
- concise text error directly below,
- do not rely only on a top-level error banner.

Use progressive disclosure for advanced technical configuration.

Raw JSON is not the default UI for normal configuration.

## 12. Multi-select

Targets and similar multi-value fields need a reusable multi-select.

Example:

```text
Targets
[cooling_load ×] [power_usage ×]
```

Dropdown may use checkbox-style options and search when lists are long.

Always show real target names.

## 13. Cards

Base card:

```text
Background: surface
Border: 1px
Radius: 10px
Padding: 16–20px
```

Keep engineering cards compact.

Clickable cards may use a subtle hover border/surface treatment.

Do not mix “entire card is clickable” and “only internal button is clickable” unpredictably within one list.

## 14. Tables

Tables are a first-class ModelFlow pattern.

Recommended:

```text
Header height: ~40px
Row min height: ~48px
Cell vertical padding: ~12px
```

Typical structure:

```text
Filters / Search                              Result count

Table
```

Name column:

```text
Primary entity name
Muted secondary metadata / technical ID
```

Allow horizontal internal scrolling on constrained widths rather than illegibly compressing important columns.

## 15. Status Badge

Recommended:

```text
Height: ~24px
Padding: 4px 8px
Radius: pill
Font: 12px / 600
```

Every status uses:

`icon + text + semantic visual treatment`

Shared semantic families:

- neutral,
- progress/running,
- success,
- warning,
- failure.

Do not communicate status using color only.

## 16. Notices

Provide reusable:

- Info,
- Success,
- Warning,
- Error.

Prefer actionable copy.

Bad:

`400 validation error`

Better:

```text
Pipeline validation failed.
3 steps need configuration.

View issues →
```

## 17. Modal

Recommended default width: ~560px.

Structure:

```text
Title
Description

Content

Cancel                              Primary action
```

Use for focused confirmation/create flows where a drawer is not more appropriate.

## 18. Drawer

Use a right drawer for long contextual configuration that should preserve background context.

Recommended widths:

```text
Default: 400px
Large:   520px
```

Good uses:

- Schedule Create,
- long resource configuration,
- some compact-width Inspector fallbacks.

The desktop Pipeline Inspector is a persistent panel, not an overlay drawer.

## 19. Technical blocks

For JSON, API examples, Git SHAs, model URIs, and logs:

```text
Font: IBM Plex Mono
Background: #0A0E12
Border: default
Radius: 8px
```

Always prevent overflow:

- `max-width: 100%`,
- internal scrolling and/or safe wrapping,
- `overflow-wrap` where appropriate.

No technical string may escape its panel.

## 20. Empty State

An empty state must answer:

- Why is this empty?
- What should the user do next?

Example:

```text
No pipelines yet

Create a visual workflow to standardize your model lifecycle.

Create pipeline
```

## 21. Loading

Loading should be localized to the affected content region where possible.

Use spinner or skeleton patterns consistently. Do not block the entire application shell for a local resource refresh.

## 22. Common entity-detail visual pattern

Use the same hierarchy for Dataset, Job, Run, Model Version, Deployment, and related detail pages:

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

## 23. Screen targets

The following 20 reference screens/states define the Phase 1.5 implementation target. They are not separate Figma deliverables; they are frontend states to implement and review in the running product.

### 01 — Workspace Home

Purpose: workspace/current-project status and next actions.

Recommended content:

- current selected project,
- compact counts for Projects, Datasets, Training Jobs, Failed Jobs, Deployments, Unread Alerts,
- recent training jobs,
- next actions.

Do not turn this into a marketing landing page.

### 02 — Project Overview

Purpose: lifecycle control center.

Top health summary:

- Data,
- Training,
- Production,
- Alerts.

Lifecycle summaries:

- Data,
- Build,
- Models,
- Serving.

Also show recent activity and members for authorized users.

### 03 — Dataset Detail

Header actions:

- `Train on dataset` primary,
- `Use in pipeline` secondary.

Organize information around:

- Overview,
- Versions,
- Schema & Profile,
- Quality,
- Lineage.

### 04 — Training Job Detail

Header:

- status,
- Retrain,
- Clone configuration,
- Open experiment,
- Register model.

Summary:

- Dataset,
- Problem type,
- Algorithm,
- Targets,
- Features,
- Split.

Metrics:

- aggregate first,
- per-target by real target name.

### 05 — Experiments

Primary mental model: compare training executions.

Use:

- search/filter controls,
- selection checkboxes,
- clickable run name,
- status,
- algorithm,
- targets,
- primary metric,
- started time,
- `Compare selected` action.

### 06 — Experiment Run Detail

Technical detail page.

Show:

- Run ID,
- start/finish/duration,
- artifact URI,
- logged metrics,
- run parameters,
- tags,
- lineage.

Raw MLflow-style technical keys are acceptable here.

### 07 — Pipeline List

Use a compact table with:

- Pipeline,
- Status,
- Version,
- Type,
- Last run,
- Updated.

Primary action: `New pipeline`.

### 08 — Pipeline Builder / Empty

Use the three-zone Builder described below.

Empty Canvas message:

```text
Build your first workflow

Drag a step from the Node Library
or click a step to add it.

Start with training workflow
```

### 09 — Pipeline Builder / Configured

This is the Phase 1.5 hero implementation state.

Use the Golden Path graph from the companion UX architecture document.

Select Training and show its configuration in the Inspector.

### 10 — Pipeline Builder / Validation Errors

Show:

- invalid nodes highlighted,
- Validation Panel,
- selected issue,
- corresponding Inspector field in error state.

### 11 — Pipeline Run / Running

Reuse the graph in read-only execution mode.

Show current/finished/waiting node states and execution Inspector.

### 12 — Pipeline Run / Failed

Show:

- failed node,
- reused upstream nodes when applicable,
- error/log details,
- `Rerun from failed` action.

### 13 — Model Registry

Use lifecycle filter/segmentation and a table with:

- Model,
- Version,
- Lifecycle,
- Gates,
- Primary metric,
- Registered.

### 14 — Model Version Detail

Prominently show lifecycle progression:

`Candidate → Pending Approval → Approved → Production`

Sections:

- Quality,
- Governance,
- Approval evidence,
- Lineage,
- Deployment.

### 15 — Deployments

Use compact deployment cards.

Primary card information:

- name,
- status,
- model/version,
- request count,
- success rate,
- p95 latency.

Actions:

- Test prediction primary,
- API usage secondary,
- Stop in lower-priority operational menu/action.

### 16 — Prediction Test

Use a two-column Request / Response layout on desktop.

Left:

- expected input schema,
- JSON instances,
- Run prediction.

Right:

- readable prediction preview,
- full response.

Long output must remain contained.

### 17 — Monitoring

Organize around:

- Service Health,
- Data Health,
- Model Health.

Use a top-level overall health/attention summary.

Charts should support operational decisions, not decoration.

### 18 — Alerts

Use actionable alert items/cards.

Every alert should show:

- severity,
- title,
- resource,
- explanatory message,
- time,
- Open resource,
- Resolve where allowed.

### 19 — Schedule Create

Prefer a large right drawer while keeping the schedule-management page in context.

Basic fields first:

- Name,
- Target type,
- Target resource,
- Frequency,
- Timezone,
- Concurrency,
- Retry policy.

Advanced collapsed:

- Cron expression,
- Parameters JSON.

### 20 — Responsive Shell

Validate at least:

- 1280×900,
- 1024×768,
- ~768px narrow management/read view.

Complex mobile pipeline editing is out of scope.

## 24. Pipeline Builder layout

The current Builder must converge from a mixed sidebar model toward a three-zone architecture.

### 24.1 Desktop structure

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Pipeline header / status / actions                                      │
├──────────────┬─────────────────────────────────────┬─────────────────────┤
│ NODE LIBRARY │               CANVAS                │ INSPECTOR           │
│ ~220px       │             flexible                │ ~340px              │
│              │                                     │                     │
├──────────────┴─────────────────────────────────────┴─────────────────────┤
│ Validation / execution console when needed                              │
└──────────────────────────────────────────────────────────────────────────┘
```

Panel gap: approximately 16px.

The Canvas owns the remaining width and must remain visually dominant.

## 25. Node Library

Provide a search field and grouped compact nodes.

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

## 26. Pipeline Node

Recommended width: `190–220px`.

Recommended minimum height: ~96px.

Show only concise information:

```text
TRAINING
Train demand model

Ridge
2 targets
3 features
```

Optional final row/icon communicates warning or execution state.

Detailed configuration belongs in the Inspector.

## 27. Node states

Visual states must support:

- default,
- selected,
- warning,
- error,
- running,
- succeeded,
- waiting,
- skipped,
- reused.

Selected:

- accent border,
- subtle accent focus ring.

Warning:

- warning border/icon.

Error:

- danger border/icon.

Running:

- restrained active indicator/pulse.

Do not over-animate the Canvas.

## 28. Pipeline Inspector

### No node selected

Show pipeline context:

- name,
- description,
- version,
- status.

### Training selected

Recommended visual grouping:

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

## 29. Condition UX

Condition branching should be visually explicit on the graph.

Preferred:

```text
          Condition
          /       \
       TRUE       FALSE
```

Implement with distinct handles or clearly labeled branch edges.

Avoid a disconnected global branch selector as the primary mental model.

## 30. Save / Validate / Publish / Run

Do not present these as interchangeable actions.

### Dirty

```text
Draft v5    Unsaved changes

Primary: Save version
Publish: disabled
Run: disabled
```

### Saved / unpublished

```text
Draft v5

Validate
Primary: Publish
```

### Published

```text
Published v4

Validate
Schedule
Primary: Run pipeline
```

Preserve current backend/frontend semantics and endpoint behavior. The visual hierarchy changes; the product contract does not.

## 31. Unsaved navigation guard

When leaving with dirty Pipeline changes, show a clear confirmation:

```text
Unsaved pipeline changes

Your latest changes have not been saved as a pipeline version.

Discard changes        Keep editing
```

Do not imply graph auto-save.

## 32. Validation Panel

Validation should be represented as structured issues.

Example:

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

- focus/center the node,
- select it,
- open Inspector context,
- identify the affected field.

## 33. Golden Path layout

Use this representative graph for visual review and tests where appropriate:

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

Avoid excessive edge crossing. Prefer a readable left-to-right or top-to-bottom layout based on available space.

## 34. Pipeline Run visual model

Use the Builder graph language in read-only execution mode.

Each node can carry execution state.

Selecting a node exposes execution Inspector information:

- Status,
- Started,
- Finished/Elapsed,
- Attempt,
- Branch,
- Reason/Error,
- Input context where available,
- Logs.

### Rerun from failed

After retry, reused upstream nodes should remain visibly successful with a `Reused` label while the failed node indicates the new attempt.

## 35. Model Registry presentation

Lifecycle is the main UX concept.

Use filter/segments for:

- All,
- Candidate,
- Pending Approval,
- Approved,
- Production,
- Archived.

Primary metric presentation should remain problem-type aware and prefer aggregate regression metrics where appropriate.

## 36. Model Version presentation

Use a visible lifecycle stepper/progression rather than relying only on a badge.

Example:

```text
Candidate ✓ → Pending Approval ✓ → Approved ✓ → Production ●
```

Approval comments/evidence should remain visible according to existing backend data.

## 37. Deployment cards

Recommended structure:

```text
multi-output-smoke-service                       Ready

Model
multi_output_smoke_training · v1

Requests     Success      p95 latency
38           100%         24.8 ms

Test prediction   API usage   …
```

Operational stop/start actions should use lower hierarchy than primary verification/use actions.

## 38. Prediction Test

Desktop layout:

```text
REQUEST                         RESPONSE
```

Use readable formatted JSON and a short named-output preview.

For multi-output predictions show:

```json
{
  "cooling_load": 8.2226,
  "power_usage": 11.9283
}
```

Never replace actual target names with indexes.

## 39. Monitoring

Top of page should answer either:

`All systems healthy`

or

`N items need attention`

Then group existing metrics into:

- Service Health,
- Data Health,
- Model Health.

Use the existing monitoring capabilities; do not invent unsupported SLO/drift workflows.

## 40. Alerts

Alert cards/items should make resource navigation obvious.

Recommended hierarchy:

```text
SEVERITY
Alert title
Resource
Explanation
Timestamp
Actions
```

Unread state may use an additional indicator, but do not rely on a single border color alone.

## 41. Schedule Create

Prefer contextual right-drawer composition where practical.

Basic first:

- Name,
- target type/resource,
- schedule/frequency,
- timezone,
- concurrency,
- retries.

Advanced collapsed:

- raw cron,
- parameters JSON.

Preserve current target-dependent schedule form behavior.

## 42. Responsive rules

### >= 1280px

- full sidebar,
- normal shell,
- full three-zone Builder.

### 1024–1279px

- compact navigation is acceptable,
- Inspector may become collapsible or drawer-like,
- preserve Project Picker.

### < 1024px

- normal read/management pages remain usable,
- tables may scroll,
- navigation may become drawer/rail,
- complex Pipeline editing is not a mobile design objective.

If a usable builder cannot be maintained, show an explicit larger-screen recommendation instead of producing a broken compressed editor.

## 43. Accessibility

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

## 44. Animation

Use animation only to communicate state or spatial change.

Acceptable:

- subtle running pulse,
- drawer/modal transition,
- compact loading spinner,
- node selection/focus transition.

Avoid decorative continuous motion.

## 45. Frontend implementation strategy

Implement in reviewable slices.

### 1.5-A — Shell & shared components

Suggested focus:

- AppShell/Sidebar IA,
- Breadcrumb naming improvements where data is available,
- shared tokens/component styles,
- Page Header/status/action consistency.

### 1.5-B — Pipeline

Suggested focus:

- split Node Library and Inspector,
- three-zone layout,
- condition branch handling UX,
- Validation Panel,
- dirty-state navigation protection,
- graph-based Pipeline Run display.

### 1.5-C — ML lifecycle

Suggested focus:

- Dataset/Job/Run/Registry/Model/Deployment detail consistency,
- lineage,
- multi-output metric/target presentation,
- prediction layout.

### 1.5-D — Operations

Suggested focus:

- Project Overview,
- Workspace Home,
- Schedules,
- Monitoring,
- Alerts,
- responsive refinement.

## 46. Cursor change discipline

For every implementation slice:

1. Read the current implementation and tests before changing it.
2. Identify shared components/styles before adding a new one-off pattern.
3. Preserve backend/API/auth/RBAC/project-scoping behavior.
4. Preserve deep links and routes unless the task explicitly approves a route change.
5. Do not invent backend fields or fake persisted behavior.
6. Add/update unit tests for changed component behavior.
7. Add/update Playwright coverage for important user flows.
8. Run relevant targeted tests before the full verification gate.
9. Keep changes on a feature branch and create a Draft PR.
10. Do not mark Ready, merge, tag, or release unless explicitly requested.

## 47. Visual review procedure

Because Phase 1.5 is implemented directly in the production frontend rather than handed off from Figma, browser review is part of the design process.

For each major slice:

1. Run the updated application.
2. Review the real screen with realistic data.
3. Capture representative screenshots if external review is needed.
4. Verify long names, long JSON, multi-output targets, empty states, error states, and role-gated actions.
5. Fix layout issues before merging.

Prefer real browser validation over assuming a component is correct from code inspection alone.

## 48. Minimum state coverage

When modifying a reusable view, verify applicable states:

- loading,
- normal populated,
- empty,
- error,
- disabled/read-only,
- long content,
- narrow width.

For Pipeline specifically also verify:

- empty graph,
- configured graph,
- dirty,
- validation failure,
- published,
- running,
- failed,
- rerun/reused.

## 49. Do not do

Do not:

- replace the current React app wholesale,
- add Figma-generated runtime code dependencies,
- redesign APIs for cosmetic convenience,
- loosen authorization,
- create future-phase controls that do not work,
- add a Copilot/chat panel in Phase 1.5,
- change multi-output semantics,
- expose internal MinIO or other infrastructure URLs to browsers,
- reintroduce raw target-index labels,
- allow JSON/logs to overflow containers,
- put destructive actions at the same emphasis level as normal primary actions.

## 50. Frontend Design Definition of Done

Phase 1.5 frontend design implementation is complete when:

- the grouped application IA is implemented consistently,
- shell/navigation/page hierarchy is coherent,
- shared visual tokens and components are used instead of duplicated one-offs,
- common entity-detail layouts are recognizable,
- Pipeline Builder uses Node Library / Canvas / Inspector,
- condition branches are graph-readable,
- pipeline dirty/validation states are clear,
- Pipeline Run reuses graph language and exposes failed/reused attempts clearly,
- Model Registry and Model Version make lifecycle state obvious,
- Prediction Test safely renders multi-output results,
- Monitoring is operationally organized,
- Alerts are actionable,
- Schedule configuration uses progressive disclosure,
- desktop and compact layouts remain usable,
- loading/empty/error/long-content states are covered,
- accessibility basics are preserved,
- existing functional behavior and tests do not regress.

## 51. Primary current code references

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
```

Inspect the corresponding unit and Playwright tests before changing user-visible behavior.
