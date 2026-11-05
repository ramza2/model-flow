# Phase 5 — Closed-loop MLOps

Status: **Phase 5-D current (closed-loop UX / final hardening)**  
Baseline: `main@2753a8e7a2c9338f6e0458a2d9f9c71dea38f32c` (Phase 5-C complete)

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

Post-GA feedback review guard (2026-11-05):

- `GET /projects/{project_id}/feedback-materializations/preflight?endpoint_id={id}` is a read-only, project-scoped (`DATA_READ`) advisory check for the endpoint's current model lifecycle and source training/dataset lineage. It returns `ready`, stable `reason`, and the current model identity for frontend preflight messaging.
- The feedback list's `materializable` filter continues to mean **feedback-data readiness** (approved, input snapshot retained, not yet reserved/materialized), not the production lifecycle of the connected model. The UI labels the distinction explicitly.
- The create POST retains all authoritative write-time checks and row locking; it may still reject stale selections or concurrent operations. Failed requests before run creation do not appear in the materialization run history. The UI explains that outcome in Korean, without translating internal API reason codes.
- Model promotion to `PRODUCTION` remains an explicit governance action; preflight never promotes models or creates data.

See [`phase-5b-verification.md`](./phase-5b-verification.md).

## Phase 5-C (complete)

PR #61 · squash `2753a8e7a2c9338f6e0458a2d9f9c71dea38f32c` · CI #300 PASS · Alembic `020_advanced_quality_policy`

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

## Phase 5-D (current)

Closed-loop UX / Final Hardening makes the existing loop operable at scale:

```text
Monitoring Production Quality card
  → structured closed_loop detail (code / reason / next action / resource ids)
  → recovery CTAs (Quality Policies, Feedback, Dataset, Training, Candidate, Alerts)
  → expandable quality-run evidence
  → filtered + paginated quality history
Quality Policies
  → server-filtered baseline candidates (endpoint + current model + ok)
  → baseline candidate pagination
Feedback Review
  → review_status / endpoint / materializable filters + pagination
  → materialization history pagination + failed error clarity
Hardening
  → policy revision row lock on baseline set/clear/semantic PATCH
  → re-verify alert / RetrainTrigger / Candidate idempotency
```

No new quality algorithms, no auto PRODUCTION, no Phase 5.1 incremental training.

Preferred Alembic head remains `020_advanced_quality_policy` (no new migration unless required).

## Slice order

1. **5-A Foundation** — complete
2. **5-B Feedback Dataset Materialization** — complete
3. **5-C Advanced Quality Policies** — complete
4. **5-D Closed-loop UX / Final Hardening** — current

Phase 5.1 (incremental / continued training) remains out of scope.
