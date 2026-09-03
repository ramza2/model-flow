# ModelFlow Phase 1.5 UX Architecture

Status: **Proposed implementation baseline**  
Audience: Product, frontend, QA, Cursor Agents Window  
Scope: **Phase 1.5 — UX Architecture & Frontend UX Refactoring**

## 1. Purpose

Phase 1.5 establishes the UX architecture that the existing ModelFlow frontend must converge toward before later roadmap phases add broader data preparation, connector, closed-loop, time-series, copilot, or enterprise capabilities.

This phase is **not** a greenfield rewrite and is **not** dependent on a Figma handoff. The existing React frontend is modified directly and incrementally. Figma may still be used later for focused visual exploration, but it is not a required implementation step for Phase 1.5.

### Source-of-truth model

Do not interpret the source-of-truth rules as one global precedence list. Behavior and presentation have different authorities.

**Functional source of truth**

1. Backend API contracts, persistence, auth, RBAC, project scoping, training/runtime behavior, registry lifecycle, deployments, scheduling, and pipeline execution semantics.
2. Existing supported frontend behavior and regression tests where they reflect current product functionality.

**UX / presentation source of truth**

1. This document for information architecture, navigation, page roles, lifecycle mental models, and cross-screen UX behavior.
2. `docs/phase-1.5-frontend-design-spec.md` for layout, component, visual, responsive, accessibility, and implementation rules.

Therefore:

- existing supported functionality wins for **behavior**;
- the Phase 1.5 documents win for **IA, layout, navigation, component hierarchy, and presentation**;
- cosmetic convenience must never silently change API/RBAC/runtime semantics;
- a small read-only backend addition is allowed only when the target UX cannot correctly represent existing persisted behavior without it, and such an addition must be explicitly reviewed.

## 2. Current product baseline

The current frontend exposes project-scoped routes for Data Sources, Datasets, Experiments, Training Jobs, Pipelines, Schedules, Model Registry, Deployments, Monitoring, Alerts, and Audit Logs, plus workspace-level Projects and Administration.

The current application shell already provides a persistent top bar, project selection, workspace/project/governance navigation, breadcrumbs, alert count, user menu, and project-role-aware actions.

The current Pipeline Builder already supports a visual React Flow graph, node configuration, validation, save/publish/run behavior, condition branches, run history, and rerun-from-failed execution semantics. Phase 1.5 reorganizes and clarifies this UX rather than replacing the underlying behavior.

## 3. UX goals

Phase 1.5 must make ModelFlow understandable through three lifecycle models.

### 3.1 Data lifecycle

`Data Source → Dataset → Version → Quality`

The user should understand where data came from, which version is being used, whether quality checks passed, and which downstream resources depend on the data.

### 3.2 ML lifecycle

`Dataset → Training → Experiment → Model → Validation → Approval → Production → Deployment`

The user should be able to move from training input to experiment result, registered model, validation/governance decision, and live serving without losing lineage.

### 3.3 Automation lifecycle

`Pipeline → Pipeline Run → Schedule → Monitoring → Alert`

Repeatable work should be understood as an executable workflow that can be run manually, scheduled, observed, diagnosed, and recovered.

## 4. Design principles

### 4.1 Lifecycle-first

Pages should communicate where an object sits in its lifecycle and what the likely next action is.

### 4.2 Project-scoped

Project selection is the primary operating context. Most product resources belong to exactly one selected project.

### 4.3 Pipeline-centric, not pipeline-only

Manual training remains supported. Pipelines become the preferred UX for repeatable data, training, governance, deployment, and operational workflows.

### 4.4 Progressive disclosure

Normal users configure resources through structured forms. Raw JSON, technical IDs, and low-level metadata are secondary or advanced information.

### 4.5 Traceable by default

Important entities should link to upstream and downstream lineage wherever existing relationships are available.

### 4.6 Operational clarity

The product must represent not only success paths, but also pending, queued, dispatched, running, validating, failed, cancelled, degraded, rejected, skipped, reused, retried, archived, and unresolved states where applicable.

### 4.7 Preserve behavior

Phase 1.5 is a UX refactor. Do not silently change API contracts, route semantics, RBAC, lifecycle transitions, training behavior, model output semantics, scheduler behavior, or pipeline runtime semantics.

### 4.8 English UI baseline

Phase 1.5 keeps the current English product terminology as the implementation baseline. Terminology should become more consistent and task-oriented, but broad localization is not part of this phase.

## 5. Target information architecture

Use the following navigation hierarchy.

