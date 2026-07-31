from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, friendly
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.session import get_db
from app.schemas.v1 import ModelGatePolicyUpdate
from app.services import gate_policy as gate_policy_service

router = APIRouter(tags=["model-gate-policies"])


@router.get("/projects/{project_id}/gate-policies")
def list_policies(
    project_id: int,
    _=Depends(require_project_perm(Permission.REGISTRY_READ)),
    db: Session = Depends(get_db),
):
    gate_policy_service.ensure_default_gate_policy(db, project_id)
    db.commit()
    return [
        gate_policy_service.policy_out(row)
        for row in gate_policy_service.list_gate_policies(db, project_id)
    ]


@router.get("/projects/{project_id}/gate-policies/active")
def get_active_policy(
    project_id: int,
    _=Depends(require_project_perm(Permission.REGISTRY_READ)),
    db: Session = Depends(get_db),
):
    policy = gate_policy_service.ensure_default_gate_policy(db, project_id)
    db.commit()
    return gate_policy_service.policy_out(policy)


@router.patch("/projects/{project_id}/gate-policies/active")
def update_active_policy(
    project_id: int,
    body: ModelGatePolicyUpdate,
    access=Depends(require_project_perm(Permission.PROJECT_ADMIN)),
    db: Session = Depends(get_db),
):
    """Only PROJECT_ADMIN / SYSTEM_ADMIN may change gate criteria."""
    auth, _, _ = access
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise friendly(400, "No gate policy fields were provided.")
    try:
        policy = gate_policy_service.update_active_gate_policy(
            db, project_id, updates, actor_id=auth.user.id
        )
    except ValueError as exc:
        raise friendly(400, str(exc)) from exc
    audit_event(db, auth, "gate_policy.update", "model_gate_policy", policy.id)
    db.commit()
    db.refresh(policy)
    return gate_policy_service.policy_out(policy)
