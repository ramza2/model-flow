# Multi-output Regression (Phase 1.2)

Phase 1.2 adds **multi-output regression**: one regression model predicts multiple numeric targets from the same feature set.

## Semantics

- **Multi-output regression** = one model predicts multiple numeric targets.
- `target_column` remains the backward-compatible first-target alias.
- `target_columns` is the canonical multi-output representation.
- **Multi-output classification** and **multi-label classification** are not supported.
- **Incremental learning** (`partial_fit`, `warm_start`, model reload) is not part of Phase 1.2.

## API

`JobCreate` accepts either legacy or canonical payloads:

```json
{ "target_column": "price" }
```

```json
{ "target_columns": ["price", "demand"] }
```

When both are provided, `target_column` must equal `target_columns[0]`.

Responses always include both `target_column` and `target_columns`.

## Problem type

- Single target: existing auto/classification/regression behavior.
- Multi-output (`target_columns` length > 1):
  - `classification` → rejected (422)
  - `regression` → allowed for numeric targets (boolean targets rejected)
  - `auto` → each target is evaluated with the same `detect_problem_type()` rules used for single-target jobs; all targets must resolve to regression or the request is rejected as unsupported multi-output classification

## Algorithms

| Algorithm | Strategy |
|-----------|----------|
| Ridge | native multi-output |
| Random forest regressor | native multi-output |
| Gradient boosting regressor | `MultiOutputRegressor` wrapper |

Single-target jobs keep the original estimator structure.

## Metrics

Aggregate keys (`rmse`, `mae`, `r2`, `val_*`, `test_*`) remain unchanged and use the arithmetic mean across targets for multi-output jobs.

Per-target metrics are logged as flat MLflow keys such as `val_target_0_rmse` and recorded in `target_metrics.json`.

## Online inference

Single-target response (unchanged):

```json
{ "predictions": [12.3, 14.2] }
```

Multi-output response:

```json
{
  "predictions": [
    { "price": 12.3, "demand": 5.7 },
    { "price": 14.2, "demand": 6.1 }
  ]
}
```

## Batch inference

- Single-target: `prediction`
- Multi-output: `prediction_<target>` per target column

## Retrain / clone / retry

Effective target lists are copied from the source job. Retrain validates that every target exists on the selected dataset version.
