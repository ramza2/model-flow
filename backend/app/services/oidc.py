"""Phase 8-C Enterprise OIDC / SSO helpers.

Uses Authorization Code + PKCE S256 with server-side transactions. ID tokens are
validated with PyJWT + JWKS (cryptography). OIDC tokens are never used as
ModelFlow API credentials — success maps to an existing User and issues a
ModelFlow HS256 access token via the one-time exchange endpoint.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import encrypt_secret, decrypt_secret, hash_password
from app.db.models import ExternalIdentity, OidcLoginTransaction, User

logger = logging.getLogger(__name__)

ALLOWED_ID_TOKEN_ALGS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512")


class OidcError(Exception):
    """Fail-closed OIDC failure with a sanitized public message."""

    def __init__(self, public_message: str, *, category: str = "oidc_error"):
        super().__init__(public_message)
        self.public_message = public_message
        self.category = category


@dataclass(frozen=True)
class OidcClaims:
    issuer: str
    subject: str
    email: str | None
    email_verified: bool
    full_name: str
    raw: dict[str, Any]


def oidc_is_enabled() -> bool:
    return bool(settings.oidc_enabled)


def require_oidc_configured() -> None:
    if not settings.oidc_enabled:
        raise OidcError("Single sign-on is not enabled.", category="oidc_disabled")
    missing = [
        name
        for name, value in (
            ("issuer", settings.oidc_issuer),
            ("client_id", settings.oidc_client_id),
            ("client_secret", settings.oidc_client_secret),
            ("redirect_uri", settings.oidc_redirect_uri),
        )
        if not str(value or "").strip()
    ]
    if missing:
        logger.error("oidc_misconfigured missing=%s", ",".join(missing))
        raise OidcError(
            "Single sign-on is not configured correctly.",
            category="oidc_misconfigured",
        )


def public_auth_methods() -> dict[str, Any]:
    return {
        "local": True,
        "oidc": {
            "enabled": bool(settings.oidc_enabled),
            "display_name": (
                settings.oidc_display_name.strip() or "Company SSO"
                if settings.oidc_enabled
                else None
            ),
        },
    }


def sanitize_return_to(value: str | None) -> str:
    """Allow only ModelFlow-internal relative paths (open-redirect safe)."""

    if value is None:
        return "/"
    path = str(value).strip() or "/"
    if not path.startswith("/") or path.startswith("//"):
        raise OidcError("Invalid return path.", category="invalid_return_to")
    lowered = path.lower()
    if (
        "://" in path
        or "\\" in path
        or "\x00" in path
        or lowered.startswith("/javascript:")
        or lowered.startswith("/data:")
    ):
        raise OidcError("Invalid return path.", category="invalid_return_to")
    if len(path) > 500:
        path = path[:500]
    return path


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _b64url_no_pad(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def generate_pkce_pair() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for S256."""

    verifier = _b64url_no_pad(secrets.token_bytes(32))
    challenge = _b64url_no_pad(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _http_client() -> httpx.Client:
    return httpx.Client(
        timeout=settings.oidc_http_timeout_seconds,
        follow_redirects=False,
        trust_env=False,
    )


def fetch_discovery(issuer: str | None = None) -> dict[str, Any]:
    issuer_url = (issuer or settings.oidc_issuer).rstrip("/")
    if not issuer_url:
        raise OidcError("Identity provider is unavailable.", category="discovery_failed")
    url = f"{issuer_url}/.well-known/openid-configuration"
    try:
        with _http_client() as client:
            response = client.get(url)
            response.raise_for_status()
            doc = response.json()
    except Exception:
        logger.exception("oidc_discovery_failed")
        raise OidcError(
            "Identity provider is unavailable.", category="discovery_failed"
        ) from None
    if not isinstance(doc, dict):
        raise OidcError(
            "Identity provider is unavailable.", category="discovery_malformed"
        )
    discovered_issuer = str(doc.get("issuer") or "").rstrip("/")
    if discovered_issuer != issuer_url:
        raise OidcError(
            "Identity provider is unavailable.", category="issuer_mismatch"
        )
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not str(doc.get(key) or "").strip():
            raise OidcError(
                "Identity provider is unavailable.",
                category=f"discovery_missing_{key}",
            )
    return doc


def cleanup_expired_transactions(db: Session, *, limit: int = 200) -> int:
    now = datetime.now(timezone.utc)
    stale = db.scalars(
        select(OidcLoginTransaction.id)
        .where(
            OidcLoginTransaction.expires_at < now - timedelta(hours=1),
            or_(
                OidcLoginTransaction.exchange_expires_at.is_(None),
                OidcLoginTransaction.exchange_expires_at
                < now - timedelta(hours=1),
            ),
        )
        .limit(limit)
    ).all()
    if not stale:
        return 0
    db.execute(
        delete(OidcLoginTransaction).where(OidcLoginTransaction.id.in_(list(stale)))
    )
    return len(stale)


def begin_login_transaction(
    db: Session, *, return_to: str | None
) -> tuple[str, OidcLoginTransaction]:
    """Create PKCE/state/nonce transaction and return authorize URL + row."""

    require_oidc_configured()
    safe_return = sanitize_return_to(return_to)
    discovery = fetch_discovery()
    state = _b64url_no_pad(secrets.token_bytes(32))
    nonce = _b64url_no_pad(secrets.token_bytes(32))
    verifier, challenge = generate_pkce_pair()
    now = datetime.now(timezone.utc)
    row = OidcLoginTransaction(
        id=str(uuid.uuid4()),
        state_hash=_sha256_hex(state),
        nonce_encrypted=encrypt_secret(nonce),
        code_verifier_encrypted=encrypt_secret(verifier),
        return_to=safe_return,
        expires_at=now + timedelta(seconds=settings.oidc_transaction_ttl_seconds),
    )
    cleanup_expired_transactions(db)
    db.add(row)
    db.flush()
    params = {
        "response_type": "code",
        "client_id": settings.oidc_client_id,
        "redirect_uri": settings.oidc_redirect_uri,
        "scope": settings.oidc_scopes.strip() or "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    authorize_url = (
        f"{discovery['authorization_endpoint']}?{urlencode(params)}"
    )
    return authorize_url, row


def _load_transaction_by_state(db: Session, state: str) -> OidcLoginTransaction:
    if not state:
        raise OidcError("Sign-in could not be completed.", category="state_missing")
    row = db.scalar(
        select(OidcLoginTransaction).where(
            OidcLoginTransaction.state_hash == _sha256_hex(state)
        )
    )
    if row is None:
        raise OidcError("Sign-in could not be completed.", category="state_mismatch")
    now = datetime.now(timezone.utc)
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < now:
        raise OidcError("Sign-in session expired.", category="transaction_expired")
    if row.consumed_at is not None:
        raise OidcError("Sign-in could not be completed.", category="callback_replay")
    return row


def exchange_authorization_code(
    *, code: str, code_verifier: str, discovery: dict[str, Any]
) -> dict[str, Any]:
    if not code:
        raise OidcError("Sign-in could not be completed.", category="code_missing")
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.oidc_redirect_uri,
        "client_id": settings.oidc_client_id,
        "client_secret": settings.oidc_client_secret,
        "code_verifier": code_verifier,
    }
    try:
        with _http_client() as client:
            response = client.post(
                discovery["token_endpoint"],
                data=data,
                headers={"Accept": "application/json"},
            )
            if response.status_code >= 400:
                logger.warning(
                    "oidc_token_exchange_failed status=%s", response.status_code
                )
                raise OidcError(
                    "Sign-in could not be completed.",
                    category="token_exchange_failed",
                )
            payload = response.json()
    except OidcError:
        raise
    except Exception:
        logger.exception("oidc_token_exchange_error")
        raise OidcError(
            "Sign-in could not be completed.", category="token_exchange_failed"
        ) from None
    if not isinstance(payload, dict) or not payload.get("id_token"):
        raise OidcError(
            "Sign-in could not be completed.", category="token_exchange_failed"
        )
    return payload


