# Phase 10 — v1.0 GA Release Readiness

Phase 10 prepares ModelFlow for a **v1.0 GA** release identity after Enhancement
Phases 1–9 landed on `main`. Phase 10-A is **planning / audit only**: no product
features, no version bump, no tag, no GitHub Release, no runtime or migration
changes.

## Current GA candidate baseline

| Field | Value |
|---|---|
| Candidate tip | `9e3f6e356795a1a063d2472b05520aa0009a0fd9` |
| Tip summary | Phase 9-D merge (`#96`) — accessibility / responsive closeout |
| Prior release identity | `v1.0.0-rc.1` only (no GA tag / GA release notes yet) |
| Alembic head | `024_oidc_enterprise_identity` |
| Enhancement phases on tip | **1 through 9 complete** (incl. 8-A–F, 9-A–D) |
| Primary verify gate | `./scripts/verify.sh` (Full Gate on `main` push / `workflow_dispatch`) |
| PR CI | PR Fast Gate (full gate exception only when PR title contains `Phase 8-F`) |
| Tip Full Gate at audit | GitHub Actions run on tip `9e3f6e3` was **in_progress** during 10-A; do not claim PASS until SUCCESS is recorded |

Source of truth for capabilities is the **current implementation and merged
phase docs**, not RC-era acceptance/limitations text.

## Implemented capability inventory (post Phases 1–9)

### Core MLOps (MVP + RC, retained)

- Auth: bootstrap admin, JWT sessions, password change, logout/`token_version`, RBAC, project isolation, audit
- Data: file upload (CSV/JSON/Parquet), dataset versions, profiling, quality rules, splits
- Training: classification/regression sklearn jobs, cancel/retry/clone, MLflow runs, experiment compare
- Governance: model lifecycle, server `ModelGatePolicy`, approval evidence
- Serving: realtime endpoints, batch inference, drift, alerts, monitoring
- Pipelines: visual DAG design/publish/execute, schedules (Phase 1)
- Ops scripts: `init-env.sh`, `verify.sh`, backup/restore round-trip, reset-dev / seed-demo
- Security gate: pip-audit + npm audit with allowlist fail-closed

### Enhancement depth (Phases 1–7)

- Scheduling / automation (Phase 1)
- Retraining foundation + multi-output regression (1.1 / 1.2)
- Frontend UX architecture shells (1.5)
- Multi-dataset visual preparation + reshape/agg (Phase 2)
- End-to-end Pipeline UX / historical run graphs (Phase 3)
- Connectors: PostgreSQL, MySQL/MariaDB, MSSQL, Oracle, REST (Phase 4)
- Closed-loop quality policies / feedback materialization (Phase 5 / 5.1)
- Time-aware training + forecasting / lag-rolling (Phase 6; recursive/panel/walk-forward deferred)
- LLM Pipeline Copilot foundation / preview-apply / graph patch (Phase 7)

### Enterprise / scale (Phase 8)

- **8-A** Dedicated `inference-runtime` service (API no longer owns in-process serving)
- **8-B** Worker scale-out, profiles, advisory-lock leadership
- **8-C** Optional OIDC Authorization Code + PKCE SSO (`MODELFLOW_OIDC_*`, default off)
- **8-D** Vendor-neutral `*_FILE` secret loading
- **8-E / 8-F** Helm chart + Kubernetes/HA docs/tests (external Postgres/object store required)

### Visual / a11y closeout (Phase 9)

- Design tokens, App Shell, workflow polish (9-A–9-C3)
- Accessibility / responsive / browser regression (9-D) with Chrome review PASS

## Stale documentation findings

Do **not** rewrite these files in 10-A. Later Phase 10 slices should.

| File | Factual drift |
|---|---|
| `README.md` | Still “v1.0 Release Candidate”; Docs index emphasizes RC; under-describes connectors, OIDC, inference-runtime, Helm/K8s |
| `docs/KNOWN_LIMITATIONS.md` | Claims no Kubernetes/HA; inference in API process; no SSO/LDAP as a single bullet — conflicts with 8-A/8-C/8-E (LDAP half still true) |
| `docs/ACCEPTANCE_CRITERIA.md` | Tip `2d2f3da`; Alembic evidence `005_…`; test counts 137/98/18; AC-27 says PRs run full gate (now Fast Gate); no AC coverage for Phases 1.5–9 |
| `docs/RELEASE_NOTES_v1.0.0-rc.1.md` | Correct as RC history; “what’s next: Scheduling” long obsolete; no GA notes file |
| `docs/PRODUCT_SPEC.md` | RC title; goals/non-goals still deny K8s/SSO and understate connectors |
| `docs/ARCHITECTURE.md` | Topology largely current (includes inference-runtime/OIDC); title still “(v1.0 RC)” |
| `docs/DECISIONS.md` | D-046–048 current; **D-006** still says inference in backend process (superseded in practice by 8-A, not marked); D-017 PR=full-gate wording stale |
| `docs/PROGRESS.md` / `docs/ENHANCEMENT_ROADMAP.md` / `docs/phase-9-final-visual-redesign.md` | Still say “Draft PR #96” after merge to `9e3f6e3` |
| `docs/ENHANCEMENT_ROADMAP.md` | Ended at Phase 9; Phase 0 still lists branch protection **pending**; framing still “post-RC future work” |