```text
WORKSPACE
├─ Home
└─ Projects

PROJECT
├─ Overview
│
├─ DATA
│  ├─ Data Sources
│  └─ Datasets
│
├─ BUILD
│  ├─ Pipelines
│  ├─ Training Jobs
│  └─ Experiments
│
├─ MODELS & SERVING
│  ├─ Model Registry
│  └─ Deployments
│
├─ OPERATIONS
│  ├─ Schedules
│  ├─ Monitoring
│  └─ Alerts
│
└─ GOVERNANCE
   └─ Audit Logs

SYSTEM
└─ Administration
```

Do not flatten all project features into one long undifferentiated list.

## 6. Application-shell behavior

### 6.1 Top bar

The top bar remains persistent and contains:

- ModelFlow brand,
- project picker,
- unread alert indicator,
- user menu.

### 6.2 Project switching

Project switching must not attempt to map an entity ID from one project to another. The safe target is the newly selected project overview.

`Current project resource → switch project → new project Overview`

### 6.3 Sidebar

The sidebar uses the grouped IA in section 5. The active group remains visually open and the current page has a clear active indicator that does not rely on color alone.

### 6.4 Breadcrumbs

Breadcrumbs should prefer human-readable names over numeric IDs when the application already has the necessary entity data.

Preferred:

`Phase1 Smoke Test / Training Jobs / Multi Output Smoke Training`

Fallback when a human-readable name is not already available without wasteful extra requests:

`Phase1 Smoke Test / Training Jobs / #3`

Do not create N+1 lookups only to cosmetically replace IDs.

## 7. Page taxonomy and screen roles

| Screen | Primary UX role | Typical primary action |
| --- | --- | --- |
| Workspace Home | Current workspace/project activity | Create project / continue work |
| Projects | Project catalog and selection | Create project |
| Project Overview | Project lifecycle control center | Continue next lifecycle action |
| Data Sources | External data connectivity/import | Add or connect source |
| Datasets | Dataset catalog | Add dataset |
| Dataset Detail | Data understanding, version, quality, lineage | Train / Use in pipeline |
| Pipelines | Repeatable workflow catalog | New pipeline |
| Pipeline Builder | Workflow authoring | Save/Publish/Run according to state |
| Pipeline Run | Execution diagnosis and recovery | Inspect / Rerun failed |
| Training Jobs | Training execution catalog | New training job |
| Training Job Detail | Training result and lineage | Register / Retrain |
| Experiments | Compare training executions | Compare selected |
| Experiment Run Detail | Inspect exact run metadata | Inspect lineage/configuration |
| Model Registry | Govern registered versions | Register model |
| Model Version Detail | Governance/lifecycle decision | Validate/Approve/Promote when allowed |
| Deployments | Serving management | New deployment |
| Prediction Test | Online inference verification | Run prediction |
| Batch Inference | Offline scoring | Run batch / Download result |
| Schedules | Automation timing and execution policy | New schedule |
| Monitoring | Operational triage | Investigate signal |
| Alerts | Actionable exception inbox | Open resource / Resolve |
| Audit Logs | Compliance trace | Filter/investigate |
| Administration | Platform administration | Manage platform settings/users |

## 8. Common page anatomy

Normal pages should follow this hierarchy:

```text
Breadcrumb

Page title                          Primary action
Short description                  Secondary actions

Status / warning / success notices

Filters / scope controls

Primary content

Secondary content / history / technical details
```

Use one visually dominant primary action per normal page whenever possible.

## 9. Common entity-detail pattern

Dataset, Training Job, Experiment Run, Pipeline, Pipeline Run, Model Version, Deployment, and similar detail pages should converge on this pattern:

```text
Entity name                         Status
Context / description               Actions

Summary / key metrics

Configuration / metadata

Lineage

Activity / history

Technical details / logs
```

## 10. Project Overview role

Project Overview becomes the project lifecycle control center, not merely a statistics page.

It should help users answer quickly:

- Is data healthy?
- Is training active or failing?
- Is there a production model?
- Is serving healthy?
- Are there alerts requiring attention?
- What should I do next?

Recommended sections:

- compact project signal strip,
- Data summary,
- Build summary,
- Models summary,
- Serving summary,
- recent activity where the current APIs can provide it efficiently,
- members/access for authorized users.

### Health-signal rule

Do not invent hidden health formulas or imply guarantees not supported by current metrics.

Prefer directly observable labels such as:

- `No failed quality checks`,
- `1 active training job`,
- `1 production model`,
- `1 / 1 deployments ready`,
- `2 open alerts`.

A synthesized label such as `Healthy` is allowed only when its rule is explicitly defined in the frontend and derived from existing data.

## 11. RBAC UX

