"""Service API Key management (create / list / revoke).

Credentials for external inference. User JWT + DEPLOY_WRITE required.
Plaintext keys are returned only from create responses.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, friendly
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import Endpoint, ServiceApiKey
from app.db.session import get_db
from app.schemas.v1 import ServiceApiKeyCreate
from app.services import service_api_keys as key_service

router = APIRouter(tags=["service-api-keys"])


def _service_api_key_out(
    row: ServiceApiKey, *, plaintext: str | None = None
) -> dict:
    payload = {
        "id": row.id,
        "project_id": row.project_id,
        "endpoint_id": row.endpoint_id,
        "name": row.name,
        "key_prefix": row.key_prefix,
        "is_active": row.is_active,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "last_used_at": row.last_used_at,
        "revoked_at": row.revoked_at,
    }
    if plaintext is not None:
        payload["key"] = plaintext
    return payload


@router.post("/projects/{project_id}/service-api-keys", status_code=201)
def create_service_api_key(
    project_id: int,
    body: ServiceApiKeyCreate,
    access=Depends(require_project_perm(Permission.DEPLOY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _project, _role = access
    endpoint_id = body.endpoint_id
    if endpoint_id is not None:
        endpoint = db.get(Endpoint, endpoint_id)
        if not endpoint or endpoint.project_id != project_id:
            raise friendly(
                404,
                f"Endpoint {endpoint_id} was not found in this project.",
            )

    expires_at = key_service.as_utc(body.expires_at)
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise friendly(
            422,
            "expires_at must be in the future.",
            "Omit expires_at for a non-expiring key.",
        )

    plaintext, prefix, key_hash = key_service.generate_service_api_key(db)
    row = ServiceApiKey(
        project_id=project_id,
        endpoint_id=endpoint_id,
        name=body.name,
        key_prefix=prefix,
        key_hash=key_hash,
        is_active=True,
        created_by=auth.user.id,
        expires_at=expires_at,
    )
    db.add(row)
    db.flush()
    audit_event(
        db,
        auth,
        "service_api_key.create",
        "service_api_key",
        row.id,
        after={
            "id": row.id,
            "name": row.name,
            "key_prefix": row.key_prefix,
            "project_id": row.project_id,
            "endpoint_id": row.endpoint_id,
            "expires_at": expires_at.isoformat() if expires_at else None,
        },
    )
    db.commit()
    db.refresh(row)
    return _service_api_key_out(row, plaintext=plaintext)


@router.get("/projects/{project_id}/service-api-keys")
def list_service_api_keys(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DEPLOY_WRITE)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(ServiceApiKey)
        .where(ServiceApiKey.project_id == project_id)
        .order_by(ServiceApiKey.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [_service_api_key_out(row) for row in rows]


@router.post("/projects/{project_id}/service-api-keys/{key_id}/revoke")
def revoke_service_api_key(
    project_id: int,
    key_id: int,
    access=Depends(require_project_perm(Permission.DEPLOY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _project, _role = access
    row = db.get(ServiceApiKey, key_id)
    if not row or row.project_id != project_id:
        raise friendly(
            404,
            f"Service API key {key_id} was not found in this project.",
        )
    already_revoked = (not row.is_active) and row.revoked_at is not None
    if not already_revoked:
        now = datetime.now(timezone.utc)
        row.is_active = False
        row.revoked_at = now
        db.add(row)
        audit_event(
            db,
            auth,
            "service_api_key.revoke",
            "service_api_key",
            row.id,
            after={
                "id": row.id,
                "name": row.name,
                "key_prefix": row.key_prefix,
                "project_id": row.project_id,
                "endpoint_id": row.endpoint_id,
                "revoked_at": now.isoformat(),
            },
        )
        db.commit()
        db.refresh(row)
    return _service_api_key_out(row)
