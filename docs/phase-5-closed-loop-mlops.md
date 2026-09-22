# Phase 5 — Closed-loop MLOps

Status: **Phase 5-A current (foundation)**  
Baseline: `main@364c0d846a8cbfe81a16cc0d0e16743d43c610f0`

## Purpose

Connect production predictions, ground-truth feedback, model quality evaluation, degradation alerts, and full retraining so ModelFlow can propose improved **CANDIDATE** models without ever auto-promoting to PRODUCTION.

## Non-negotiable boundary

```text
Closed-loop automation terminates at CANDIDATE.

PRODUCTION always requires explicit authorized human action.
```

Automation may:

- store PredictionObservation rows and return `prediction_ids`
- accept GroundTruthFeedback
- evaluate ModelQualityPolicy windows
- create degradation Alert rows
- trigger full retraining onto a **newer** compatible DatasetVersion
- register the succeeded retrain as ModelVersion lifecycle **CANDIDATE**
- run server-owned gate evaluation while remaining **CANDIDATE**

Automation must never:

- request approval
- approve / reject
- promote to PRODUCTION
- swap endpoints
- roll back production deployments

## Evaluation data vs training data

Ground truth is **evaluation evidence** in Phase 5-A. It is not automatically materialised into a training DatasetVersion.

```text
Prediction + Ground Truth → Production Quality Evaluation
Logical Dataset → newer immutable DatasetVersion → Full Retraining
```

If quality is critical but no newer DatasetVersion exists, retraining is skipped (`no_new_dataset_version`) and a warning Alert may be raised. Retraining on the same DatasetVersion is forbidden.

Phase 5-B will add reviewed-feedback → DatasetVersion materialisation.

## Core entities

| Entity | Role |
| --- | --- |
| `PredictionObservation` | Stable per-instance prediction id + model_version snapshot |
| `GroundTruthFeedback` | One accepted actual per observation (unique) |
| `ModelQualityPolicy` | Endpoint quality window / thresholds / auto_retrain |
| `ModelQualityRun` | Immutable evaluation lineage for a policy window |
| `RetrainTrigger` | `quality_degradation` provenance (`quality_run_id` unique) |

## Scheduler

`ScheduleTargetType.model_quality` reuses AutomationSchedule cron / timezone / run-now / retry / concurrency. Target config: `{ "quality_policy_id": <id> }`.

## Slice plan

1. **5-A Foundation** — current
2. **5-B Feedback Dataset Materialization**
3. **5-C Advanced Quality Policies**
4. **5-D UX / Final Hardening**

Phase 5.1 (incremental / continued training) remains out of scope for Phase 5-A.
