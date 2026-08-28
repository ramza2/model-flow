# Scheduling and automation (Phase 1)

ModelFlow Phase 1 scheduling is a **DB-backed scheduler** executed by the existing worker container. No Celery, Redis, or external cron daemon is required.

## Architecture

```text
AutomationSchedule (cron + timezone + target config)
        │
        ▼
Worker scheduler tick (PostgreSQL row locks)
        │
        ├── DataImportJob
        ├── BatchInferenceJob
        └── PipelineRun
        │
        ▼
Existing worker processors (unchanged execution path)
```

The scheduler **only creates child job/run records**. Import, batch, and pipeline execution remain in the current worker handlers.

## Cron and timezone

- Standard **5-field Unix cron** (`minute hour day month weekday`)
- Timezone: **IANA names** (`Asia/Seoul`, `UTC`, …) using `zoneinfo`
- Stored timestamps (`next_run_at`, `scheduled_for`, …) are **UTC timezone-aware**
- Cron math runs in the schedule timezone, then converts to UTC

## Missed runs (misfire policy)

**Coalesce:** if the worker was down and `next_run_at` is in the past, the scheduler creates **at most one** due occurrence, then advances `next_run_at` to the next future cron time. Past ticks are **not replayed**.

## Concurrency

| Policy | Behavior |
|--------|----------|
| `skip` | When `max_concurrent_runs` active runs exist, new occurrences are recorded as `skipped` |
| `queue` | Occurrences stay `pending` until a slot is available |

`max_concurrent_runs` defaults to `1` (range 1–10).

## Retry

- `max_retries` (0 = no retry) and `retry_delay_seconds`
- On child job **failed** terminal status, a new `AutomationScheduleRun` is created with the same `scheduled_for` and `attempt + 1` after the delay
- Retries do **not** affect the next cron `next_run_at`
- Failed child records are never modified; each retry creates a new child job/run

## Disable / enable

- **Disable:** stops new cron occurrences; pending (undispatched) runs → `skipped`; dispatched/running children continue
- **Enable:** recomputes `next_run_at` from now (no backlog)

## API (project-scoped)

| Method | Path |
|--------|------|
| GET | `/projects/{project_id}/schedules` |
| POST | `/projects/{project_id}/schedules` |
| GET | `/projects/{project_id}/schedules/{schedule_id}` |
| PATCH | `/projects/{project_id}/schedules/{schedule_id}` |
| DELETE | `/projects/{project_id}/schedules/{schedule_id}` |
| POST | `/projects/{project_id}/schedules/{schedule_id}/enable` |
| POST | `/projects/{project_id}/schedules/{schedule_id}/disable` |
| POST | `/projects/{project_id}/schedules/{schedule_id}/run-now` |
| GET | `/projects/{project_id}/schedules/{schedule_id}/runs` |
| GET | `/projects/{project_id}/schedule-runs/{run_id}` |

**RBAC:** `schedule:read` (VIEWER+), `schedule:write` (ML_ENGINEER+). Creating schedules also requires the underlying target permission (`DATA_WRITE`, `DEPLOY_WRITE`, or `PIPELINE_WRITE`).

**Delete:** hard delete only when no run history exists; otherwise `409` (disable instead).

## UI

Project navigation → **Schedules** (`/projects/:projectId/schedules`)

Supports list, create/edit, enable/disable, run now, and per-schedule run history with links to child resources.

## Examples

**Daily import (02:00 Asia/Seoul)**

```text
Cron: 0 2 * * *
Timezone: Asia/Seoul
Target: data_import → PostgreSQL source → dataset (new version each run)
```

**Daily batch on latest dataset version (03:00 Asia/Seoul)**

```text
Cron: 0 3 * * *
Target: batch_inference → dataset latest version → production endpoint
```

**Weekly pipeline (Monday 09:00)**

```text
Cron: 0 9 * * 1
Target: pipeline_run → pinned published pipeline version
```
