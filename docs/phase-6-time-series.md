# Phase 6 — Time-series / Multi-step

Phase 6 adds time-aware training capabilities on top of ModelFlow’s existing tabular training contract. Work is sliced so forecasting models are not introduced before the split semantics that prevent leakage are solid.

## Slice boundary

| Slice | Scope | Status |
|-------|--------|--------|
| **6-A** | Time-aware training foundation — chronological train/validation/test splits, persisted `split_strategy` / `time_column`, API/UX/MLflow/lineage | **current** (Draft until merge + post-merge `main` CI PASS) |
| **6-B** | Lag / rolling-window feature preparation | future |
| **6-C** | Forecasting / multi-step training (horizons, supported forecasters) | future |
| **6-D** | Pipeline / UX / final hardening | future |

```text
6-A Time-aware Training Foundation
    ↓
6-B Lag / Rolling Feature Preparation
    ↓
6-C Forecasting / Multi-step Training
    ↓
6-D Pipeline / UX / Final Hardening
```

**6-A = time-aware foundation only.**  
**6-B = lag / rolling.**  
**6-C = forecasting + multi-step.**  
**6-D = integration / hardening.**

Unpivot already exists from Phase 2-F1; Phase 6 must not re-implement it.

## Phase 6-A goals

Make the following a first-class persisted training contract:

```text
Random split
!=
Time-ordered split
```

Implemented in 6-A:

- `DatasetSplit.split_strategy` / `time_column`
- `TrainingJob.split_strategy` / `time_column`
- chronological contiguous partitions (earliest → train, middle → validation, latest → test)
- saved DatasetSplit time mode + direct TrainingJob time mode
- shared time-order helpers (single semantics for API + runner)
- Job Create / Dataset split UX
- MLflow reproducibility metadata
- retry / clone / full retrain / continued-training lineage compatibility
- closed-loop remains **full retrain** only; when the source used a time split, that config is reproduced

Explicitly out of scope for 6-A:

- lag / rolling / lead / target-shift transforms
- forecast horizon, ARIMA/Prophet, LSTM/Transformer, multi-step prediction
- panel / grouped / entity-aware splits
- walk-forward or other CV schemes
- calendar feature generation
- closed-loop forecast-specific policies

## Leakage prevention principles

1. **Time-ordered partitions never shuffle.** Classification does not stratify under time strategy.
2. **Preprocessing fits on the train partition only.** Validation/test rows must not contribute to imputer statistics, encoders, or scalers.
3. **`time_column` is ordering metadata in 6-A**, not a model feature. It must not be a target or feature column; calendar/time feature prep is later-phase work.
4. **Fail closed on bad timestamps.** Null, unparseable, or non-finite numeric time values reject the request; rows are never silently dropped.
5. **Pin DatasetVersion.** Splits and jobs use the selected immutable version; never “latest” by default.
6. **Immutable split artifacts.** Existing train/validation/test objects and hashes are not mutated after create.
7. **Shared helpers only for time semantics.** Random saved-split (`sample` + contiguous cuts) and random direct (`sklearn.train_test_split` + optional stratification) paths remain as-is for regression compatibility.

## Time split semantics (6-A)

- Supported time values: datetime dtype, parseable date/time strings, numeric time/index.
- Sort ascending (earliest → latest), stable (`mergesort`); duplicate timestamps keep original relative order.
- Group/entity-aware duplicate-time semantics are **future scope** (not 6-A).
- Positive ratio that would yield zero rows → reject (`Not enough rows for the requested time-ordered split ratios.`).
- `random_seed` is retained for estimator `random_state` reproducibility; it must not affect time ordering.

## Compatibility

- Omitting `split_strategy` / `time_column` keeps **random** behavior identical to pre–6-A clients.
- Random `config_signature` format is unchanged when strategy is random (default).
- Closed-loop automation continues to enqueue **full retrain** only (never auto-continued training).

## Related docs

- [`ENHANCEMENT_ROADMAP.md`](./ENHANCEMENT_ROADMAP.md)
- [`PROGRESS.md`](./PROGRESS.md)
- [`phase-5.1-continued-training.md`](./phase-5.1-continued-training.md)
- [`phase-5-closed-loop-mlops.md`](./phase-5-closed-loop-mlops.md)
