# Phase 5 — Closed-loop MLOps

Status: **Phase 5-B current (feedback materialization)**  
Baseline: `main@1bb13bc2e527951e1a580787c35cd530fed45e7a` (Phase 5-A complete)

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

## Phase 5-B (current)

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

## Slice order

1. **5-A Foundation** — complete
2. **5-B Feedback Dataset Materialization** — current
3. **5-C Advanced Quality Policies**
4. **5-D Closed-loop UX / Final Hardening**

Phase 5.1 (incremental / continued training) remains out of scope.