def _fetch_jwks(jwks_uri: str) -> dict[str, Any]:
    try:
        with _http_client() as client:
            response = client.get(jwks_uri)
            response.raise_for_status()
            doc = response.json()
    except Exception:
        logger.exception("oidc_jwks_fetch_failed")
        raise OidcError(
            "Sign-in could not be completed.", category="jwks_unavailable"
        ) from None
    if not isinstance(doc, dict) or not isinstance(doc.get("keys"), list):
        raise OidcError(
            "Sign-in could not be completed.", category="jwks_malformed"
        )
    return doc


def _signing_key_from_jwks(jwks: dict[str, Any], *, kid: str | None, alg: str):
    keys = jwks.get("keys") or []
    candidates = []
    for key in keys:
        if not isinstance(key, dict):
            continue
        if kid and key.get("kid") and key.get("kid") != kid:
            continue
        if key.get("kty") != "RSA":
            continue
        candidates.append(key)
    if not candidates:
        raise OidcError(
            "Sign-in could not be completed.", category="jwks_key_not_found"
        )
    try:
        return RSAAlgorithm.from_jwk(json.dumps(candidates[0]))
    except Exception as exc:
        raise OidcError(
            "Sign-in could not be completed.", category="jwks_key_not_found"
        ) from exc


def validate_id_token(
    id_token: str, *, nonce: str, discovery: dict[str, Any]
) -> OidcClaims:
    """Validate ID token signature and standard claims (fail closed)."""

    if not id_token or id_token.count(".") != 2:
        raise OidcError("Sign-in could not be completed.", category="invalid_id_token")
    try:
        header = jwt.get_unverified_header(id_token)
    except Exception as exc:
        raise OidcError(
            "Sign-in could not be completed.", category="invalid_id_token"
        ) from exc
    alg = str(header.get("alg") or "")
    if alg.lower() == "none" or alg not in ALLOWED_ID_TOKEN_ALGS:
        raise OidcError("Sign-in could not be completed.", category="invalid_algorithm")
    jwks_uri = str(discovery.get("jwks_uri") or "")
    try:
        jwks = _fetch_jwks(jwks_uri)
        signing_key = _signing_key_from_jwks(
            jwks, kid=header.get("kid"), alg=alg
        )
        claims = jwt.decode(
            id_token,
            signing_key,
            algorithms=list(ALLOWED_ID_TOKEN_ALGS),
            audience=settings.oidc_client_id,
            issuer=settings.oidc_issuer.rstrip("/"),
            options={
                "require": ["exp", "iat", "iss", "sub", "aud"],
                "verify_aud": True,
                "verify_iss": True,
                "verify_exp": True,
            },
        )
    except OidcError:
        raise
    except jwt.InvalidAudienceError as exc:
        raise OidcError(
            "Sign-in could not be completed.", category="audience_mismatch"
        ) from exc
    except jwt.InvalidIssuerError as exc:
        raise OidcError(
            "Sign-in could not be completed.", category="issuer_mismatch"
        ) from exc
    except jwt.ExpiredSignatureError as exc:
        raise OidcError(
            "Sign-in could not be completed.", category="id_token_expired"
        ) from exc
    except Exception as exc:
        logger.info("oidc_id_token_validation_failed err_type=%s", type(exc).__name__)
        raise OidcError(
            "Sign-in could not be completed.", category="invalid_signature"
        ) from exc

    token_nonce = str(claims.get("nonce") or "")
    if not token_nonce or not secrets.compare_digest(token_nonce, nonce):
        raise OidcError("Sign-in could not be completed.", category="nonce_mismatch")

    subject = str(claims.get("sub") or "").strip()
    issuer = str(claims.get("iss") or "").rstrip("/")
    if not subject or issuer != settings.oidc_issuer.rstrip("/"):
        raise OidcError("Sign-in could not be completed.", category="issuer_mismatch")

    email_raw = claims.get("email")
    email = str(email_raw).strip().lower() if email_raw else None
    email_verified = claims.get("email_verified") is True
    name = str(claims.get("name") or claims.get("preferred_username") or "").strip()
    if not name and email:
        name = email.split("@", 1)[0]
    return OidcClaims(
        issuer=issuer,
        subject=subject,
        email=email,
        email_verified=email_verified,
        full_name=name or "SSO User",
        raw=claims,
    )