Conceptual roles remain:

- `VIEWER`
- `DATA_SCIENTIST`
- `ML_ENGINEER`
- `PROJECT_ADMIN`
- System Administrator

Do not hide readable lifecycle context unnecessarily. Prefer showing readable resources and withholding/disabling unauthorized mutation actions according to existing authorization behavior.

Primary responsibility model:

- Viewer: read-only lifecycle visibility.
- Data Scientist: datasets, training, experiments.
- ML Engineer: pipelines, registry, deployments, schedules.
- Project Admin: all project operations, members, governance.
- System Admin: platform administration and global audit.

Never weaken backend authorization to match the UI.

## 12. Status semantics

Use one shared semantic grammar while preserving all actual backend states.

### Neutral

`Draft`, `Stopped`, `Archived`, `Unknown`, `Inactive`

### In progress

`Pending`, `Queued`, `Dispatched`, `Running`, `Validating`, `Pending Approval`, `Cancel Requested`

### Success

`Succeeded`, `Passed`, `Approved`, `Production`, `Published`, `Ready`, `Active`

### Warning

`Warning`, `Partial`, `Degraded`, `Attention`, `Skipped`

### Failure / terminal negative

`Failed`, `Fail`, `Rejected`, `Blocked`, `Error`, `Cancelled`, `Critical`

Pipeline execution may additionally communicate `Waiting` and `Reused` where those states are meaningful.

Do not rename backend values in transport or persistence merely to match display labels.

## 13. Lineage model

Lineage should become a reusable cross-screen pattern.

Representative path:

```text
Multi Output Smoke Dataset · v1
        ↓
Multi Output Smoke Training
        ↓
Experiment Run
        ↓
multi_output_smoke_training · v1
        ↓
multi-output-smoke-service
```

Where the underlying relationships are available, each step should navigate to the corresponding resource.

## 14. Multi-output UX rules

Multi-output regression is a supported current capability and must be represented consistently.

- Always show actual target names such as `cooling_load` and `power_usage`.
- Never use `target 0`, `target 1`, `output 0`, or `output 1` as the primary user-facing label.
- Aggregate metrics remain the primary summary when an aggregate is available.
- Per-target metrics are secondary details grouped under the actual target name.
- Prediction results use named output objects.

## 15. Manual ML lifecycle flow

The manual path remains first-class:

```text
Dataset
→ Train Model
→ Training Job
→ Experiment Run
→ Register Model
→ Candidate
→ Validating when applicable
→ Pending Approval
→ Approved or Rejected
→ Production when approved and promoted
→ Create Deployment
→ Test Prediction
```

`Archived` is an inactive/terminal lifecycle state that can apply after active governance use.

Phase 1.5 should reduce context switching by cross-linking related detail pages.

## 16. Pipeline UX architecture

The Pipeline Builder is the highest-priority UX refactor in Phase 1.5.

### 16.1 Three-zone builder

Replace the mixed add/config sidebar mental model with:

```text
Node Library | Canvas | Inspector
```

- **Node Library**: add/search available step types.
- **Canvas**: graph composition and connections.
- **Inspector**: selected-node configuration or pipeline metadata.

The Canvas must visually dominate the screen.

### 16.2 Supported current node types

```text
DATA
- Dataset Load
- Quality Check
- Split
- Preprocessing

TRAIN
- Training
- Evaluation

LOGIC
- Condition

MODEL LIFECYCLE
- Model Registration
- Approval Request

SERVING
- Endpoint Deployment
- Batch Prediction

OPERATIONS
- Notification
```

Do not invent future-phase nodes during Phase 1.5.

### 16.3 Node interaction

A node shows only concise canvas information:

- type,
- custom step name,
- 2–3 important configuration summaries,
- warning/execution state.

Detailed forms live in the Inspector.

### 16.4 Inspector

No node selected:

- pipeline name,
- description,
- version,
- status.

Node selected:

- step name,
- input context,
- typed configuration form,
- advanced JSON collapsed by default,
- destructive Remove action separated from normal settings.

### 16.5 Condition branches

Condition branch semantics must be visible on the graph itself.

Primary visual paths are `TRUE` and `FALSE`. Existing `always` edge semantics must remain supported for backward compatibility and non-conditional/unconditional flow behavior.

Preferred graph representation:

```text
Condition
├─ TRUE
├─ FALSE
└─ ALWAYS (when used)
```

Do not remove or reinterpret existing `true` / `false` / `always` persisted edge semantics during a visual refactor.

### 16.6 Save / Validate / Publish / Run

These states and actions must be distinct:

`Edit → Save version → Validate → Publish → Run`

