# Post-GA daily backup — Cron deployment (ModelFlow)

## Operational status and configurable retention (2026-11-09)

The existing production deployment was verified on 2026-11-09 KST:
`cron` is active/enabled; the 03:00 daily entry includes `--apply-retention`;
the 04:00 backup-health notification check is installed; the most recent
backup and health check succeeded. A test email was received by the operator.
This describes the observed ModelFlow production host, not a requirement for
other environments. The sections below also retain the original deployment
and activation instructions for reference.

The post-GA administration enhancement adds **시스템 관리 → 환경 설정 → 검증 완료
백업 보존 정책** (system-admin access only):

- Enable/disable cleanup (default: enabled) and set a retention age of
  **7–365 days** (default: **14**). Changes are stored in `system_settings` and
  audited. No Alembic migration or backup-file manipulation occurs in the API.
- The daily host Cron command remains unchanged. After a successful new
  backup is verified, it reads the current policy from the running production
  backend container using `python -m app.services.backup_retention`.
- **`--apply-retention` is still an independent host-operator prerequisite.**
  The UI does not edit Cron or grant cleanup permission to unscheduled jobs.
  With the switch off, expired backups are reported but not removed.
- Only verified, exact-name, non-symlink `backups/auto/auto-*` directories
  older than the configured age are eligible. The latest **two** verified
  automatic snapshots remain protected, as do failed/unverified runs and all
  manual/predeployment backups.
- Missing backend container, wrong Compose identity, unparseable policy,
  invalid stored values or DB errors **skip cleanup** without causing the
  successful fresh backup to be marked failed. The private backup log contains
  `BACKUP_DAILY_RETENTION_SKIPPED=...`; investigate this signal if persistent.
- Saving the policy does **not** delete anything immediately. It takes effect
  at the next successful scheduled backup. Lowering the age or re-enabling
  cleanup prompts the user to confirm potential future deletion.

Verification before deployment: `bash scripts/test-daily-backup.sh`, targeted
backend API/permission tests, frontend admin tests and the full `verify.sh`
gate in a Docker-capable environment. Deploy the backend **before** the frontend
so the UI can read `/api/v1/admin/backup-retention`. Retain existing Cron entries.

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


## Post-GA backup health alerts (operator configuration needed)

The new `scripts/ops/check-backup-health.py` performs a read-only check of
the 03:00 KST backup. Run it at **04:00 KST**: the previous hour must contain
a fresh SUCCESS status and matching verified.ok marker. A failed, interrupted,
or missed run returns a nonzero status. The checker sends **one failure-only
SMTP email** when invoked with `--notify`. A normal backup does not send mail.

The SMTP credential file must be **outside Git**:
`/home/openlink/.config/model-flow/backup-alert.json`. Require user
`openlink` ownership, file mode `0600`, and directory mode `0700`.
The supported JSON keys are host, port, transport (ssl/starttls), sender,
recipient, username, and password. The file is never printed or committed.
Use an approved mail relay and operator-owned recipient; do not share
credentials in chat.

Non-secret JSON example (replace on the host only):

```json
{
  "host": "smtp.example.invalid",
  "port": 465,
  "transport": "ssl",
  "sender": "backup-alerts@example.invalid",
  "recipient": "operator@example.invalid",
  "username": "smtp-user",
  "password": "REPLACE_ON_HOST_ONLY"
}
```

After creating the private configuration on the host, run:

```bash
python3 scripts/ops/check-backup-health.py --check
python3 scripts/ops/check-backup-health.py --test-email
```

The explicit `--test-email` sends one harmless message with a TEST subject;
confirm receipt in the intended mailbox. The `--check` command never
sends mail. Missing/mis-permissioned credentials or SMTP errors remain
visible as BACKUP_ALERT_CONFIG_ERROR / BACKUP_ALERT_DELIVERY_FAILED without
leaking credential values.

After **separate operator approval**, add exactly one monitoring Cron entry
to the existing openlink crontab, preserving all other entries:

```cron
0 4 * * * /usr/bin/python3 /home/openlink/model-flow/scripts/ops/check-backup-health.py --notify >> /home/openlink/model-flow/backups/auto/health-alert.log 2>&1
```

Do not schedule `--test-email`. The health checker does not restart or
modify production services. Real SMTP delivery has not been verified merely
by passing offline CI.

## Retention hardening and activation boundary

The existing 03:00 production Cron entry continues with `--run` only.
The new retention guard preserves the **two newest verified auto backups**
regardless of age. The 14-day expiration, verified marker, exact directory
name, and symlink exclusions remain in place. Historic/manual snapshots
outside backups/auto are never selected.

Before enabling `--apply-retention`, review the actual backup inventory
and RETENTION_DRY_RUN_CANDIDATE lines in the private daily backup.log.
The PR does not change the production schedule or authorize deletion.
Continue to plan periodic isolated restoration and off-host copies.