Rough current test surface (counts only; not a tip attestation): ~673 backend `def test_*`, ~371 frontend Vitest `it(` matches. Playwright suite has grown beyond the RC “18 tests” figure.

## True remaining limitations (still accurate)

Treat as **accepted product boundaries** unless GA explicitly expands scope:

- Sklearn tabular focus; no GPU/distributed training productization (GPU worker profile is routing-only)
- Pipeline engine is DB-worker DAG, not Airflow/Prefect
- Soft-delete + retention hard purge
- Default `store_inference_payloads=false`
- Automation / closed-loop never auto-promotes to PRODUCTION (stops at CANDIDATE)
- Compose remains a local/self-hosted trust boundary (do not expose raw ports)
- **No LDAP** (OIDC ≠ LDAP; OIDC optional and off by default)
- Kubernetes HA = stateless app replicas + **operator-managed external** Postgres/object store (D-048); not embedded single-node state HA
- Phase 6 outs: recursive forecasting, panel/entity features, walk-forward CV
- Pandas in-memory preparation only (no Spark/Dask)
- Possible orphan MinIO objects if upload succeeds and DB commit fails
- Non-blocking FE debt: duplicate active Pipeline Run polling loops
- Repository governance / branch protection still listed pending (Phase 0)

## GA blocker matrix

| ID | Item | Severity | Notes |
|---|---|---|---|
| G-01 | Release identity still RC (README branding; only `v1.0.0-rc.1` tag; no GA release notes) | **BLOCKER** | Required for GA claim; implement in a later packaging slice — not 10-A |
| G-02 | Tip Full Gate SUCCESS not yet attested for `9e3f6e3` | **BLOCKER** | Record Actions run SUCCESS (or local `./scripts/verify.sh` RESULT=OK) before GA |
| G-03 | `ACCEPTANCE_CRITERIA.md` tip/counts/head/AC-27 stale; enhancement phases unattested | **BLOCKER** | Refresh attestation to GA tip; fix AC-27 vs Fast Gate reality |
| G-04 | `KNOWN_LIMITATIONS.md` top bullets contradict Phase 8 | **SHOULD-FIX** | False operator guidance if shipped as GA |
| G-05 | `PRODUCT_SPEC.md` / README capability & non-goal drift | **SHOULD-FIX** | Misstates shipped connectors/OIDC/Helm |
| G-06 | `DECISIONS.md` D-006 (and D-017 context) not marked superseded/updated | **DOCUMENT-ONLY** | Implementation already correct |
| G-07 | Draft PR #96 wording in progress/roadmap/phase-9 docs | **DOCUMENT-ONLY** | Merge already on tip |
| G-08 | Architecture/PRODUCT/KNOWN titles still say “v1.0 RC” | **DOCUMENT-ONLY** | Cosmetic until GA naming pass |
| G-09 | Phase 0 branch protection / repo governance pending | **SHOULD-FIX** (process) | Not a product-code gap; confirm org policy before GA |
| G-10 | Sklearn-only / no LDAP / no Airflow / no auto-PRODUCTION / Compose trust boundary / external-state K8s HA | **ACCEPTED LIMITATION** | Keep unless GA scope expands |
| G-11 | Phase 6 deferred forecasting shapes; in-memory prep; orphan object edge case; dual polling | **ACCEPTED LIMITATION** | Document honestly; not GA feature work unless prioritized |

No evidence that Phase 8–9 **implementation** of inference-runtime, OIDC, Helm, or Phase 9-D is missing on tip.

## Exact verification plan (later Phase 10 slices)

1. **Tip attestation:** Wait for / confirm Full Gate SUCCESS on exact HEAD (or re-run `./scripts/verify.sh` and archive `artifacts/verify/RESULT.txt`).
2. **Doc truth-up:** Rewrite `KNOWN_LIMITATIONS.md`, refresh README/PRODUCT_SPEC deploy+capability language, mark D-006 superseded, fix Draft #96 wording.
3. **Acceptance refresh:** New tip SHA, Alembic head `024_oidc_enterprise_identity`, updated test counts from the attested gate, AC-27 aligned with Fast Gate, additive ACs (or explicit “covered by phase verify docs”) for 1.5–9.
4. **GA packaging (final slice only):** version bump, tag, `RELEASE_NOTES_v1.0.0.md`, GitHub Release — only after blockers G-01–G-03 clear.
5. **No invented features:** GA validates shipped behavior; deferred forecasting/LDAP/Spark stay documented limitations.

## Proposed Phase 10 slices

| Slice | Scope | Status |
|---|---|---|
| **10-A** | GA readiness baseline & gap audit (this document) | **in progress** |
| **10-B** | Documentation truth-up — `KNOWN_LIMITATIONS`, README/PRODUCT_SPEC/ARCHITECTURE framing, DECISIONS supersede notes, merge-status wording | planned |
| **10-C** | Acceptance & evidence refresh — tip Full Gate attestation, AC table update, CI wording (Fast vs Full) | planned |
| **10-D** | GA release packaging — version, tag, GA release notes, GitHub Release (only after G-01–G-03 clear) | planned |

Phase 10 overall remains **planned** until later slices complete. **Do not mark GA ready from 10-A alone.**
