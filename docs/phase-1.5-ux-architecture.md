# ModelFlow Phase 1.5 UX Architecture

Status: **Approved implementation baseline**  
Audience: Product, frontend, QA, Cursor Agents Window  
Scope: **Phase 1.5 — UX Architecture & Frontend UX Refactoring**

## 1. Purpose

Phase 1.5 establishes the UX architecture that the existing ModelFlow frontend must converge toward before later roadmap phases add more data preparation, connector, closed-loop, time-series, or copilot capabilities.

This phase is **not** a greenfield rewrite and is **not** a Figma-first deliverable. The existing production React frontend remains the functional source of truth. This document is the UX architecture source of truth for restructuring and refining that frontend.

### Source-of-truth order

1. Existing backend API contracts, auth, RBAC, project scoping, persistence, training, registry, deployment, scheduling, and pipeline runtime behavior.
2. Existing production frontend behavior in `frontend/src` where it represents supported product functionality.
3. This document for information architecture, navigation, page roles, lifecycle mental models, and cross-screen UX behavior.
4. `docs/phase-1.5-frontend-design-spec.md` for visual/layout/component implementation rules.

When this UX specification conflicts with an existing API or supported behavior, preserve the working behavior and adapt the UX around it unless a separate backend change is explicitly approved.

## 2. Current product baseline

The current frontend already exposes project-scoped routes for Data Sources, Datasets, Experiments, Training Jobs, Pipelines, Schedules, Model Registry, Deployments, Monitoring, Alerts, and Audit Logs, plus workspace-level Projects and Administration.

The current application shell already provides:

- a persistent top bar,
- project selection,
- grouped workspace/project/governance navigation,
- breadcrumbs,
- alert count,
- user menu,
- project-role-aware actions.

The current Pipeline Builder already supports a visual React Flow graph, node configuration, validation, save/publish/run behavior, condition branches, run history, and rerun-from-failed execution semantics. Phase 1.5 reorganizes and clarifies this UX rather than replacing the underlying behavior.

## 3. UX goals

Phase 1.5 must make ModelFlow understandable through three lifecycle models.

### 3.1 Data lifecycle

`Data Source → Dataset → Version → Quality`

The user should understand where data came from, which version is being used, whether quality checks passed, and which downstream resources depend on the data.

### 3.2 ML lifecycle

`Dataset → Training → Experiment → Model → Approval → Production → Deployment`

The user should be able to move from training input to experiment result, registered model, governance decision, and live serving without losing lineage.

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

Important entities should link to their upstream and downstream lineage wherever the backend already exposes enough information.

### 4.6 Operational clarity

The product must represent not only success paths, but also pending, running, failed, degraded, rejected, reused, retried, and unresolved states.

### 4.7 Preserve behavior

Phase 1.5 is a UX refactor. Do not silently change API contracts, route semantics, RBAC, lifecycle transitions, training behavior, model output semantics, or scheduler/runtime behavior.

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

### 5.1 Rationale

- **Data Sources / Datasets** are one preparation domain.
- **Pipelines / Training Jobs / Experiments** are one build domain.
- **Model Registry / Deployments** are the governed model-to-serving domain.
- **Schedules / Monitoring / Alerts** form the operational automation domain.
- **Audit Logs / Administration** remain governance/system responsibilities.

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

Conceptually:

`Current project resource → switch project → new project Overview`

### 6.3 Sidebar

The sidebar uses the grouped IA in section 5. The active group remains visually open and the current page has a clear active indicator that does not rely on color alone.

### 6.4 Breadcrumbs

Breadcrumbs should prefer human-readable names over numeric IDs.

Preferred:

`Phase1 Smoke Test / Training Jobs / Multi Output Smoke Training`

Not preferred:

`Phase1 Smoke Test / Training Jobs / #3`

Technical IDs remain available as secondary metadata where useful.

## 7. Page taxonomy and screen roles

| Screen | Primary UX role | Typical primary action |
| --- | --- | --- |
| Workspace Home | Current workspace/project activity | Continue work / Create project |
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
| Model Version Detail | Governance/lifecycle decision | Approve/Promote when allowed |
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

The purpose is to make the application learnable across entity types.

## 10. Project Overview role

Project Overview becomes the project lifecycle control center, not merely a statistics page.

It should let a user answer quickly:

- Is data healthy?
- Is training active or failing?
- Is there a production model?
- Is serving healthy?
- Are there alerts requiring attention?
- What should I do next?

Recommended sections:

- compact project health strip,
- Data summary,
- Build summary,
- Models summary,
- Serving summary,
- recent activity,
- members/access for authorized users.

## 11. RBAC UX

Conceptual roles remain:

- `VIEWER`
- `DATA_SCIENTIST`
- `ML_ENGINEER`
- `PROJECT_ADMIN`
- System Administrator

### UX rule

Do not hide readable lifecycle context unnecessarily. Prefer showing readable pages and withholding/disabling unauthorized mutation actions according to existing authorization behavior.

### Primary responsibility model

- Viewer: read-only lifecycle visibility.
- Data Scientist: datasets, training, experiments.
- ML Engineer: pipelines, registry, deployments, schedules.
- Project Admin: all project operations, members, governance.
- System Admin: platform administration and global audit.

Never weaken backend authorization to match the UI.

## 12. Status semantics

Use one shared semantic grammar.

### Neutral

`Draft`, `Stopped`, `Archived`, `Unknown`

### In progress

`Pending`, `Queued`, `Running`, `Validating`, `Pending Approval`

### Success

