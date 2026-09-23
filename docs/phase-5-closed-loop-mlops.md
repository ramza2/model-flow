# Phase 5 — Closed-loop MLOps

Status: **Phase 5-C current (advanced quality policies)**  
Baseline: `main@4549b04030a9443266592a5cbbe8e06a2a3600a2` (Phase 5-B complete)

## Non-negotiable boundary

```text
Closed-loop automation terminates at CANDIDATE.
PRODUCTION requires explicit authorized human action.
```

## Phase 5-A (complete)

PR #59 · squash `1bb13bc2e527951e1a580787c35cd530fed45e7a` · CI #285 PASS · Alembic `018_closed_loop_mlops`

Delivered:

- PredictionObservation + `prediction_ids`
- GroundTruthFeedback (JWT + Service API Key)
- ModelQualityPolicy / ModelQualityRun + metrics
- degradation Alert + schedule target `model_quality`
- full retrain onto newer compatible DatasetVersion
- automatic Registry registration as **CANDIDATE** only

Ground truth in 5-A was **evaluation evidence only** (no automatic DatasetVersion materialisation).

## Phase 5-B (complete)

PR #60 · squash `4549b04030a9443266592a5cbbe8e06a2a3600a2` · CI #294 PASS · Alembic `019_feedback_materialization`

Feedback Dataset Materialization turns **explicitly APPROVED** ground truth into a new immutable DatasetVersion:

```text
Production Prediction
  → PredictionObservation (+ input_json snapshot)
  → GroundTruthFeedback (PENDING)
  → Human Review (APPROVED | REJECTED)
  → FeedbackMaterializationRun
  → base DatasetVersion + approved rows
  → new immutable DatasetVersion (source_type=feedback_materialization)
  → Phase 5-A closed-loop retrain discovery
  → CANDIDATE
  → Human Approval → PRODUCTION
```

Rules:

- Ground Truth submission ≠ training inclusion
- Only `APPROVED` + `input_json IS NOT NULL` feedback may materialize
- Existing DatasetVersions are never modified (cumulative v1→v2→v3)
- Materialization does not auto-create TrainingJobs; Phase 5-A discovery path remains the retrain trigger
- Automation still stops at CANDIDATE

See [`phase-5b-verification.md`](./phase-5b-verification.md).

## Phase 5-C (current)

Advanced Quality Policies strengthen evaluation without changing Candidate governance:

```text
Production Prediction
  → Ground Truth
  → Model Quality Run
  → Immutable Policy Snapshot (revision + baseline + rules)
  → Data Sufficiency Gate (matched samples + match rate + evaluation delay)
  → Multiple Quality Rules
       ├─ Absolute Threshold
       └─ Fixed Baseline Degradation (baseline_delta)
  → ANY / ALL Rule Combination
  → OK / WARNING / CRITICAL
  → consecutive breach (revision-scoped)
  → cooldown
  → existing full retraining
  → CANDIDATE
```

Key additions:

- multi-metric / multi-rule policies with `rule_logic` ANY|ALL
- fixed `ModelQualityBaseline` (explicit human pin; no rolling/auto baseline)
- `evaluation_delay_hours` and optional `minimum_match_rate`
- immutable `policy_snapshot_json` + `evaluation_json` on each run
- policy `revision` isolates consecutive-breach chains
- legacy single-metric policies remain one effective absolute rule

See [`phase-5c-verification.md`](./phase-5c-verification.md).

## Slice order

1. **5-A Foundation** — complete
2. **5-B Feedback Dataset Materialization** — complete
3. **5-C Advanced Quality Policies** — current
4. **5-D Closed-loop UX / Final Hardening**

Phase 5.1 (incremental / continued training) remains out of scope.
