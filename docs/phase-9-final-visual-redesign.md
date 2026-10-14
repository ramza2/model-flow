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

The Figma file currently contains the 9-A visual foundation:

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
| **9-A** | Design Foundation + App Shell | **current** |
| **9-B** | Data / Build / Pipeline Workflow Polish | planned |
| **9-C** | Models / Serving / Operations Visual Polish | planned |
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

Target areas:

- Data Sources, Datasets, Preparations, Feedback
- Training Jobs, Experiments
- Pipeline catalog, builder, validation, run views
- complex forms, tables, node panels, progressive disclosure

No workflow/API semantic changes are implied.

### 9-C — Models / Serving / Operations Visual Polish

Target areas:

- Model Registry and governance lifecycle
- Deployments, prediction, API usage, batch inference
- Schedules, Monitoring, Quality Policies, Alerts, Audit
- operational metrics, charts, status density, triage surfaces

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