def _reject_inactive(user: User) -> None:
    if user.deleted_at is not None or not user.is_active:
        raise OidcError(
            "This account is inactive. Contact an administrator.",
            category="user_inactive",
        )


def resolve_or_provision_user(db: Session, claims: OidcClaims) -> tuple[User, str]:
    """Map verified claims to a User. Returns (user, audit_action_suffix).

    audit_action_suffix is one of: login | link | provision
    """

    identity = db.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.issuer == claims.issuer,
            ExternalIdentity.subject == claims.subject,
        )
    )
    if identity is not None:
        user = db.get(User, identity.user_id)
        if user is None:
            raise OidcError(
                "This account is inactive. Contact an administrator.",
                category="user_inactive",
            )
        _reject_inactive(user)
        identity.last_login_at = datetime.now(timezone.utc)
        return user, "login"

    # First-time: optional verified-email link to existing local user.
    if claims.email and claims.email_verified:
        existing = db.scalar(
            select(User).where(
                func.lower(User.email) == claims.email,
                User.deleted_at.is_(None),
            )
        )
        if existing is not None:
            _reject_inactive(existing)
            # Do not link if this user already has a binding for this issuer.
            prior = db.scalar(
                select(ExternalIdentity.id).where(
                    ExternalIdentity.user_id == existing.id,
                    ExternalIdentity.issuer == claims.issuer,
                )
            )
            if prior is not None:
                raise OidcError(
                    "This account is already linked to a different SSO identity.",
                    category="identity_conflict",
                )
            db.add(
                ExternalIdentity(
                    user_id=existing.id,
                    issuer=claims.issuer,
                    subject=claims.subject,
                    email_at_link=claims.email,
                    last_login_at=datetime.now(timezone.utc),
                )
            )
            db.flush()
            return existing, "link"

    if claims.email and not claims.email_verified:
        # Unverified email must never auto-link; may still JIT if enabled.
        pass

    if not settings.oidc_auto_provision:
        raise OidcError(
            "No ModelFlow account is linked for this SSO identity. "
            "Contact an administrator.",
            category="provision_disabled",
        )

    # JIT provision — never grant system admin from IdP claims.
    email = claims.email
    if not email:
        raise OidcError(
            "Your identity provider did not supply a usable email address.",
            category="email_missing",
        )
    if db.scalar(
        select(User.id).where(func.lower(User.email) == email, User.deleted_at.is_(None))
    ):
        # Matching email exists but was not linkable (unverified) — fail closed.
        raise OidcError(
            "Unable to link this SSO identity to an existing account.",
            category="link_requires_verified_email",
        )
    # Never resurrect soft-deleted users with the same email.
    if db.scalar(select(User.id).where(func.lower(User.email) == email)):
        raise OidcError(
            "Unable to create an account for this identity.",
            category="email_unavailable",
        )

    user = User(
        email=email,
        full_name=claims.full_name[:200],
        password_hash=hash_password(secrets.token_urlsafe(48)),
        is_active=True,
        is_system_admin=False,
        local_login_enabled=False,
    )
    db.add(user)
    db.flush()
    db.add(
        ExternalIdentity(
            user_id=user.id,
            issuer=claims.issuer,
            subject=claims.subject,
            email_at_link=email,
            last_login_at=datetime.now(timezone.utc),
        )
    )
    db.flush()
    return user, "provision"


