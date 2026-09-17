# Phase 3-D Verification — Final Hardening / Browser Regression

Status: **Draft PR verification baseline**

Baseline: `main@33fdab3955f3a199b25ce0fb37e35c0cb3d0b26a`

## Purpose

Phase 3-D is the final hardening slice for the Phase 3 Pipeline UX. It does not add a new Pipeline capability. It closes the remaining navigation-loss gap and verifies the Phase 3-A/B/C lifecycle UX under real browser navigation, RBAC, and responsive conditions.

## Core invariants

- Dataset Preparation still materializes an immutable DatasetVersion.
- Pipeline `dataset_load` still consumes an exact DatasetVersion when one is pinned.
- Pipeline execution/retry/reuse semantics remain backend-owned.
- Historical PipelineVersion remains the source of truth for Pipeline Run summaries.
- Viewer/read-only users can inspect Pipeline state but cannot mutate it.
- Unsaved graph edits must not be silently discarded by ordinary same-origin SPA navigation.

## Unsaved navigation matrix

| Navigation path | Expected behavior while dirty |
| --- | --- |
| browser refresh / close | existing `beforeunload` prompt remains active |
| Builder `← Pipelines` link | existing Builder-local confirmation remains authoritative |
| sidebar / breadcrumb / topbar same-origin links | shared app confirmation before route change |
| project picker | shared app confirmation before selected project changes |
| sign out | shared app confirmation before session navigation |
| same-page hash link | no prompt |
| external link / new tab / download | no app-level interception |
| ctrl/cmd/shift/alt modified click | no app-level interception |

The Phase 3-D app-level guard is activated only while the Pipeline Builder exposes its existing `Unsaved changes` state and is cleared when the Builder unmounts.

## Browser regression coverage

`e2e/phase3-pipeline-hardening.spec.ts` adds browser coverage for:

- dirty Pipeline → sidebar navigation → dismiss confirmation → route and dirty state preserved
- dirty Pipeline → project switch → dismiss confirmation → current project preserved
- dirty Pipeline → project switch → accept confirmation → navigation succeeds
- Viewer direct Pipeline Builder navigation → lifecycle summary visible, Builder read-only, mutation controls absent
- 900px drawer viewport → lifecycle summary visible, nav toggle `aria-expanded` state correct, Escape closes drawer and restores focus, no page-level horizontal overflow

Existing browser suites continue to cover the surrounding lifecycle, including:

- Pipeline Builder create/configure/save flow
- Viewer and Data Scientist RBAC menus/actions
- Dataset/quality/training workflows
- Experiment detail
- deployment API usage
- schedules
- drift/alerts
- end-to-end happy path

## Unit regression coverage

`frontend/src/unsavedChanges.test.ts` covers:

- no prompt when no unsaved state is active
- consistent confirmation copy while dirty
- same-origin route navigation is guarded
- in-page hash navigation is not guarded
- Builder-local back link is excluded to avoid duplicate prompts
- external navigation is not intercepted

Existing Phase 3-A/B/C unit suites remain authoritative for:

- lifecycle node taxonomy
- exact DatasetVersion Preparation → Pipeline handoff
- invalid handoff no-latest-fallback rule
- unified run status vocabulary
- stage/overall progress
- first-failed-node recovery focus
- DatasetVersion / Training / Experiment / Model / Deployment lineage extraction

## Retained non-blocking optimization debt

The Phase 3-C lifecycle Run wrapper and the underlying historical Run Detail currently maintain independent active-run polling loops. This duplicates a small read-only request while a run is active but does not change state correctness, retry behavior, or persisted data. Consolidating those readers would require widening the existing Run Detail component contract and is retained as a later frontend performance cleanup rather than expanding the final Phase 3 hardening diff.

## Merge gate

Before merge:

- targeted frontend unit tests PASS
- full frontend Vitest PASS
- frontend production build PASS
- all Playwright E2E PASS, including `phase3-pipeline-hardening.spec.ts`
- repository `./scripts/verify.sh` PASS
- exact PR HEAD GitHub Actions PASS
- actual diff final review finds no blocker

After merge:

- new `main` commit is verified
- post-merge `main` CI PASS

Only after the post-merge `main` CI passes is **Enhancement Phase 3 — End-to-End Pipeline UX** complete.
