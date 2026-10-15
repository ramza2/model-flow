# Phase 10 — v1.0 GA Release Readiness

Phase 10 prepares ModelFlow for a **v1.0 GA** release identity after Enhancement
Phases 1–9 landed on `main`. Phase 10-A was **planning / audit only**: no product
features, no version bump, no tag, no GitHub Release, no runtime or migration
changes.

**Phase 10-A status:** complete. **Phase 10-B status:** complete (documentation truth-up). **Phase 10-C:** next. **Phase 10 overall:** in progress — **not GA ready**.

## Current GA candidate baseline

| Field | Value |
|---|---|
| Phase 10 starting baseline | `9e3f6e356795a1a063d2472b05520aa0009a0fd9` |
| Tip summary | Phase 9-D merge (`#96`) — accessibility / responsive closeout |
| 10-A merge on main | `3e271e172580932ce7ae61d89b62c3625c54ce7a` (PR #97) |
| Prior release identity | `v1.0.0-rc.1` only (no GA tag / GA release notes yet) |
| Alembic head | `024_oidc_enterprise_identity` |
| Enhancement phases on tip | **1 through 9 complete** (incl. 8-A–F, 9-A–D) |
| Primary verify gate | `./scripts/verify.sh` (Full Gate on `main` push / `workflow_dispatch`) |
| PR CI | PR Fast Gate (full gate exception only when PR title contains `Phase 8-F`) |
| Baseline Full Gate | **CI run #512** / id [`38692158110`](https://github.com/ramza2/model-flow/actions/runs/38692158110) — event `push`, exact head `9e3f6e3`, **completed SUCCESS** (main Full verification gate) |

**Full Gate scope note:** #512 attests the Phase 10 **starting** baseline `9e3f6e3` only.
Later Phase 10 commits create newer candidate SHAs. The **final GA packaging SHA**
must receive its **own** Full Gate SUCCESS before `v1.0.0` is tagged or published.

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

### Cleared in Phase 10-B

| File | Correction |
|---|---|
| `README.md` | Non-GA identity retained; capabilities/deploy (Compose + Helm/K8s, OIDC, inference-runtime, connectors) truth-up; Docs index points at Phase 10 |
| `docs/KNOWN_LIMITATIONS.md` | Removed Compose-only / in-API inference / no-SSO bullets; replaced with current HA/OIDC/runtime boundaries |
| `docs/PRODUCT_SPEC.md` | Current goals/non-goals; connectors and deploy modes; no false K8s/SSO non-goals |
| `docs/ARCHITECTURE.md` | Neutral title; deployment modes section for Compose vs Helm + external durable state |
| `docs/DECISIONS.md` | D-006 marked superseded by Phase 8-A; D-017 annotated for Fast vs Full gates (90m) |
| `docs/phase-9-final-visual-redesign.md` | Draft PR #96 → PR #96 merged |

### Remaining for later slices

| File | Factual drift |
|---|---|
| `docs/ACCEPTANCE_CRITERIA.md` | Tip `2d2f3da`; Alembic evidence `005_…`; stale test counts; AC-27 vs Fast Gate — **10-C** |
| `docs/RELEASE_NOTES_v1.0.0-rc.1.md` | Correct as RC history; GA notes belong to **10-D** |
| Phase 0 branch protection | Still listed pending — process item **G-09**, not fabricated complete |

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

### Active blockers

| ID | Item | Severity | Notes |
|---|---|---|---|
| G-01 | Release identity still not GA (only `v1.0.0-rc.1` tag; no GA release notes / version bump) | **BLOCKER** | README no longer claims released GA, but packaging remains **10-D** |
| G-03 | `ACCEPTANCE_CRITERIA.md` tip/counts/head/AC-27 stale; enhancement phases unattested | **BLOCKER** | Refresh attestation in **10-C** |

### Cleared evidence

| ID | Item | Status | Evidence |
|---|---|---|---|
| G-02 | Starting-baseline Full Gate for `9e3f6e3` | **CLEARED / VERIFIED** | CI run **#512** / [`38692158110`](https://github.com/ramza2/model-flow/actions/runs/38692158110) push Full Gate **SUCCESS** on exact SHA `9e3f6e356795a1a063d2472b05520aa0009a0fd9` |
| G-04 | `KNOWN_LIMITATIONS.md` Phase-8 conflict | **CLEARED** | Phase 10-B rewrite |
| G-05 | README / `PRODUCT_SPEC.md` capability & non-goal drift | **CLEARED** | Phase 10-B truth-up |
| G-06 | `DECISIONS.md` D-006 / D-017 drift | **CLEARED** | Phase 10-B annotations |
| G-07 | Remaining Draft PR #96 wording | **CLEARED** | Phase 10-B (`phase-9-final-visual-redesign.md`) |
| G-08 | Stale “(v1.0 RC)” titles / framing in touched GA docs | **CLEARED** | Neutral GA-candidate framing in KNOWN/PRODUCT/ARCHITECTURE |

**Still required before the GA tag:** a Full Gate SUCCESS on the **final packaging SHA** (not only #512 on the Phase 10 start tip). See 10-D ordering below. Do not treat an in-progress or later main Full Gate (#515, etc.) as the packaging attestation unless it is SUCCESS on the exact packaging SHA.

### Other rows

| ID | Item | Severity | Notes |
|---|---|---|---|
| G-09 | Phase 0 branch protection / repo governance pending | **SHOULD-FIX** (process) | Unresolved; do not mark complete without verified repository policy |
| G-10 | Sklearn-only / no LDAP / no Airflow / no auto-PRODUCTION / Compose trust boundary / external-state K8s HA | **ACCEPTED LIMITATION** | Keep unless GA scope expands |
| G-11 | Phase 6 deferred forecasting shapes; in-memory prep; orphan object edge case; dual polling | **ACCEPTED LIMITATION** | Documented in KNOWN_LIMITATIONS after 10-B |

No evidence that Phase 8–9 **implementation** of inference-runtime, OIDC, Helm, or Phase 9-D is missing on tip.

## Exact verification plan (later Phase 10 slices)

1. **Baseline attestation (done):** Full Gate #512 SUCCESS on starting tip `9e3f6e3`.
2. **Doc truth-up (done — 10-B):** `KNOWN_LIMITATIONS`, README/PRODUCT_SPEC/ARCHITECTURE, DECISIONS D-006/D-017, Draft #96 wording.
3. **Acceptance refresh (10-C — next):** Update AC tip/counts/head, AC-27 aligned with Fast Gate, additive ACs (or explicit “covered by phase verify docs”) for 1.5–9.
4. **GA packaging (10-D):** Follow the release ordering below — never tag an unverified packaging commit.
5. **No invented features:** GA validates shipped behavior; deferred forecasting/LDAP/Spark stay documented limitations.

## Final GA release ordering (10-D)

Safe sequence — **do not tag an unverified packaging commit**:

1. **Prepare / merge GA identity** — version metadata + `RELEASE_NOTES_v1.0.0.md` (+ related GA branding docs as needed) **without** creating the tag or GitHub Release yet.
2. **Wait for Full verification gate SUCCESS** on that exact `main` SHA (push Full Gate or equivalent attested `./scripts/verify.sh`).
3. **Create the `v1.0.0` tag** on that exact verified SHA (annotated or lightweight per existing repository convention).
4. **Publish the GitHub GA Release** from that tag.
5. **Post-release smoke** if the Phase 10 plan for 10-D requires it.

#512 does **not** substitute for step 2 on a newer packaging SHA.

## Proposed Phase 10 slices

| Slice | Scope | Status |
|---|---|---|
| **10-A** | GA readiness baseline & gap audit (this document) | **complete** |
| **10-B** | Documentation truth-up — `KNOWN_LIMITATIONS`, README/PRODUCT_SPEC/ARCHITECTURE framing, DECISIONS supersede notes, merge-status wording | **complete** |
| **10-C** | Acceptance & evidence refresh — AC table update, CI wording (Fast vs Full), GA tip attestation linkage | **next** |
| **10-D** | GA release packaging — version + notes merge, then exact-SHA Full Gate, then tag + GitHub Release | planned |

Phase 10 overall remains **in progress / not GA ready**. **Do not claim v1.0 GA readiness from 10-B alone.**
