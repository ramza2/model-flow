"""Worker runner profile / capability routing contract (Phase 8-B).

Existing workloads require the ``general`` profile. GPU is a routing foundation
only — unsupported/unknown profiles fail closed, and a GPU worker does not claim
general (e.g. sklearn) jobs merely because it exists.
"""

from __future__ import annotations

KNOWN_PROFILES = frozenset({"general", "gpu"})
DEFAULT_REQUIRED_PROFILE = "general"

PROFILE_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "general": ("cpu",),
    "gpu": ("cpu", "gpu"),
}


def normalize_worker_profile(raw: str | None) -> str:
    value = (raw or DEFAULT_REQUIRED_PROFILE).strip().lower()
    if not value:
        value = DEFAULT_REQUIRED_PROFILE
    if value not in KNOWN_PROFILES:
        raise ValueError(f"Unsupported worker profile: {raw!r}")
    return value


def capabilities_for_profile(profile: str) -> tuple[str, ...]:
    normalized = normalize_worker_profile(profile)
    return PROFILE_CAPABILITIES[normalized]


def required_profile_for_workload(_workload: str | None = None) -> str:
    """Return the profile required to claim a workload.

    All current ModelFlow workloads require ``general``. Future GPU-aware
    workloads can branch on ``_workload`` without changing job table schemas.
    """

    return DEFAULT_REQUIRED_PROFILE


def worker_can_claim(required_profile: str, worker_profile: str) -> bool:
    """Return True only when both profiles are known and exactly match.

    Unknown or mismatched profiles are ineligible (fail closed).
    """

    required = (required_profile or "").strip().lower()
    worker = (worker_profile or "").strip().lower()
    if required not in KNOWN_PROFILES or worker not in KNOWN_PROFILES:
        return False
    return required == worker
