from __future__ import annotations

from enum import Enum

from app.db.models import ProjectRole


class Permission(str, Enum):
    PROJECT_READ = "project:read"
    PROJECT_WRITE = "project:write"
    PROJECT_ADMIN = "project:admin"
    MEMBER_MANAGE = "member:manage"
    DATA_READ = "data:read"
    DATA_WRITE = "data:write"
    TRAIN_READ = "train:read"
    TRAIN_WRITE = "train:write"
    PIPELINE_READ = "pipeline:read"
    PIPELINE_WRITE = "pipeline:write"
    REGISTRY_READ = "registry:read"
    REGISTRY_WRITE = "registry:write"
    REGISTRY_APPROVE = "registry:approve"
    DEPLOY_READ = "deploy:read"
    DEPLOY_WRITE = "deploy:write"
    MONITOR_READ = "monitor:read"
    MONITOR_WRITE = "monitor:write"
    AUDIT_READ = "audit:read"
    ADMIN = "admin"


ROLE_PERMISSIONS: dict[ProjectRole, set[Permission]] = {
    ProjectRole.VIEWER: {
        Permission.PROJECT_READ,
        Permission.DATA_READ,
        Permission.TRAIN_READ,
        Permission.PIPELINE_READ,
        Permission.REGISTRY_READ,
        Permission.DEPLOY_READ,
        Permission.MONITOR_READ,
    },
    ProjectRole.DATA_SCIENTIST: {
        Permission.PROJECT_READ,
        Permission.DATA_READ,
        Permission.DATA_WRITE,
        Permission.TRAIN_READ,
        Permission.TRAIN_WRITE,
        Permission.PIPELINE_READ,
        Permission.REGISTRY_READ,
        Permission.DEPLOY_READ,
        Permission.MONITOR_READ,
    },
    ProjectRole.ML_ENGINEER: {
        Permission.PROJECT_READ,
        Permission.DATA_READ,
        Permission.DATA_WRITE,
        Permission.TRAIN_READ,
        Permission.TRAIN_WRITE,
        Permission.PIPELINE_READ,
        Permission.PIPELINE_WRITE,
        Permission.REGISTRY_READ,
        Permission.REGISTRY_WRITE,
        Permission.DEPLOY_READ,
        Permission.DEPLOY_WRITE,
        Permission.MONITOR_READ,
        Permission.MONITOR_WRITE,
    },
    ProjectRole.PROJECT_ADMIN: set(Permission),  # all except we still gate SYSTEM via is_system_admin
}

# PROJECT_ADMIN gets all project-scoped permissions
ROLE_PERMISSIONS[ProjectRole.PROJECT_ADMIN] = {
    p for p in Permission if p != Permission.ADMIN
} | {
    Permission.PROJECT_ADMIN,
    Permission.MEMBER_MANAGE,
    Permission.REGISTRY_APPROVE,
    Permission.AUDIT_READ,
}


def role_has(role: ProjectRole, perm: Permission) -> bool:
    return perm in ROLE_PERMISSIONS.get(role, set())