`Succeeded`, `Passed`, `Approved`, `Production`, `Published`, `Ready`

### Warning

`Partial`, `Degraded`, `Attention`

### Failure

`Failed`, `Rejected`, `Blocked`, `Error`

Pipeline execution may additionally communicate `Waiting`, `Skipped`, and `Reused` where those states are meaningful.

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
→ Pending Approval
→ Approved
→ Production
→ Create Deployment
→ Test Prediction
```

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

Use the currently supported node types:

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

Condition branch semantics must be visible on the graph itself. Prefer distinct `TRUE` / `FALSE` outputs or clearly labeled edges.

Do not require the user to understand a separate global branch selector before connecting an edge.

### 16.6 Save / Validate / Publish / Run

These states and actions must be distinct:

`Edit → Save version → Validate → Publish → Run`

- **Save version**: persists an explicit pipeline version.
- **Validate**: validates graph and node configuration.
- **Publish**: makes a valid version operationally executable.
- **Run**: starts execution.

Preserve the existing behavior that dirty/unsaved changes block publish/run.

### 16.7 Unsaved changes

Unsaved state must be obvious and navigation away must guard against silent loss.

Pipeline graph versions are not implicitly auto-saved.

### 16.8 Validation recovery

Validation is a guided correction workflow, not just an error banner.

A validation issue should identify the affected step and, where practical, selecting the issue should:

1. center/highlight the node,
2. select it,
3. open the Inspector,
4. bring attention to the relevant field.

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

## 17. Pipeline Run architecture

Pipeline Run should reuse the graph language of the Builder in read-only execution mode.

The main visualization should not degrade into an unrelated card list.

Selecting an execution node should expose:

- status,
- start/finish or elapsed time,
- attempt,
- branch decision where relevant,
- reason/error,
- input/resource context where available,
- logs.

### Failure recovery

For failed runs:

`Failed node → inspect error/log → Rerun from failed`

When successful upstream steps are reused, show `Reused` clearly so the operator knows those steps were not rerun.

## 18. Scheduling UX

Schedules should feel attached to executable resources, not like a standalone raw Cron editor.

Preferred contextual flow:

`Published Pipeline → Schedule → Create Schedule`

The central Schedules page remains the management catalog for pipeline runs, batch inference, and data import schedules already supported by the product.

Basic fields should be primary; cron expression and parameters JSON are advanced controls.

## 19. Monitoring UX

Monitoring is an operational triage page organized around:

- Service Health,
- Data Health,
- Model Health.

The user should first understand whether attention is required, then drill into supporting metrics and affected resources.

Do not add decorative charts without an operational decision purpose.

## 20. Alerts UX

Alerts are actionable exceptions, not passive logs.

Each alert should communicate:

- what happened,
- why it matters,
- which resource is affected,
- when it happened,
- what the user can do next.

Where a resource link is available, provide it.

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
- shared components and tokens,
- common status/action patterns.

### Phase 1.5-B — Pipeline UX

- Node Library / Canvas / Inspector,
- condition branch UX,
- validation panel,
- unsaved flow,
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

## 24. Cursor implementation rules

Before changing UI code, inspect the relevant current routes/components/API calls and tests.

For every Phase 1.5 implementation task:

- preserve backend API contracts unless explicitly approved otherwise,
- preserve routing semantics and deep-linkability,
- preserve authentication and authorization,
- preserve project context and project scoping,
- preserve existing supported functionality,
- prefer shared reusable components over page-specific duplication,
- keep current tests passing and add/update tests for changed UX behavior,
- do not replace the production frontend wholesale,
- do not invent unsupported backend behavior merely to satisfy a visual concept.

## 25. Architecture Definition of Done

Phase 1.5 UX architecture is satisfied when the implemented frontend demonstrates:

- grouped IA and clear current location,
- consistent page anatomy,
- consistent entity-detail patterns,
- human-readable names ahead of technical IDs,
- shared status and action semantics,
- project-scoped lifecycle navigation,
- multi-output target naming consistency,
- three-zone Pipeline Builder,
- clear condition branching,
- explicit save/validate/publish/run semantics,
- guided pipeline validation recovery,
- graph-based Pipeline Run execution view,
- visible rerun/reuse semantics,
- contextual scheduling,
- operational Monitoring and actionable Alerts,
- desktop-first responsive behavior,
- no regressions to existing auth/RBAC/API behavior.

## 26. Primary implementation references

Cursor should inspect at least these current frontend areas before Phase 1.5 work:

- `frontend/src/App.tsx`
- `frontend/src/AppShell.tsx`
- `frontend/src/ProjectContext.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/ProjectOverview.tsx`
- `frontend/src/pages/DatasetDetail.tsx`
- `frontend/src/pages/JobDetail.tsx`
- `frontend/src/pages/Runs.tsx`
- `frontend/src/pages/RunDetail.tsx`
- `frontend/src/pages/Pipelines.tsx`
- `frontend/src/pipelineForms.tsx`
- `frontend/src/pipelineHelpers.ts`
- `frontend/src/pages/Registry.tsx`
- `frontend/src/pages/ModelVersion.tsx`
- `frontend/src/pages/Endpoints.tsx`
- `frontend/src/pages/Predict.tsx`
- `frontend/src/pages/BatchInference.tsx`
- `frontend/src/pages/Schedules.tsx`
- `frontend/src/pages/Monitoring.tsx`
- `frontend/src/pages/Alerts.tsx`

Also inspect relevant frontend unit tests and Playwright tests before modifying their corresponding screens.
