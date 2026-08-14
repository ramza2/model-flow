from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from cryptography.fernet import Fernet, InvalidToken
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"

_SECRET_RE = re.compile(
    r"(password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key)",
    re.IGNORECASE,
)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_expire_minutes)).timestamp()),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])


def _fernet() -> Fernet:
    raw = settings.encryption_key.strip()
    if raw:
        return Fernet(raw.encode() if not raw.endswith("=") and len(raw) < 50 else raw.encode())
    # Derive stable Fernet key from secret_key for local/dev
    digest = hashlib.sha256(settings.secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError("Unable to decrypt secret; check MODELFLOW_ENCRYPTION_KEY") from exc


def mask_secrets(obj: Any) -> Any:
    """Recursively mask secret-like keys for logs/audit summaries."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            key_name = str(k)
            if _SECRET_RE.search(key_name) or key_name in {"key", "key_hash"}:
                out[k] = "***"
            else:
                out[k] = mask_secrets(v)
        return out
    if isinstance(obj, list):
        return [mask_secrets(x) for x in obj]
    if isinstance(obj, str) and len(obj) > 200:
        return obj[:200] + "…"
    return obj


def safe_filename(name: str) -> str:
    base = name.replace("\\", "/").split("/")[-1]
    base = re.sub(r"[^\w.\- ()\[\]]+", "_", base).strip("._") or "file"
    return base[:180]
