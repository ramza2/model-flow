from datetime import datetime, timezone

import pytest

from app.services.cron_schedule import (
    CronValidationError,
    TimezoneValidationError,
    advance_next_run,
    next_occurrence,
    validate_cron,
    validate_timezone,
)


def test_validate_cron_accepts_five_field_expression():
    assert validate_cron("0 9 * * *") == "0 9 * * *"


def test_validate_cron_rejects_invalid_expression():
    with pytest.raises(CronValidationError):
        validate_cron("not a cron")


def test_validate_timezone_accepts_utc_and_seoul():
    assert validate_timezone("UTC") == "UTC"
    assert validate_timezone("Asia/Seoul") == "Asia/Seoul"


def test_validate_timezone_rejects_unknown():
    with pytest.raises(TimezoneValidationError):
        validate_timezone("Not/AZone")


def test_next_occurrence_uses_timezone_local_time():
    after = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    nxt = next_occurrence("0 9 * * *", "Asia/Seoul", after_utc=after)
    local = nxt.astimezone(timezone.utc)
    assert local > after


def test_advance_next_run_dst_timezone():
    after = datetime(2026, 3, 7, 12, 0, tzinfo=timezone.utc)
    nxt = advance_next_run("0 9 * * *", "America/New_York", after_utc=after)
    assert nxt > after
