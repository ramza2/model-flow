"""Shared worker identity and operational status helpers (Phase 8-B).

Runner heartbeat and healthcheck must resolve the same worker ID in a container:
explicit ``WORKER_ID`` when set, otherwise the runtime/container hostname.
"""

from __future__ import annotations

import socket
from typing import Any

from app.core.config import settings
from app.services.runner_profiles import (
    capabilities_for_profile,
    normalize_worker_profile,
)


def resolve_worker_id() -> str:
    """Resolve the durable worker identity for this process.

    Priority:
    1. Explicit non-empty ``settings.worker_id`` / ``WORKER_ID``
    2. Runtime hostname (Compose scale-out uses distinct container hostnames)
    3. Stable fallback ``worker-unknown``
    """

    configured = (settings.worker_id or "").strip()
    if configured:
        return configured
    host = (socket.gethostname() or "").strip()
    if host:
        return host
    return "worker-unknown"


def resolve_worker_profile() -> str:
    return normalize_worker_profile(settings.worker_profile)


def resolve_worker_capabilities() -> tuple[str, ...]:
    return capabilities_for_profile(resolve_worker_profile())


def worker_status_payload() -> dict[str, Any]:
    """Operational heartbeat payload — never include secrets or credentials."""

    return {
        "worker_id": resolve_worker_id(),
        "profile": resolve_worker_profile(),
        "capabilities": list(resolve_worker_capabilities()),
        "max_concurrent_jobs": int(settings.worker_max_concurrent_jobs),
        "git_sha": (settings.git_sha or "unknown"),
    }
