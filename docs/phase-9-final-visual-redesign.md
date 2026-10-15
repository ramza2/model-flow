# Phase 9 — Final Visual Redesign

Phase 9 is the product-wide visual completion pass after functional workflows,
enterprise architecture, and deployment hardening have stabilized.

## Baseline

- Phase 8-F merged via PR #86.
- Phase 8 final main commit: `2669c996872df30a905b3e298740e3ffd36bac5e`.
- Phase 8-F exact-head CI #472 PASS.
- Phase 8-F post-merge main CI #473 PASS.
- Alembic head remains `024_oidc_enterprise_identity`.
- Phase 9 does not change backend/API/runtime behavior unless a later slice
  explicitly identifies a presentation blocker that cannot be solved in the
  frontend.

## Design source of truth

Phase 9 is Figma-driven, as defined by the enhancement roadmap.

Figma file:

- **ModelFlow Phase 9 — Final Visual Redesign**
- https://www.figma.com/design/BSC61v5iuERhccl4HXdi6u

The Figma file contains the Phase 9 visual foundation and workflow frames.
9-A App Shell is complete on `main`. 9-B1 uses the **9-B1 Data Workflow** page
(Data Sources / Datasets / Preparations frames) as the visual reference.

9-A foundation includes:

- ModelFlow primitive + semantic color variables
- spacing and radius variables
- DM Sans typography styles
- IBM Plex Mono technical text style
- reusable Button variants
- reusable Sidebar Nav Item variants
- a 1440 × 960 App Shell reference screen

Functional behavior remains sourced from the existing React application, API
contracts, auth/RBAC rules, persisted data, and regression tests. Figma governs
the Phase 9 visual presentation.

## Visual direction

Phase 9 keeps ModelFlow's existing dark engineering identity rather than
replacing the product with a generic dashboard theme.

The final direction is:

- calmer dark surfaces with clearer separation between canvas, surface, soft,
  and raised layers
- teal remains the primary product/accent color
- amber remains a secondary attention/accent color
- DM Sans remains the UI typeface
- IBM Plex Mono remains the technical/code typeface
- tighter navigation density, stronger page-title hierarchy, and more consistent
  40px controls
- fewer decorative effects; visual state should come primarily from typography,
  surface hierarchy, borders, and semantic status color
- no new product concepts introduced solely for visual polish

## Slice plan

