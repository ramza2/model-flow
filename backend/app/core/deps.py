from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.core.rbac import Permission, role_has
from app.core.security import decode_access_token
from app.db.models import Project, ProjectMembership, ProjectRole, User
from app.db.session import get_db

bearer = HTTPBearer(auto_error=False)


class AuthContext:
    def __init__(
        self, user: User, request_id: str | None = None, ip: str | None = None
    ):
        self.user = user
        self.request_id = request_id
        self.ip = ip

    @property
    def is_system_admin(self) -> bool:
        return bool(self.user.is_system_admin)


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def get_request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None) or request.headers.get(
        "x-request-id"
    )


def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "detail": "Authentication required.",
                "hint": "Sign in and pass Authorization: Bearer <token>.",
            },
        )
    try:
        payload = decode_access_token(creds.credentials)
        user_id = int(payload["sub"])
        token_version = int(payload.get("tv", 0))
    except (PyJWTError, KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "detail": "Invalid or expired token.",
                "hint": "Sign in again.",
            },
        )
    user = db.get(User, user_id)
    if not user or user.deleted_at is not None:
        raise HTTPException(
            status_code=401, detail={"detail": "User not found.", "hint": None}
        )
    if not user.is_active:
        raise HTTPException(
            status_code=403,
            detail={
                "detail": "User account is inactive.",
                "hint": "Contact an administrator.",
            },
        )
    if user.token_version != token_version:
        raise HTTPException(
            status_code=401,
            detail={
                "detail": "Token has been revoked.",
                "hint": "Sign in again.",
            },
        )
    return user


def get_auth(
    request: Request,
    user: User = Depends(get_current_user),
) -> AuthContext:
    return AuthContext(
        user=user, request_id=get_request_id(request), ip=client_ip(request)
    )


def get_optional_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User | None:
    if creds is None:
        return None
    try:
        return get_current_user(request, creds, db)
    except HTTPException:
        return None


def _audit_authorization_denial(
    db: Session,
    auth: AuthContext,
    *,
    resource_type: str,
    resource_id: str | int | None,
    required_permission: str,
    failure_reason: str,
) -> None:
    write_audit(
        db,
        action="authorization.denied",
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        user_id=auth.user.id,
        user_email=auth.user.email,
        success=False,
        ip_address=auth.ip,
        request_id=auth.request_id,
        after={"required_permission": required_permission},
        failure_reason=failure_reason,
    )
    db.commit()


def require_system_admin(
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
) -> AuthContext:
    if not auth.is_system_admin:
        _audit_authorization_denial(
            db,
            auth,
            resource_type="system",
            resource_id=None,
            required_permission=Permission.ADMIN.value,
            failure_reason="system_administrator_required",
        )
        raise HTTPException(
            status_code=403,
            detail={
                "detail": "System administrator privileges required.",
                "hint": None,
            },
        )
    return auth


def get_membership(
    db: Session, project_id: int, user_id: int
) -> ProjectMembership | None:
    return db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user_id,
        )
    )


def require_project_perm(perm: Permission):
    def _dep(
        project_id: int,
        auth: AuthContext = Depends(get_auth),
        db: Session = Depends(get_db),
    ) -> tuple[AuthContext, Project, ProjectRole | None]:
        project = db.get(Project, project_id)
        if not project or project.deleted_at is not None:
            _audit_authorization_denial(
                db,
                auth,
                resource_type="project",
                resource_id=project_id,
                required_permission=perm.value,
                failure_reason="project_not_found",
            )
            raise HTTPException(
                status_code=404,
                detail={
                    "detail": f"Project {project_id} was not found.",
                    "hint": "Check the project list and try again.",
                },
            )
        if auth.is_system_admin:
            return auth, project, ProjectRole.PROJECT_ADMIN
        membership = get_membership(db, project_id, auth.user.id)
        if not membership:
            _audit_authorization_denial(
                db,
                auth,
                resource_type="project",
                resource_id=project_id,
                required_permission=perm.value,
                failure_reason="project_membership_required",
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "detail": "You are not a member of this project.",
                    "hint": "Ask a project admin to add you.",
                },
            )
        if not role_has(membership.role, perm):
            _audit_authorization_denial(
                db,
                auth,
                resource_type="project",
                resource_id=project_id,
                required_permission=perm.value,
                failure_reason="project_permission_required",
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "detail": "You do not have permission for this action.",
                    "hint": f"Required permission: {perm.value}",
                },
            )
        return auth, project, membership.role

    return _dep


def correlation_id_header(
    x_request_id: str | None = Header(default=None, alias="X-Request-ID"),
) -> str | None:
    return x_request_id