def complete_callback(
    db: Session, *, state: str, code: str
) -> tuple[str, str, User, str]:
    """Validate callback, map user, mint one-time exchange code.

    Returns (exchange_code, return_to, user, mapping_kind).
    """

    require_oidc_configured()
    row = _load_transaction_by_state(db, state)
    nonce = decrypt_secret(row.nonce_encrypted)
    verifier = decrypt_secret(row.code_verifier_encrypted)
    discovery = fetch_discovery()
    token_payload = exchange_authorization_code(
        code=code, code_verifier=verifier, discovery=discovery
    )
    # Do not log token_payload — contains access/id tokens.
    claims = validate_id_token(
        str(token_payload["id_token"]), nonce=nonce, discovery=discovery
    )
    user, kind = resolve_or_provision_user(db, claims)
    now = datetime.now(timezone.utc)
    row.consumed_at = now
    row.user_id = user.id
    exchange_code = _b64url_no_pad(secrets.token_bytes(32))
    row.exchange_code_hash = _sha256_hex(exchange_code)
    row.exchange_expires_at = now + timedelta(
        seconds=settings.oidc_exchange_ttl_seconds
    )
    row.exchange_consumed_at = None
    db.flush()
    return exchange_code, row.return_to, user, kind


def consume_exchange_code(db: Session, code: str) -> User:
    if not code or not str(code).strip():
        raise OidcError("Sign-in could not be completed.", category="exchange_missing")
    row = db.scalar(
        select(OidcLoginTransaction).where(
            OidcLoginTransaction.exchange_code_hash == _sha256_hex(code.strip())
        )
    )
    if row is None or row.user_id is None:
        raise OidcError("Sign-in could not be completed.", category="exchange_invalid")
    now = datetime.now(timezone.utc)
    if row.exchange_consumed_at is not None:
        raise OidcError("Sign-in could not be completed.", category="exchange_replay")
    expires = row.exchange_expires_at
    if expires is None:
        raise OidcError("Sign-in could not be completed.", category="exchange_invalid")
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < now:
        raise OidcError("Sign-in session expired.", category="exchange_expired")
    user = db.get(User, row.user_id)
    if user is None:
        raise OidcError(
            "This account is inactive. Contact an administrator.",
            category="user_inactive",
        )
    _reject_inactive(user)
    row.exchange_consumed_at = now
    db.flush()
    return user


def frontend_callback_redirect_url(*, exchange_code: str, return_to: str) -> str:
    """Build relative frontend redirect (no external open redirect)."""

    path = settings.oidc_frontend_callback_path.strip() or "/login/oidc/callback"
    if not path.startswith("/") or path.startswith("//") or "://" in path:
        path = "/login/oidc/callback"
    safe_return = sanitize_return_to(return_to)
    query = urlencode({"code": exchange_code, "return_to": safe_return})
    return f"{path}?{query}"