- **Save version**: persists an explicit pipeline version.
- **Validate**: validates graph and node configuration.
- **Publish**: marks the latest valid version as published.
- **Run**: starts execution using the current supported API semantics.

Preserve the existing behavior that dirty/unsaved changes block publish/run.

Do not claim that backend publication technically prevents all execution of unpublished versions unless the backend is separately changed to enforce that rule. Phase 1.5 changes visual hierarchy, not the runtime contract.

### 16.7 Unsaved changes

Unsaved state must be obvious and navigation away must guard against silent loss.

Pipeline graph versions are not implicitly auto-saved.

### 16.8 Validation recovery

Validation is a guided correction workflow, not just an error banner.

A validation issue should identify the affected step and, where technically practical, selecting the issue should:

1. center/highlight the node,
2. select it,
3. open the Inspector,
4. bring attention to the relevant field.

If the backend currently returns only error strings, node/field association may be best-effort in Phase 1.5. Do not fabricate structured backend validation metadata.

### 16.9 Golden Path pipeline

Use this as the representative end-to-end workflow:

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

An existing `ALWAYS` edge remains valid when a workflow uses it even though the Golden Path focuses on TRUE/FALSE branching.

## 17. Pipeline Run architecture

Pipeline Run should reuse the graph language of the Builder in read-only execution mode.

The main visualization should not degrade into an unrelated card list.

Selecting an execution node should expose, where available:

- status,
- start/finish or elapsed time,
- attempt,
- branch decision,
- reason/error,
- input/resource context,
- logs.

### Historical graph correctness requirement

A Pipeline Run must render the **exact pipeline version used by that run**, not the latest pipeline graph.

Current run data includes `pipeline_version_id`, while the current frontend normally obtains only the latest graph from the pipeline detail endpoint. Before implementing a historical graph-based Run view, verify whether the exact run graph can already be fetched without ambiguity.

If not, Phase 1.5-B may add a minimal read-only endpoint such as:

```text
GET /projects/{project_id}/pipelines/{pipeline_id}/versions/{version}
```

or an equivalent lookup by `pipeline_version_id`.

This exception is allowed because it exposes already persisted immutable data and is required to avoid displaying the wrong historical graph. It must not change execution semantics.

### Failure recovery

For failed runs:

`Failed node → inspect error/log → Rerun from failed`

When successful upstream steps are reused, show `Reused` clearly so the operator knows those steps were not rerun.

## 18. Scheduling UX

Schedules should feel attached to executable resources, not like a standalone raw Cron editor.

Preferred contextual flow:

`Pipeline → Schedule → Create Schedule`

The central Schedules page remains the management catalog for pipeline runs, batch inference, and data import schedules already supported by the product.

Basic fields should be primary; cron expression and parameters JSON are advanced controls.

Do not imply the pipeline must be published if the current scheduler/runtime contract permits a different valid target. Preserve existing target filtering and validation unless separately changed.

## 19. Monitoring UX

Monitoring is an operational triage page organized around:

- Service Health,
- Data Health,
- Model Health.

The user should first understand whether attention is required, then drill into supporting metrics and affected resources.

Do not add decorative charts without an operational decision purpose, and do not invent unsupported SLO or drift workflow behavior.

## 20. Alerts UX

Alerts are actionable exceptions, not passive logs.

Each alert should communicate:

- severity,
- what happened,
- why it matters when available from existing message content,
- which resource is affected when `link_path` or equivalent data exists,
- when it happened,
- what the user can do next.

Do not invent structured resource metadata that the current Alert API does not provide.

## 21. Responsive architecture

ModelFlow remains desktop-first.

### >= 1280px

Full application shell and three-zone Pipeline Builder.

### 1024–1279px

Compact/collapsible navigation. Pipeline Inspector may become collapsible or drawer-like when necessary.

### < 1024px

Management and read pages remain usable. Complex graph editing is not a mobile priority.

For constrained Pipeline Builder layouts, prefer a clear message that editing works best on a larger screen rather than producing an unusable compressed graph editor.

## 22. Phase 1.5 implementation slices

The frontend refactor should be incremental.

### Phase 1.5-A — Shell & shared design system

- grouped IA,
- top bar/sidebar/breadcrumb cleanup,
- shared page anatomy,
- shared components and token normalization,
- common status/action patterns.

### Phase 1.5-B — Pipeline UX

- Node Library / Canvas / Inspector,
- condition branch UX while preserving `true` / `false` / `always`,
- validation panel,
- unsaved flow,
- exact-version graph support for historical Pipeline Run views,
- read-only Pipeline Run graph,
- rerun-from-failed presentation.

