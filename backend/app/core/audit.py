from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.core.security import mask_secrets
from app.db.models import AuditLog


def write_audit(
    db: Session,
    *,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    user_id: int | None = None,
    user_email: str | None = None,
    success: bool = True,
    ip_address: str | None = None,
    request_id: str | None = None,
    before: Any = None,
    after: Any = None,
    failure_reason: str | None = None,
) -> AuditLog:
    row = AuditLog(
        user_id=user_id,
        user_email=user_email,
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        success=success,
        ip_address=ip_address,
        request_id=request_id,
        before_summary=(
            json.dumps(mask_secrets(before), default=str)
            if before is not None
            else None
        ),
        after_summary=(
            json.dumps(mask_secrets(after), default=str) if after is not None else None
        ),
        failure_reason=failure_reason,
    )
    db.add(row)
    db.flush()
    return row
