"""Helpers for reproducible dataset split configuration and integrity."""

from __future__ import annotations

import hashlib


def split_config_signature(
    train_ratio: float,
    val_ratio: float,
    test_ratio: float,
    random_seed: int,
) -> str:
    """Canonical signature for duplicate detection across float ratio inputs."""
    return (
        f"{round(float(train_ratio), 6):.6f}:"
        f"{round(float(val_ratio), 6):.6f}:"
        f"{round(float(test_ratio), 6):.6f}:"
        f"{int(random_seed)}"
    )


def content_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()
