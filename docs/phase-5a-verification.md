# Phase 5-A Verification — Closed-loop MLOps Foundation

Baseline: `main@364c0d846a8cbfe81a16cc0d0e16743d43c610f0`

## Provenance

- Phase 4 complete on `main` (PR #58 closeout at `364c0d8…`)
- Phase 5-A **complete** on `main` (PR #59 squash `1bb13bc2e527951e1a580787c35cd530fed45e7a`; post-merge CI #285 PASS)

## Delivered

- Alembic head `018_closed_loop_mlops`
- `PredictionObservation` + additive `prediction_ids` on JWT and Service API Key predict
- `GroundTruthFeedback` JWT + `/inference/endpoints/{id}/ground-truth`
- `ModelQualityPolicy` / `ModelQualityRun` APIs + worker evaluation
- Metrics: classification (`accuracy`, `precision_macro`, `recall_macro`, `f1_macro`), regression (`mae`, `rmse`, `r2`), multi-output regression aggregate + per-target
- Degradation Alert `model_quality_degradation`
- AutomationSchedule target `model_quality`
- Closed-loop full retrain decision (consecutive breach, cooldown, PRODUCTION lineage, newer DatasetVersion only)
- Automatic CANDIDATE registration + `retraining_candidate_ready` Alert
- Monitoring Production Quality UI + Registry closed-loop lineage
- No automatic approval / PRODUCTION / endpoint swap

## Review blocker fixes (post `ec8ff81`)

- Flush quality run before closed-loop consecutive-breach SELECT (`autoflush=False` safe)
- Closed-loop candidate `ModelVersion.name` matches source PRODUCTION logical name; MLflow name stays `project-{id}-{logical}`
- Cooldown + closed-loop state scoped via `RetrainTrigger` ⋈ `ModelQualityRun.endpoint_id`
- Policy `primary_metric` allowlist + direction-aware threshold ordering + non-finite reject (create/PATCH)
- Scheduled `ModelQualityRun.schedule_run_id` provenance from parent `AutomationScheduleRun`
- Candidate registration failure keeps `TrainingJob.status == succeeded` (no duplicate failure alerts)

## Full gate

Verified on merge HEAD `1bb13bc2e527951e1a580787c35cd530fed45e7a` / CI #285 PASS:

- Alembic head: `018_closed_loop_mlops`
- Result: **PASS**

## Acceptance reminder

Gate PASS after automatic registration does **not** change lifecycle away from `CANDIDATE`.
Phase 5-A is complete on `main`.