### Phase 1.5-C — ML lifecycle UX

- Dataset Detail,
- Training Job Detail,
- Experiments,
- Experiment Run Detail,
- Model Registry,
- Model Version Detail,
- Deployments,
- Prediction Test.

### Phase 1.5-D — Operations & overview UX

- Workspace Home,
- Project Overview,
- Schedules,
- Monitoring,
- Alerts,
- responsive refinements.

Do not implement all Phase 1.5 changes as a single unreviewable frontend rewrite.

## 23. Out of scope

Do not introduce functionality reserved for later roadmap phases, including:

- a new visual Data Preparation engine,
- new connector product capabilities,
- closed-loop automatic retraining,
- incremental/continued training,
- time-series forecasting workspace,
- LLM Copilot/chat assistant,
- enterprise cluster-management UI.

The UX architecture should leave room for these features later without displaying unsupported controls now.

## 24. Phase 1.5 vs Phase 9 visual boundary

Phase 1.5 may normalize existing colors, typography, spacing, component dimensions, focus states, and reusable patterns so the refactored frontend is coherent and implementable.

Phase 1.5 is **not** the final brand/visual redesign. Phase 9 remains the stage for a broader Figma-driven final visual polish, including substantial aesthetic rework, final typography/color decisions, advanced chart styling, and product-wide visual refinement after the IA and major workflows stabilize.

## 25. Cursor implementation rules

Before changing UI code, inspect the relevant current routes/components/API calls and tests.

For every Phase 1.5 implementation task:

- preserve backend API/runtime contracts unless a separately reviewed compatibility read endpoint is explicitly required,
- preserve routing semantics and deep-linkability,
- preserve authentication and authorization,
- preserve project context and project scoping,
- preserve existing supported functionality,
- prefer shared reusable components over page-specific duplication,
- avoid N+1 API calls added only for cosmetic labels,
- keep current tests passing and add/update tests for changed UX behavior,
- do not replace the production frontend wholesale,
- do not invent unsupported backend behavior merely to satisfy a visual concept.

## 26. Architecture Definition of Done

Phase 1.5 UX architecture is satisfied when the implemented frontend demonstrates:

- grouped IA and clear current location,
- consistent page anatomy,
- consistent entity-detail patterns,
- human-readable names ahead of technical IDs where efficiently available,
- shared status and action semantics covering actual backend states,
- project-scoped lifecycle navigation,
- multi-output target naming consistency,
- three-zone Pipeline Builder,
- clear condition branching while preserving `always` semantics,
- explicit save/validate/publish/run UX without changing runtime contracts,
- guided pipeline validation recovery,
- graph-based Pipeline Run execution view using the exact historical pipeline version,
- visible rerun/reuse semantics,
- contextual scheduling,
- operational Monitoring and actionable Alerts,
- desktop-first responsive behavior,
- no regressions to existing auth/RBAC/API behavior.

## 27. Primary implementation references

Cursor should inspect at least these current frontend areas before Phase 1.5 work:

- `frontend/src/App.tsx`
- `frontend/src/AppShell.tsx`
- `frontend/src/ProjectContext.tsx`
- `frontend/src/components.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/Dashboard.tsx`
- `frontend/src/pages/ProjectOverview.tsx`
- `frontend/src/pages/DataSources.tsx`
- `frontend/src/pages/Datasets.tsx`
- `frontend/src/pages/DatasetDetail.tsx`
- `frontend/src/pages/Jobs.tsx`
- `frontend/src/pages/JobCreate.tsx`
- `frontend/src/pages/JobDetail.tsx`
- `frontend/src/pages/Runs.tsx`
- `frontend/src/pages/RunDetail.tsx`
- `frontend/src/pages/RunCompare.tsx`
- `frontend/src/pages/Pipelines.tsx`
- `frontend/src/pipelineForms.tsx`
- `frontend/src/pipelineHelpers.ts`
- `frontend/src/pages/Registry.tsx`
- `frontend/src/pages/ModelVersion.tsx`
- `frontend/src/pages/Endpoints.tsx`
- `frontend/src/pages/Predict.tsx`
- `frontend/src/pages/DeploymentApiUsage.tsx`
- `frontend/src/pages/BatchInference.tsx`
- `frontend/src/pages/Schedules.tsx`
- `frontend/src/pages/Monitoring.tsx`
- `frontend/src/pages/Alerts.tsx`
- `frontend/src/pages/AuditLogs.tsx`
- `frontend/src/pages/Administration.tsx`

Also inspect the corresponding frontend unit tests and Playwright tests before modifying user-visible behavior.
