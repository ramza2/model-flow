# Phase 5.1 — Incremental / Continued Training

**Status:** current (Draft implementation — not complete on `main` until merge + post-merge CI PASS)

**Baseline:** `main@b7702144ffdabc94b02ccd323aa460de09e550fa` (Phase 5 complete; PR #62; CI #304)

## Semantic distinction

| Mode | Lineage field | Estimator | Preprocessing | Dataset |
| --- | --- | --- | --- | --- |
| **Retry** | `parent_job_id` (+ `retry_count`) | fresh | fresh | same config as failed/cancelled job |
| **Clone** | `parent_job_id` | fresh | fresh | configuration copy; editable |
| **Full Retrain** | `retrain_source_job_id` | **fresh** | **fresh** | any compatible DatasetVersion |
| **Continued Training** | `continued_from_job_id` | **existing fitted + `partial_fit`** | **frozen (transform only)** | newer version of the **same** Dataset |

Invariant:

```text
Full Retrain != Continued Training
```

Closed-loop quality degradation continues to trigger **full retraining** only. Phase 5.1 does not auto-select continued training.

## Capability model

`AlgorithmSpec` exposes:

- `continued_training_strategy`: `unsupported` | `partial_fit`
- `supports_continued_training`: derived boolean

Phase 5.1 first slice:

- `sgd_classifier` → `partial_fit` (classification, single-output)
- `sgd_regressor` → `partial_fit` (regression, single-output)
- all other catalog algorithms → `unsupported`

RandomForest / GradientBoosting warm-start is out of scope.

## API

```text
POST /projects/{project_id}/jobs/{source_job_id}/continue
```

Request:

```json
{
  "dataset_version_id": 12,
  "split_id": null,
  "name": "customer-sgd continued v2"
}
```

Job responses add (additive):

- `continued_from_job_id`
- `is_continued_training`
- `training_mode` (`fresh` | `retry` | `clone` | `full_retrain` | `continued`)

List filter: `continued_from_job_id`.

Existing `/retrain` semantics are unchanged.

## Compatibility gates

Source must be:

- same project, `succeeded`, with `model_uri` + `mlflow_run_id`
- algorithm supports continued training
- single-output
- immutable DatasetVersion lineage

Target DatasetVersion must be:

- same logical Dataset
- **newer** logical `version` (not DB id comparison)
- schema-compatible features/targets

Reject new classifier classes, multi-output, hyperparameter/preprocessing overrides, and different datasets.

## Runtime behavior

1. Load source sklearn `Pipeline` from MLflow (`preprocessing` + `estimator`)
2. Validate `partial_fit` on estimator
3. `preprocessing.transform(X_train)` only — never `fit` / `fit_transform`
4. `estimator.partial_fit(...)`
5. Fresh MLflow run + new immutable model artifact
6. Optional Register Model → **CANDIDATE** only

Update-batch semantics: the selected DatasetVersion training partition is the update batch. ModelFlow does **not** infer row-level delta between snapshots.

## UI

Job Detail:

- **Retrain** — fresh model and preprocessing from scratch
- **Continue training** — only when catalog capability allows; dialog filters to newer DatasetVersions

## Out of scope

- warm-start for tree ensembles
- closed-loop automatic continued training
- row-level delta / CDC / streaming online learning
- multi-output continued training
- new-class expansion / incremental OneHot vocabulary
- automatic PRODUCTION promotion or endpoint swap