| Slice | Scope | Status |
|---|---|---|
| **9-A** | Design Foundation + App Shell | **complete** (merged via PR #87) |
| **9-B** | Data / Build / Pipeline Workflow Polish | **complete** |
| **9-B1** | Data Workflow Visual Polish (Sources / Datasets / Preparations) | **complete** |
| **9-B2** | Training / Experiments Visual Polish | **complete** |
| **9-B3** | Preparation Builder / Pipeline Builder Visual Polish | **complete** |
| **9-B4** | Feedback / Pipeline Catalog & Run Views Polish | **complete** |
| **9-C** | Models / Serving / Operations Visual Polish | **current** |
| **9-C1** | Model Registry / Model Version Governance Visual Polish | **complete** |
| **9-C2** | Deployments / Serving Visual Polish | **current / Draft** |
| **9-C3** | Operations Visual Polish | planned |
| **9-D** | Final Accessibility / Responsive / Browser Regression | planned |

### 9-A — Design Foundation + App Shell

Scope:

- finalize Phase 9 semantic colors, typography, spacing, radii, and core surface hierarchy
- align App Shell topbar/sidebar/content frame with the Figma reference
- normalize shared Button, Status, Panel, Page Header, input, and table visual treatment where existing shared classes permit it
- preserve current route structure, navigation groups, responsive drawer behavior,
  unsaved-change guards, project switching, alerts, user menu, and RBAC
- no backend/API/database changes
- no broad page-by-page redesign yet

Acceptance:

- existing AppShell/component unit tests remain green
- responsive drawer behavior remains unchanged functionally
- keyboard focus remains visible
- existing pages render without horizontal shell overflow
- PR Fast Gate passes on the exact head
- final browser review is required before 9-A merge

### 9-B — Data / Build / Pipeline Workflow Polish

**Status:** complete. Split into reviewable visual-only slices. No workflow/API semantic changes.

#### 9-B1 — Data Workflow Visual Polish (complete)

Scope:

- Data Sources catalog hierarchy (type / connection state / recent imports)
- Datasets catalog table hierarchy (name / description / immutable latest version)
- Preparations catalog table hierarchy (name / description / version / output)
- reuse Phase 9-A tokens; no new color system
- preserve Test / Import / Edit / Upload / Create / Delete / deep links
- do not invent Connected counts, filters, or Figma-only columns without API support
- Preparation Builder remains out of scope (later 9-B3)

#### 9-B2 — Training / Experiments Visual Polish (complete)

Scope:

- Training Jobs catalog (status filter, scan-friendly table hierarchy)
- Training Job detail (status vs lifecycle actions, MetricSummary, setup/lineage, engineering logs)
- Experiments catalog (search, multi-select, Compare selected CTA)
- Experiment Run detail (summary / metrics / lineage / technical hierarchy)
- Compare Runs (primary metrics first, then identity, then technical params)
- JobCreate excluded from this slice
- no workflow/API/polling/RBAC semantic changes

#### 9-B3 — Preparation Builder / Pipeline Builder Visual Polish (complete)

Scope:

- Preparation Builder workspace visual polish (header/actions, dirty state band,
  node library groups, canvas surface, inspector hierarchy, preview/run panels)
- Pipeline Builder workspace visual polish (header/actions, draft/published/dirty
  state band, node library, React Flow node density, selected/invalid/warning
  states, inspector hierarchy, validation issue panel)
- Pipeline Copilot entry + proposal/preview/confirmation visual hierarchy
  (proposal-before-apply clarity; stale-response guards unchanged)
- Pipeline catalog / list / Run Detail / schedule page excluded (later 9-B4)
- reuse Phase 9-A / 9-B1 / 9-B2 tokens; no new color system
- no graph schema, React Flow behavior, API, or runtime semantic changes

#### 9-B4 — Feedback / Pipeline Catalog & Run Views Polish (complete)

Scope:

- Feedback Review visual polish (compact review toolbar, selection actions,
  queue table hierarchy, locked/materialized row treatment, HISTORY section)
- Pipeline Catalog visual polish (catalog density aligned with 9-B1/B2,
  name/description hierarchy, version-chip, schedule published/unpublished clarity)
- Pipeline Run Detail visual polish (run identity / historical version / status,
  execution workspace graph + inspector hierarchy, run-status node states,
  EXECUTION logs section, fallback card hierarchy)
- Builder / Copilot excluded (completed in 9-B3)
- no new aggregate count cards or dashboard metrics without API support
- workflow / API / polling / historical-version / rerun-from-failed semantics unchanged

### 9-C — Models / Serving / Operations Visual Polish

**Status:** current. Split into reviewable visual-only slices.

#### 9-C1 — Model Registry / Model Version Governance Visual Polish (complete)

Scope:

- Model Registry visual polish (header / Register from run, lifecycle toolbar,
  catalog density, NEW CANDIDATE registration panel)
- Model Version governance visual polish (lifecycle/gates state band, primary
  vs secondary actions, Lifecycle Progress, metrics, approval evidence / lineage
  2-column hierarchy, VALIDATION gates, review comment evidence input)
- lifecycle / gate / approval / RBAC / deployment eligibility semantics unchanged
- Deployments / serving / operations pages excluded until 9-C2 / 9-C3

#### 9-C2 — Deployments / Serving Visual Polish (current)

Scope:

- Deployments visual polish (header actions, ONLINE PREDICTION create panel,
  card hierarchy, metric density, Test prediction primary serving action)
- Prediction Test visual polish (status/output state band, request/response
  hierarchy, engineering JSON surfaces, stopped endpoint notice)
- API Usage / Service API Keys visual polish (method/URL surface, body/cURL
  engineering grid, credentials section, one-time secret panel, inactive keys)
- Batch Inference visual polish (new job form vs history separation, catalog
  table density) while preserving 2.5s polling and stream download semantics
- serving / API / security / polling semantics unchanged
- operations pages excluded until 9-C3

#### 9-C3 — Operations Visual Polish (planned)

Target: Schedules, Monitoring, Quality Policies, Alerts, Audit.

### 9-D — Final Accessibility / Responsive / Browser Regression

Closeout only:

- keyboard/focus/contrast review
- mobile/tablet shell and dense-page behavior
- representative browser regression with realistic data
- full visual consistency sweep
- no new product features

## 9-A token baseline

The 9-A Figma foundation and CSS use these primary values:

| Token | Value |
|---|---|
| Canvas | `#0B1016` |
| Surface | `#121922` |
| Soft surface | `#18222D` |
| Raised surface | `#202C39` |
| Border | `#2B3948` |
| Primary text | `#EEF4F8` |
| Muted text | `#93A6B8` |
| Accent | `#45C8AE` |
| Warm accent | `#F0A45D` |
| Success | `#62D892` |
| Warning | `#E6C75F` |
| Danger | `#F07878` |
| Control radius | `8px` |
| Card radius | `12px` |
| Panel radius | `16px` |
| Topbar height | `72px` |
| Sidebar width | `248px` |

## Constraints

- Do not replace the React frontend wholesale.
- Do not change backend/API contracts for cosmetic convenience.
- Do not remove accessibility or responsive behavior during visual cleanup.
- Do not introduce Figma-only controls that have no existing product behavior.
- Keep the product-language baseline in English.
- Preserve deep links and route semantics.
- Keep technical/code values readable and selectable; do not turn them into
  decorative images.
