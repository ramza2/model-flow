# Post-GA daily backup — Cron deployment (ModelFlow)

## Scope and deployment status

The runner `scripts/ops/backup-daily.sh` reuses the existing `scripts/backup.sh`.
It creates a PostgreSQL (`modelflow`, `mlflow`) + MinIO (`datasets`, `mlflow`,
`batch-results`, `artifacts`) backup without restarting services.

**This PR does not install Cron, start a backup on production, or enable deletions.**
The following steps require a separate approved production change.

The observed production host has an active/enabled Cron service and KST time.
Its user systemd manager has `Linger=no`, so Cron is preferred to a user timer.

## Safety and validation

- Uses `.env.deploy` with both production Compose files and the **fixed**
  `model-flow` project name. Aborts if the env file defines conflicting project,
  Compose, or backup-directory overrides.
- Checks PostgreSQL and MinIO container IDs, Compose project/service labels,
  and health (`healthy`) before any backup operation.
- Uses a non-blocking `flock` lock to prevent overlapping daily runs.
- Writes under `backups/auto/auto-YYYYMMDDTHHMMSSZ-PID/`. Each run has a
  private `backup.log`, and `backups/auto/last-run.status` records success or
  failure. `umask 077` protects the logs and backup files.
- Requires the existing backup script to complete successfully, PostgreSQL
  dumps to be non-empty/readable with `pg_restore --file=/dev/null`, metadata
  to exist, and all four MinIO bucket directories to be present. Only then is
  `verified.ok` written. MinIO objects are **not** individually checksummed;
  recurring isolated restore tests remain necessary.
- The backup is not an atomic snapshot across PostgreSQL and MinIO. For
  workloads requiring strong point-in-time consistency, plan coordinated
  snapshots separately.

## Commands (operator review required)

From `/home/openlink/model-flow`, after the PR is merged and local `main`
is updated:

```bash
# Read-only preflight (no backup directories or containers created).
bash scripts/ops/backup-daily.sh --check

# One manually approved backup; no retention deletions.
bash scripts/ops/backup-daily.sh --run

# Inspect status without printing backup logs/credentials.
awk -F= '/^(status|finished_at|exit_code)=/ { print }' backups/auto/last-run.status
```

After verifying a manual run, an operator may **separately approve** adding
the following entry to the `openlink` user's crontab. The server timezone was
confirmed as KST, so this means **03:00 KST daily**:

```cron
0 3 * * * /usr/bin/bash /home/openlink/model-flow/scripts/ops/backup-daily.sh --run
```

Before installation, check existing crontab entries and avoid duplicate
schedules. Do not replace unrelated Cron entries. No root Cron or systemd
timer is required.

## 14-day retention: deliberately not active yet

Without extra arguments, `--run` **only reports** expired backup candidates
(`RETENTION_DRY_RUN_CANDIDATE`) in its private run log.

Once the deletion behavior has been reviewed against a real backup inventory,
the operator can explicitly approve changing the Cron entry to:

```cron
0 3 * * * /usr/bin/bash /home/openlink/model-flow/scripts/ops/backup-daily.sh --run --apply-retention
```

Only after a **successful** new backup does this option remove older folders
that satisfy **all** the following:

1. Direct child of `backups/auto/`, not a symlink.
2. Exact `auto-YYYYMMDDTHHMMSSZ-PID` directory name.
3. Regular `verified.ok` marker older than 14 × 24 hours.

Failed/unverified runs, historic backups outside `backups/auto`, and
`predeploy-*` directories are never removed by this retention loop.

## Verification and follow-up

Offline safety regression:

```bash
bash -n scripts/ops/backup-daily.sh
bash scripts/test-daily-backup.sh
```

Required after merging: manual backup preflight, first backup and marker
verification, then separately approved Cron installation and scheduling
verification. Monitoring for stale backups, worker heartbeat, disk usage,
error notifications, and off-host copies is a separate Issue #140 follow-up.
Backups remaining on this server alone do **not** protect against host loss.
