# Phase 5-C Verification — Advanced Quality Policies

## Scope

Phase 5-C extends Model Quality Policies with multi-rule evaluation, fixed baseline degradation, sufficiency gates, and immutable policy/run snapshots. Closed-loop automation still terminates at **CANDIDATE**.

## Baseline

- Branch work starts from `main@4549b04030a9443266592a5cbbe8e06a2a3600a2`
- Phase 5-B PR #60 merged; post-merge CI #294 PASS
- Prior Alembic head: `019_feedback_materialization`

## Delivered (this branch)

- Alembic `020_advanced_quality_policy`
  - `ModelQualityPolicy`: `revision`, `evaluation_delay_hours`, `minimum_match_rate`, `rule_logic`, `rules_json`
  - `ModelQualityRun`: `policy_revision`, `policy_snapshot_json`, `evaluation_json`
  - `model_quality_baselines` table (one active baseline per policy)
- Shared evaluation engine via `effective_quality_rules()` (legacy → one absolute rule)
- Absolute + `baseline_delta` comparisons; ANY/ALL combination
- Enqueue-time policy/baseline/model snapshot; execute uses snapshot only
- Revision-scoped consecutive breach counting; snapshot-aware closed-loop decision
- Alert messages from `evaluation_json` rule evidence
- Minimal Quality Policies UI + Monitoring advanced evidence
- Backend tests: `test_advanced_quality_policies.py` (+ Phase 5-A/5-B regressions)
- Frontend tests + Playwright `e2e/advanced-quality-policy.spec.ts`

## Explicit non-goals

- rolling / percentage / automatic baselines
- champion/challenger, auto promote, endpoint swap
- incremental / `partial_fit` / warm-start
- Phase 5-D broad UX redesign

## Status

Phase 5-C remains **not complete** on `main` until Draft PR merge + post-merge `main` CI PASS.
Do not treat this document as marking Phase 5-C complete.
