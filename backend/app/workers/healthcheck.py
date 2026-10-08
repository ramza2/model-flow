"""Exit 0 when this container's worker heartbeat is fresh; otherwise exit 1."""

from __future__ import annotations

import sys
from datetime import datetime, timezone

from app.core.config import settings
from app.db.models import WorkerHeartbeat
from app.db.session import SessionLocal
from app.workers.identity import resolve_worker_id


def main() -> int:
    worker_id = resolve_worker_id()
    db = SessionLocal()
    try:
        row = db.get(WorkerHeartbeat, worker_id)
        if row is None or row.last_seen_at is None:
            print(f"no heartbeat worker_id={worker_id}", file=sys.stderr)
            return 1
        seen = row.last_seen_at
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - seen).total_seconds()
        if age > settings.worker_heartbeat_max_age_seconds:
            print(
                f"stale heartbeat worker_id={worker_id} age={age:.1f}s",
                file=sys.stderr,
            )
            return 1
        print(f"ok worker_id={worker_id} age={age:.1f}s")
        return 0
    except Exception as exc:
        print(f"health error: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
