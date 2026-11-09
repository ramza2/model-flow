"""Persistent production automatic-backup cleanup policy.

The host Cron runner obtains this policy from the running backend container,
but the runner alone owns backup filesystem access. The API cannot delete files.
"""

from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.db.models import SystemSetting

DEFAULT_DAYS = 14
MIN_DAYS = 7
MAX_DAYS = 365
MIN_VERIFIED_KEEP = 2
ENABLED_KEY = "backup_auto_retention_enabled"
DAYS_KEY = "backup_auto_retention_days"


def read_policy(db: Session) -> dict[str, bool | int]:
    """Return validated settings or safe defaults for absent (not invalid) rows."""
    raw = {}
    for key in (ENABLED_KEY, DAYS_KEY):
        row = db.get(SystemSetting, key)
        if row is not None:
            raw[key] = json.loads(row.value_json)

    enabled = raw.get(ENABLED_KEY, True)
    days = raw.get(DAYS_KEY, DEFAULT_DAYS)
    if type(enabled) is not bool or type(days) is not int or not MIN_DAYS <= days <= MAX_DAYS:
        raise ValueError("Invalid stored automatic-backup retention policy")
    return {"enabled": enabled, "days": days, "minimum_verified_keep": MIN_VERIFIED_KEEP}


def main() -> int:
    """Machine-readable policy for the host-side Cron runner; fail closed on errors."""
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        policy = read_policy(db)
    print(f"enabled={int(policy['enabled'])} days={policy['days']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
