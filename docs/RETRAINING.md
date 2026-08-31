# Retraining (Phase 1.1)

Phase 1.1 adds **full retraining**: create a new training job that copies the configuration from a succeeded source job and trains a fresh estimator on a selected dataset version.

## Semantics

**Retraining = fresh full training using configuration inherited from a prior Training Job.**

The worker always builds a new sklearn pipeline/estimator and calls `fit()` from scratch. It does **not**:

- load a prior model artifact
- call `partial_fit` or `warm_start`
- resume an existing MLflow run

**Incremental / Continued Training is not part of Phase 1.1.** That will be a separate phase.

## API

```
POST /api/v1/projects/{project_id}/jobs/{job_id}/retrain
```

Request body:

```json
{
  "dataset_version_id": 12,
  "split_id": null,
  "name": "sales-rf-retrain-v2",
  "description": ""
}
```

- Source job must be `succeeded` and in the same project.
- `dataset_version_id` must belong to the **same logical dataset** as the source job.
- `split_id` is optional. When omitted, the new job uses runtime split with the source job's train/val/test ratios and `random_seed`. When provided, the split must belong to the selected dataset version.
- The source job's saved split is **never** copied automatically to a new dataset version.

Response: the newly created `TrainingJob` (status `pending`).

List retrain children:

```
GET /api/v1/projects/{project_id}/jobs?retrain_source_job_id={source_job_id}
```

## Lineage fields

| Field | Meaning |
|-------|---------|
| `parent_job_id` | Immediate predecessor for **retry** or **clone** flows |
| `retrain_source_job_id` | Source job for **full retrain** jobs |
| `is_retrain` | `true` when `retrain_source_job_id` is set |

Retry and retrain lineage are intentionally separate so retry chains are not confused with retrain chains.

## MLflow

Retrained jobs log:

- param `retrain_source_job_id`
- tag `modelflow.retrain_source_job_id`
- param `dataset_version_id`

Each retrain produces a new MLflow run and model artifact.

## UI

Succeeded training jobs expose a **Retrain** action that opens a dialog to pick a dataset version (same dataset), optional split, and new job name. Retrained job detail shows **Retrained from Job #N** with a link to the source.
