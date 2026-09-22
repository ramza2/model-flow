# Phase 5-A Verification — Closed-loop MLOps Foundation

Baseline: `main@364c0d846a8cbfe81a16cc0d0e16743d43c610f0`

## Provenance

- Phase 4 complete on `main` (PR #58 closeout at `364c0d8…`)
- Phase 5-A Draft implementation (not complete until merge + post-merge `main` CI PASS)

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

## Targeted tests

- `tests/test_model_quality_metrics.py`
- `tests/test_closed_loop_phase5a.py`
- Frontend Monitoring Production Quality unit coverage

## Full gate

Run `./scripts/verify.sh` on the Draft PR HEAD before merge.

## Acceptance reminder

Gate PASS after automatic registration does **not** change lifecycle away from `CANDIDATE`.
