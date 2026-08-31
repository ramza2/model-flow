"""Pure cron/timezone helpers for automation schedules."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter


class CronValidationError(ValueError):
    pass


class TimezoneValidationError(ValueError):
    pass


def validate_cron(expression: str) -> str:
    value = expression.strip()
    if not value:
        raise CronValidationError("Cron expression is required.")
    parts = value.split()
    if len(parts) != 5:
        raise CronValidationError("Cron expression must use five fields (minute hour day month weekday).")
    if not croniter.is_valid(value):
        raise CronValidationError("Cron expression is invalid.")
    return value


def validate_timezone(name: str) -> str:
    value = name.strip()
    if not value:
        raise TimezoneValidationError("Timezone is required.")
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise TimezoneValidationError(f"Unknown timezone '{value}'.") from exc
    return value


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def next_occurrence(
    cron_expression: str,
    timezone_name: str,
    *,
    after_utc: datetime,
) -> datetime:
    """Return the next cron fire time as UTC, computed in the schedule timezone."""

    cron = validate_cron(cron_expression)
    tz = ZoneInfo(validate_timezone(timezone_name))
    after = _as_utc(after_utc)
    local_after = after.astimezone(tz)
    iterator = croniter(cron, local_after)
    next_local = iterator.get_next(datetime)
    if next_local.tzinfo is None:
        next_local = next_local.replace(tzinfo=tz)
    return next_local.astimezone(timezone.utc)


def advance_next_run(
    cron_expression: str,
    timezone_name: str,
    *,
    after_utc: datetime,
) -> datetime:
    """Compute the next cron occurrence strictly after ``after_utc`` (missed-run coalesce)."""

    return next_occurrence(cron_expression, timezone_name, after_utc=after_utc)


def is_schedule_due(next_run_at: datetime | None, *, now_utc: datetime) -> bool:
    if next_run_at is None:
        return False
    return _as_utc(next_run_at) <= _as_utc(now_utc)
