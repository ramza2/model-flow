from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.v1.common import (
    audit_event,
    friendly,
    membership_out,
    project_out,
)
from app.core.deps import AuthContext, get_auth, require_project_perm
from app.core.rbac import Permission
from app.db.models import Project, ProjectMembership, ProjectRole, User
from app.db.session import get_db
from app.schemas.v1 import MemberCreate, ProjectCreate, ProjectUpdate
from app.services import mlflow_service

router = APIRouter(tags=["projects"])


@router.get("/projects")
def list_projects(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    if auth.is_system_admin:
        rows = db.scalars(
            select(Project)
            .where(Project.deleted_at.is_(None))
            .order_by(Project.id.desc())
            .offset(skip)
            .limit(limit)
        ).all()
        return [project_out(row, ProjectRole.PROJECT_ADMIN) for row in rows]
    pairs = db.execute(
        select(Project, ProjectMembership.role)
        .join(ProjectMembership, ProjectMembership.project_id == Project.id)
        .where(
            ProjectMembership.user_id == auth.user.id,
            Project.deleted_at.is_(None),
        )
        .order_by(Project.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [project_out(project, role) for project, role in pairs]


@router.post("/projects", status_code=201)
def create_project(
    body: ProjectCreate,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if db.scalar(select(Project.id).where(func.lower(Project.name) == name.lower())):
        raise friendly(
            409, f"A project named '{name}' already exists.", "Choose a unique name."
        )
    project = Project(
        name=name,
        description=body.description,
        created_by=auth.user.id,
        is_active=True,
    )
    db.add(project)
    db.flush()
    membership = ProjectMembership(
        project_id=project.id,
        user_id=auth.user.id,
        role=ProjectRole.PROJECT_ADMIN,
    )
    db.add(membership)
    try:
        mlflow_service.ensure_experiment(f"project-{project.id}")
    except Exception as exc:
        db.rollback()
        raise friendly(
            503,
            "The project MLflow experiment could not be created.",
            "Check MLflow availability and try again.",
        ) from exc
    audit_event(
        db, auth, "project.create", "project", project.id, after=project_out(project)
    )
    db.commit()
    db.refresh(project)
    return project_out(project, ProjectRole.PROJECT_ADMIN)


@router.get("/projects/{project_id}")
def get_project(
    access=Depends(require_project_perm(Permission.PROJECT_READ)),
):
    _, project, role = access
    return project_out(project, role)


@router.patch("/projects/{project_id}")
def update_project(
    project_id: int,
    body: ProjectUpdate,
    access=Depends(require_project_perm(Permission.PROJECT_ADMIN)),
    db: Session = Depends(get_db),
):
    auth, project, role = access
    before = project_out(project, role)
    if body.name is not None:
        name = body.name.strip()
        duplicate = db.scalar(
            select(Project.id).where(
                func.lower(Project.name) == name.lower(),
                Project.id != project_id,
            )
        )
        if duplicate:
            raise friendly(409, f"A project named '{name}' already exists.")
        project.name = name
    if body.description is not None:
        project.description = body.description
    audit_event(
        db,
        auth,
        "project.update",
        "project",
        project.id,
        before=before,
        after=project_out(project, role),
    )
    db.commit()
    db.refresh(project)
    return project_out(project, role)


@router.delete("/projects/{project_id}")
def delete_project(
    access=Depends(require_project_perm(Permission.PROJECT_ADMIN)),
    db: Session = Depends(get_db),
):
    auth, project, _ = access
    project.deleted_at = datetime.now(timezone.utc)
    project.is_active = False
    audit_event(db, auth, "project.delete", "project", project.id)
    db.commit()
    return {
        "detail": "Project deleted.",
        "hint": "Data is retained according to retention policy.",
    }


@router.get("/projects/{project_id}/members")
def list_members(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.PROJECT_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(ProjectMembership)
        .options(selectinload(ProjectMembership.user))
        .where(ProjectMembership.project_id == project_id)
        .order_by(ProjectMembership.id)
        .offset(skip)
        .limit(limit)
    ).all()
    return [membership_out(row) for row in rows]


@router.post("/projects/{project_id}/members", status_code=201)
def add_member(
    project_id: int,
    body: MemberCreate,
    access=Depends(require_project_perm(Permission.MEMBER_MANAGE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    user = (
        db.get(User, body.user_id)
        if body.user_id is not None
        else db.scalar(
            select(User).where(func.lower(User.email) == str(body.email).lower())
        )
    )
    if not user or user.deleted_at is not None or not user.is_active:
        raise friendly(404, "An active user matching that identifier was not found.")
    existing = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user.id,
        )
    )
    if existing:
        raise friendly(
            409, "That user is already a project member.", "Update their role instead."
        )
    membership = ProjectMembership(
        project_id=project_id, user_id=user.id, role=body.role
    )
    db.add(membership)
    db.flush()
    membership.user = user
    audit_event(
        db,
        auth,
        "project.member.add",
        "project_membership",
        membership.id,
        after={"project_id": project_id, "user_id": user.id, "role": body.role.value},
    )
    db.commit()
    return membership_out(membership)


def _remove_member(
    project_id: int,
    user_id: int,
    access: tuple,
    db: Session,
):
    auth, _, _ = access
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user_id,
        )
    )
    if not membership:
        raise friendly(404, "Project membership was not found.")
    if membership.role == ProjectRole.PROJECT_ADMIN:
        admin_count = db.scalar(
            select(func.count())
            .select_from(ProjectMembership)
            .where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.role == ProjectRole.PROJECT_ADMIN,
            )
        )
        if (admin_count or 0) <= 1:
            raise friendly(400, "The last project administrator cannot be removed.")
    db.delete(membership)
    audit_event(
        db,
        auth,
        "project.member.remove",
        "project_membership",
        membership.id,
        before={"project_id": project_id, "user_id": user_id},
    )
    db.commit()
    return {"detail": "Project member removed.", "hint": None}


@router.delete("/projects/{project_id}/members/{user_id}")
def remove_member(
    project_id: int,
    user_id: int,
    access=Depends(require_project_perm(Permission.MEMBER_MANAGE)),
    db: Session = Depends(get_db),
):
    return _remove_member(project_id, user_id, access, db)


@router.delete("/projects/{project_id}/members")
def remove_member_query(
    project_id: int,
    user_id: int = Query(...),
    access=Depends(require_project_perm(Permission.MEMBER_MANAGE)),
    db: Session = Depends(get_db),
):
    return _remove_member(project_id, user_id, access, db)
