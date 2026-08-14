"""Service API key generation, hashing, and lookup helpers.

Plaintext keys are never persisted. Format: mfk_<prefix8>_<secret>.
Hashing uses SHA-256 of the full high-entropy key (not password KDF).
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ServiceApiKey

KEY_PREFIX_TAG = "mfk"
PUBLIC_PREFIX_LEN = 8
# token_urlsafe(32) ≈ 256 bits of entropy for the secret segment.
SECRET_TOKEN_BYTES = 32
MAX_PREFIX_COLLISION_RETRIES = 8


def as_utc(dt: datetime | None) -> datetime | None:
    """Normalize naive/aware datetimes for UTC comparisons (SQLite-safe)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def hash_service_api_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def verify_service_api_key(plaintext: str, key_hash: str) -> bool:
    digest = hash_service_api_key(plaintext)
    return secrets.compare_digest(digest, key_hash)


def parse_key_prefix(plaintext: str) -> str | None:
    """Return stored lookup prefix (mfk_<8chars>) or None if malformed."""
    if not plaintext or not plaintext.startswith(f"{KEY_PREFIX_TAG}_"):
        return None
    parts = plaintext.split("_", 2)
    if len(parts) != 3:
        return None
    tag, public, secret = parts
    if tag != KEY_PREFIX_TAG:
        return None
    if len(public) != PUBLIC_PREFIX_LEN:
        return None
    if not public.isalnum():
        return None
    if not secret:
        return None
    return f"{KEY_PREFIX_TAG}_{public}"


def generate_service_api_key(db: Session) -> tuple[str, str, str]:
    """Return (plaintext, key_prefix, key_hash), retrying on prefix collision."""
    for _ in range(MAX_PREFIX_COLLISION_RETRIES):
        public = secrets.token_hex(PUBLIC_PREFIX_LEN // 2)
        secret = secrets.token_urlsafe(SECRET_TOKEN_BYTES)
        plaintext = f"{KEY_PREFIX_TAG}_{public}_{secret}"
        prefix = f"{KEY_PREFIX_TAG}_{public}"
        exists = db.scalar(
            select(ServiceApiKey.id).where(ServiceApiKey.key_prefix == prefix)
        )
        if exists is not None:
            continue
        return plaintext, prefix, hash_service_api_key(plaintext)
    raise RuntimeError("Unable to allocate a unique service API key prefix")


def find_key_by_plaintext(db: Session, plaintext: str) -> ServiceApiKey | None:
    prefix = parse_key_prefix(plaintext)
    if prefix is None:
        return None
    row = db.scalar(
        select(ServiceApiKey).where(ServiceApiKey.key_prefix == prefix)
    )
    if row is None:
        return None
    if not verify_service_api_key(plaintext, row.key_hash):
        return None
    return row


def is_key_currently_usable(row: ServiceApiKey, *, now: datetime | None = None) -> bool:
    if not row.is_active:
        return False
    if row.revoked_at is not None:
        return False
    expires_at = as_utc(row.expires_at)
    if expires_at is not None:
        current = as_utc(now) or datetime.now(timezone.utc)
        if expires_at <= current:
            return False
    return True
