from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, friendly, user_out
from app.core.deps import AuthContext, require_system_admin
from app.core.security import hash_password
from app.db.models import User
from app.db.session import get_db
from app.schemas.v1 import UserCreate, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def _get_user(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if not user or user.deleted_at is not None:
        raise friendly(404, f"User {user_id} was not found.")
    return user


@router.get("")
def list_users(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(User)
        .where(User.deleted_at.is_(None))
        .order_by(User.id)
        .offset(skip)
        .limit(limit)
    ).all()
    total = (
        db.scalar(
            select(func.count()).select_from(User).where(User.deleted_at.is_(None))
        )
        or 0
    )
    return {
        "items": [user_out(row) for row in rows],
        "skip": skip,
        "limit": limit,
        "total": total,
    }


@router.post("", status_code=201)
def create_user(
    body: UserCreate,
    auth: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    email = str(body.email).strip().lower()
    if db.scalar(select(User.id).where(func.lower(User.email) == email)):
        raise friendly(409, f"A user with email '{email}' already exists.")
    user = User(
        email=email,
        full_name=body.full_name.strip(),
        password_hash=hash_password(body.password),
        is_active=True,
        is_system_admin=body.is_system_admin,
    )
    db.add(user)
    db.flush()
    audit_event(db, auth, "user.create", "user", user.id, after=user_out(user))
    db.commit()
    db.refresh(user)
    return user_out(user)


@router.patch("/{user_id}")
def update_user(
    user_id: int,
    body: UserUpdate,
    auth: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    user = _get_user(db, user_id)
    before = user_out(user)
    if user.id == auth.user.id and body.is_active is False:
        raise friendly(400, "You cannot deactivate your own account.")
    if user.id == auth.user.id and body.is_system_admin is False:
        raise friendly(400, "You cannot remove your own system administrator role.")
    for field in body.model_fields_set:
        value = getattr(body, field)
        if value is not None:
            setattr(user, field, value.strip() if field == "full_name" else value)
    audit_event(
        db, auth, "user.update", "user", user.id, before=before, after=user_out(user)
    )
    db.commit()
    db.refresh(user)
    return user_out(user)


@router.post("/{user_id}/deactivate")
def deactivate_user(
    user_id: int,
    auth: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    user = _get_user(db, user_id)
    if user.id == auth.user.id:
        raise friendly(400, "You cannot deactivate your own account.")
    user.is_active = False
    user.token_version += 1
    audit_event(db, auth, "user.deactivate", "user", user.id)
    db.commit()
    return user_out(user)


@router.post("/{user_id}/activate")
def activate_user(
    user_id: int,
    auth: AuthContext = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    user = _get_user(db, user_id)
    user.is_active = True
    user.failed_login_count = 0
    user.locked_until = None
    audit_event(db, auth, "user.activate", "user", user.id)
    db.commit()
    return user_out(user)
