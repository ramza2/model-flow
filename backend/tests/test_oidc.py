"""Phase 8-C OIDC / SSO deterministic tests (no external IdP)."""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import create_access_token, hash_password
from app.db.models import (
    AuditLog,
    Base,
    ExternalIdentity,
    OidcLoginTransaction,
    Project,
    ProjectMembership,
    ProjectRole,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import oidc as oidc_service


ISSUER = "https://idp.test.example"
CLIENT_ID = "modelflow-test"
REDIRECT_URI = "http://localhost:8000/api/v1/auth/oidc/callback"


@pytest.fixture(scope="module")
def rsa_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    numbers = public_key.public_numbers()

    def _b64url_int(value: int) -> str:
        import base64

        length = (value.bit_length() + 7) // 8
        return base64.urlsafe_b64encode(value.to_bytes(length, "big")).decode().rstrip("=")

    jwk = {
        "kty": "RSA",
        "kid": "test-key-1",
        "use": "sig",
        "alg": "RS256",
        "n": _b64url_int(numbers.n),
        "e": _b64url_int(numbers.e),
    }
    return private_pem, {"keys": [jwk]}


@pytest.fixture
def oidc_db(monkeypatch, rsa_keys):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    Base.metadata.create_all(engine)
    _rate_windows.clear()

    monkeypatch.setattr(settings, "secret_key", secrets.token_urlsafe(48))
    monkeypatch.setattr(settings, "encryption_key", "")
    monkeypatch.setattr(settings, "oidc_enabled", True)
    monkeypatch.setattr(settings, "oidc_issuer", ISSUER)
    monkeypatch.setattr(settings, "oidc_client_id", CLIENT_ID)
    monkeypatch.setattr(settings, "oidc_client_secret", "test-secret")
    monkeypatch.setattr(settings, "oidc_redirect_uri", REDIRECT_URI)
    monkeypatch.setattr(settings, "oidc_display_name", "Company SSO")
    monkeypatch.setattr(settings, "oidc_auto_provision", False)
    monkeypatch.setattr(settings, "oidc_scopes", "openid profile email")
    monkeypatch.setattr(settings, "oidc_http_timeout_seconds", 2.0)

    private_pem, jwks = rsa_keys

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        issuer = settings.oidc_issuer.strip()
        endpoint_base = issuer[:-1] if issuer.endswith("/") else issuer
        if path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                json={
                    "issuer": issuer,
                    "authorization_endpoint": f"{endpoint_base}/authorize",
                    "token_endpoint": f"{endpoint_base}/token",
                    "jwks_uri": f"{endpoint_base}/jwks",
                },
            )
        if path.endswith("/jwks"):
            return httpx.Response(200, json=jwks)
        if path.endswith("/token"):
            # Decode form body for code_verifier presence only; mint ID token in tests via helper.
            return httpx.Response(200, json={"id_token": "placeholder", "access_token": "atk"})
        return httpx.Response(404, json={"error": "not_found"})

    transport = httpx.MockTransport(handler)

    def client_factory() -> httpx.Client:
        return httpx.Client(
            transport=transport,
            timeout=2.0,
            follow_redirects=False,
            trust_env=False,
        )

    monkeypatch.setattr(oidc_service, "_http_client", client_factory)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestingSessionLocal, private_pem
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client(oidc_db):
    return TestClient(app)


def _mint_id_token(
    private_pem: bytes,
    *,
    sub: str,
    nonce: str,
    email: str | None = "user@example.com",
    email_verified: bool = True,
    aud: str | list | int | dict = CLIENT_ID,
    iss: str = ISSUER,
    azp: str | None = None,
    exp_delta: int = 300,
    extra: dict | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "iss": iss,
        "sub": sub,
        "aud": aud,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=exp_delta)).timestamp()),
        "nonce": nonce,
        "name": "SSO User",
    }
    if azp is not None:
        payload["azp"] = azp
    if email is not None:
        payload["email"] = email
        payload["email_verified"] = email_verified
    if extra:
        payload.update(extra)
    return jwt.encode(
        payload,
        private_pem,
        algorithm="RS256",
        headers={"kid": "test-key-1"},
    )


def _discovery() -> dict:
    return {
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "jwks_uri": f"{ISSUER}/jwks",
    }


def _seed_local_user(SessionLocal, **overrides):
    with SessionLocal() as db:
        user = User(
            email=overrides.get("email", "local@example.com"),
            full_name=overrides.get("full_name", "Local User"),
            password_hash=hash_password(overrides.get("password", "Password123!")),
            is_active=overrides.get("is_active", True),
            is_system_admin=overrides.get("is_system_admin", False),
            local_login_enabled=overrides.get("local_login_enabled", True),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def test_oidc_disabled_methods_and_start(monkeypatch, client, oidc_db):
    monkeypatch.setattr(settings, "oidc_enabled", False)
    methods = client.get("/api/v1/auth/methods")
    assert methods.status_code == 200
    body = methods.json()
    assert body["local"] is True
    assert body["oidc"]["enabled"] is False
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    assert start.status_code == 400


def test_auth_methods_public_no_secrets(client, oidc_db):
    response = client.get("/api/v1/auth/methods")
    assert response.status_code == 200
    payload = json.dumps(response.json()).lower()
    assert "test-secret" not in payload
    assert "client_secret" not in payload
    assert response.json()["oidc"]["enabled"] is True
    assert response.json()["oidc"]["display_name"] == "Company SSO"


def test_start_creates_pkce_s256_authorize_url(client, oidc_db):
    response = client.get(
        "/api/v1/auth/oidc/start",
        params={"return_to": "/projects/1"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith(f"{ISSUER}/authorize?")
    query = parse_qs(urlparse(location).query)
    assert query["response_type"] == ["code"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"][0]
    assert query["state"][0]
    assert query["nonce"][0]
    assert "client_secret" not in query


def test_state_mismatch_fail(client, oidc_db):
    response = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "abc", "state": "nope"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert "oidc_error=" in response.headers["location"]


def test_sanitize_return_to_rejects_external():
    with pytest.raises(oidc_service.OidcError):
        oidc_service.sanitize_return_to("https://evil.example")
    with pytest.raises(oidc_service.OidcError):
        oidc_service.sanitize_return_to("//evil.example")
    with pytest.raises(oidc_service.OidcError):
        oidc_service.sanitize_return_to("javascript:alert(1)")
    assert oidc_service.sanitize_return_to("/projects/12/models") == "/projects/12/models"
    assert oidc_service.sanitize_return_to("/") == "/"


def test_expired_transaction_fail(client, oidc_db):
    SessionLocal, _ = oidc_db
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    with SessionLocal() as db:
        row = db.scalar(
            select(OidcLoginTransaction).where(
                OidcLoginTransaction.state_hash == oidc_service._sha256_hex(state)
            )
        )
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=5)
        db.commit()
    response = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "abc", "state": state},
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert "expired" in response.headers["location"].lower() or "oidc_error=" in response.headers["location"]


def test_invalid_signature_and_claim_mismatches(oidc_db, rsa_keys):
    SessionLocal, private_pem = oidc_db
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_pem = other_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    discovery = {
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "jwks_uri": f"{ISSUER}/jwks",
    }
    good = _mint_id_token(private_pem, sub="sub-1", nonce="nonce-1")
    claims = oidc_service.validate_id_token(good, nonce="nonce-1", discovery=discovery)
    assert claims.subject == "sub-1"

    bad_sig = _mint_id_token(other_pem, sub="sub-1", nonce="nonce-1")
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(bad_sig, nonce="nonce-1", discovery=discovery)
    assert exc.value.category in {"invalid_signature", "jwks_key_not_found"}

    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(
            _mint_id_token(private_pem, sub="sub-1", nonce="nonce-1", aud="other"),
            nonce="nonce-1",
            discovery=discovery,
        )
    assert exc.value.category == "audience_mismatch"

    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(
            _mint_id_token(
                private_pem, sub="sub-1", nonce="nonce-1", iss="https://evil.example"
            ),
            nonce="nonce-1",
            discovery=discovery,
        )
    assert exc.value.category == "issuer_mismatch"

    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(good, nonce="wrong-nonce", discovery=discovery)
    assert exc.value.category == "nonce_mismatch"

    import base64

    header = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').decode().rstrip("=")
    body = base64.urlsafe_b64encode(
        json.dumps(
            {
                "iss": ISSUER,
                "sub": "x",
                "aud": CLIENT_ID,
                "exp": 9999999999,
                "nonce": "n",
            }
        ).encode()
    ).decode().rstrip("=")
    none_token = f"{header}.{body}."
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(none_token, nonce="n", discovery=discovery)
    assert exc.value.category == "invalid_algorithm"


def test_existing_identity_mapping_and_exchange(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    user_id = _seed_local_user(SessionLocal, email="bound@example.com")
    with SessionLocal() as db:
        db.add(
            ExternalIdentity(
                user_id=user_id,
                issuer=ISSUER,
                subject="sub-bound",
                email_at_link="bound@example.com",
            )
        )
        db.commit()

    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(
        private_pem, sub="sub-bound", nonce=nonce, email="bound@example.com"
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    callback = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    loc = callback.headers["location"]
    assert loc.startswith("/login/oidc/callback?")
    code = parse_qs(urlparse(loc).query)["code"][0]
    assert parse_qs(urlparse(loc).query)["return_to"][0] == "/"

    exchanged = client.post("/api/v1/auth/oidc/exchange", json={"code": code})
    assert exchanged.status_code == 200
    body = exchanged.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "bound@example.com"
    assert "access_token" in body

    replay = client.post("/api/v1/auth/oidc/exchange", json={"code": code})
    assert replay.status_code == 400


def test_verified_email_links_existing_user(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    user_id = _seed_local_user(SessionLocal, email="linkme@example.com")
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(
        private_pem,
        sub="sub-link",
        nonce=nonce,
        email="linkme@example.com",
        email_verified=True,
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    callback = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    with SessionLocal() as db:
        identity = db.scalar(
            select(ExternalIdentity).where(ExternalIdentity.subject == "sub-link")
        )
        assert identity is not None
        assert identity.user_id == user_id
        audits = db.scalars(
            select(AuditLog).where(AuditLog.action == "auth.oidc.link")
        ).all()
        assert audits
        blob = json.dumps(
            [
                {
                    "a": a.action,
                    "b": a.before_summary,
                    "c": a.after_summary,
                    "f": a.failure_reason,
                }
                for a in audits
            ]
        ).lower()
        assert "test-secret" not in blob
        assert "access_token" not in blob
        assert "id_token" not in blob


def test_unverified_email_cannot_auto_link(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    _seed_local_user(SessionLocal, email="nolink@example.com")
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(
        private_pem,
        sub="sub-unverified",
        nonce=nonce,
        email="nolink@example.com",
        email_verified=False,
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    callback = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    assert "oidc_error=" in callback.headers["location"]
    with SessionLocal() as db:
        assert (
            db.scalar(
                select(ExternalIdentity).where(
                    ExternalIdentity.subject == "sub-unverified"
                )
            )
            is None
        )


def test_jit_provision_disabled_and_enabled(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(
        private_pem, sub="sub-new", nonce=nonce, email="new@example.com"
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    monkeypatch.setattr(settings, "oidc_auto_provision", False)
    denied = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert "oidc_error=" in denied.headers["location"]

    monkeypatch.setattr(settings, "oidc_auto_provision", True)
    start2 = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query2 = parse_qs(urlparse(start2.headers["location"]).query)
    state2, nonce2 = query2["state"][0], query2["nonce"][0]
    token2 = _mint_id_token(
        private_pem,
        sub="sub-jit",
        nonce=nonce2,
        email="jit@example.com",
        extra={"groups": ["admins"], "roles": ["SYSTEM_ADMIN"], "admin": True},
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token2, "access_token": "atk"},
    )
    ok = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state2},
        follow_redirects=False,
    )
    assert ok.status_code == 302
    assert "/login/oidc/callback" in ok.headers["location"]
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "jit@example.com"))
        assert user is not None
        assert user.is_system_admin is False
        assert user.local_login_enabled is False
        assert user.is_active is True


def test_inactive_user_rejected(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    user_id = _seed_local_user(
        SessionLocal, email="dead@example.com", is_active=False
    )
    with SessionLocal() as db:
        db.add(
            ExternalIdentity(
                user_id=user_id, issuer=ISSUER, subject="sub-dead", email_at_link="dead@example.com"
            )
        )
        db.commit()
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(private_pem, sub="sub-dead", nonce=nonce, email="dead@example.com")
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    response = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert "oidc_error=" in response.headers["location"]


def test_local_login_and_bootstrap_regression(client, oidc_db):
    SessionLocal, _ = oidc_db
    _seed_local_user(
        SessionLocal,
        email="admin@localhost.local",
        password="BreakGlass123!",
        is_system_admin=True,
    )
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@localhost.local", "password": "BreakGlass123!"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["is_system_admin"] is True

    # SSO-only user cannot use password login.
    with SessionLocal() as db:
        db.add(
            User(
                email="ssoonly@example.com",
                full_name="SSO",
                password_hash=hash_password("UnusedPass123!"),
                local_login_enabled=False,
                is_active=True,
            )
        )
        db.commit()
    denied = client.post(
        "/api/v1/auth/login",
        json={"email": "ssoonly@example.com", "password": "UnusedPass123!"},
    )
    assert denied.status_code == 401


def test_rbac_and_logout_token_version(client, oidc_db):
    SessionLocal, _ = oidc_db
    with SessionLocal() as db:
        user = User(
            email="rbac@example.com",
            full_name="RBAC",
            password_hash=hash_password("Password123!"),
            is_active=True,
            local_login_enabled=True,
        )
        db.add(user)
        db.flush()
        project = Project(name="oidc-rbac", description="")
        db.add(project)
        db.flush()
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=user.id, role=ProjectRole.VIEWER
            )
        )
        db.commit()
        user_id = user.id
        project_id = project.id
        token = create_access_token(str(user_id), {"tv": 0})

    headers = {"Authorization": f"Bearer {token}"}
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    projects = client.get("/api/v1/projects", headers=headers)
    assert projects.status_code == 200
    assert any(p["id"] == project_id for p in projects.json())

    logout = client.post("/api/v1/auth/logout", headers=headers)
    assert logout.status_code == 200
    stale = client.get("/api/v1/auth/me", headers=headers)
    assert stale.status_code == 401


def test_token_exchange_failure(client, oidc_db, monkeypatch):
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    def boom(**kwargs):
        raise oidc_service.OidcError(
            "Sign-in could not be completed.", category="token_exchange_failed"
        )

    monkeypatch.setattr(oidc_service, "exchange_authorization_code", boom)
    response = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert "oidc_error=" in response.headers["location"]


def test_external_return_rejected_on_start(client, oidc_db):
    response = client.get(
        "/api/v1/auth/oidc/start",
        params={"return_to": "https://evil.example"},
        follow_redirects=False,
    )
    assert response.status_code == 400


def test_provider_error_requires_valid_state(client, oidc_db):
    missing = client.get(
        "/api/v1/auth/oidc/callback",
        params={"error": "access_denied"},
        follow_redirects=False,
    )
    assert missing.status_code == 302
    assert "oidc_error=" in missing.headers["location"]
    # Sanitized — no raw provider error echoed.
    assert "access_denied" not in missing.headers["location"]

    wrong = client.get(
        "/api/v1/auth/oidc/callback",
        params={"error": "access_denied", "state": "not-a-real-state"},
        follow_redirects=False,
    )
    assert wrong.status_code == 302
    assert "oidc_error=" in wrong.headers["location"]

    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    ok = client.get(
        "/api/v1/auth/oidc/callback",
        params={"error": "access_denied", "state": state},
        follow_redirects=False,
    )
    assert ok.status_code == 302
    assert "cancelled or denied" in parse_qs(urlparse(ok.headers["location"]).query).get(
        "oidc_error", [""]
    )[0].lower() or "cancelled" in ok.headers["location"].lower()

    # Consumed state cannot be reused (provider error or success).
    replay = client.get(
        "/api/v1/auth/oidc/callback",
        params={"error": "access_denied", "state": state},
        follow_redirects=False,
    )
    assert replay.status_code == 302
    assert "oidc_error=" in replay.headers["location"]


def test_sequential_callback_replay_rejected(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    user_id = _seed_local_user(SessionLocal, email="replay@example.com")
    with SessionLocal() as db:
        db.add(
            ExternalIdentity(
                user_id=user_id,
                issuer=ISSUER,
                subject="sub-replay",
                email_at_link="replay@example.com",
            )
        )
        db.commit()
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(
        private_pem, sub="sub-replay", nonce=nonce, email="replay@example.com"
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    first = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert first.status_code == 302
    assert "/login/oidc/callback" in first.headers["location"]
    second = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert second.status_code == 302
    assert "/login?" in second.headers["location"]
    assert "oidc_error=" in second.headers["location"]


def test_exact_issuer_trailing_slash_success(client, oidc_db, monkeypatch):
    SessionLocal, private_pem = oidc_db
    slash_issuer = "https://idp.test.example/"
    monkeypatch.setattr(settings, "oidc_issuer", slash_issuer)
    user_id = _seed_local_user(SessionLocal, email="slash@example.com")
    with SessionLocal() as db:
        db.add(
            ExternalIdentity(
                user_id=user_id,
                issuer=slash_issuer,
                subject="sub-slash",
                email_at_link="slash@example.com",
            )
        )
        db.commit()
    start = client.get("/api/v1/auth/oidc/start", follow_redirects=False)
    query = parse_qs(urlparse(start.headers["location"]).query)
    state, nonce = query["state"][0], query["nonce"][0]
    token = _mint_id_token(
        private_pem,
        sub="sub-slash",
        nonce=nonce,
        email="slash@example.com",
        iss=slash_issuer,
    )
    monkeypatch.setattr(
        oidc_service,
        "exchange_authorization_code",
        lambda **kwargs: {"id_token": token, "access_token": "atk"},
    )
    callback = client.get(
        "/api/v1/auth/oidc/callback",
        params={"code": "c", "state": state},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    assert "/login/oidc/callback" in callback.headers["location"]


def test_configured_discovered_issuer_slash_mismatch_fails(oidc_db, monkeypatch):
    """Configured issuer without trailing slash must not match discovered with slash."""

    monkeypatch.setattr(settings, "oidc_issuer", "https://idp.test.example")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                json={
                    "issuer": "https://idp.test.example/",
                    "authorization_endpoint": "https://idp.test.example/authorize",
                    "token_endpoint": "https://idp.test.example/token",
                    "jwks_uri": "https://idp.test.example/jwks",
                },
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)

    def client_factory() -> httpx.Client:
        return httpx.Client(
            transport=transport,
            timeout=2.0,
            follow_redirects=False,
            trust_env=False,
        )

    monkeypatch.setattr(oidc_service, "_http_client", client_factory)
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.fetch_discovery()
    assert exc.value.category == "issuer_mismatch"


def test_id_token_iss_slash_mismatch_fails(oidc_db, rsa_keys, monkeypatch):
    _, private_pem = oidc_db
    monkeypatch.setattr(settings, "oidc_issuer", "https://idp.test.example")
    discovery = {
        "issuer": "https://idp.test.example",
        "authorization_endpoint": "https://idp.test.example/authorize",
        "token_endpoint": "https://idp.test.example/token",
        "jwks_uri": "https://idp.test.example/jwks",
    }
    token = _mint_id_token(
        private_pem,
        sub="sub-1",
        nonce="n",
        iss="https://idp.test.example/",
    )
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(token, nonce="n", discovery=discovery)
    assert exc.value.category == "issuer_mismatch"


def test_es_algorithms_not_in_allowlist():
    assert "ES256" not in oidc_service.ALLOWED_ID_TOKEN_ALGS
    assert oidc_service.ALLOWED_ID_TOKEN_ALGS == ("RS256", "RS384", "RS512")


def test_discovery_url_construction_preserves_issuer_identity():
    assert (
        oidc_service.discovery_document_url("https://idp.example.com")
        == "https://idp.example.com/.well-known/openid-configuration"
    )
    assert (
        oidc_service.discovery_document_url("https://idp.example.com/")
        == "https://idp.example.com/.well-known/openid-configuration"
    )


def test_id_token_audience_string_client_id_passes(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem, sub="sub-aud", nonce="n", aud=CLIENT_ID
    )
    claims = oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert claims.subject == "sub-aud"


def test_id_token_audience_single_element_list_passes(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem, sub="sub-aud-list", nonce="n", aud=[CLIENT_ID]
    )
    claims = oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert claims.subject == "sub-aud-list"


def test_id_token_audience_multi_rejects_extra_client(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem,
        sub="sub-multi",
        nonce="n",
        aud=[CLIENT_ID, "other-client"],
    )
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert exc.value.category == "audience_mismatch"


def test_id_token_audience_other_only_fails(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem, sub="sub-other", nonce="n", aud=["other-client"]
    )
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert exc.value.category == "audience_mismatch"


def test_id_token_audience_malformed_fails(oidc_db):
    _, private_pem = oidc_db
    for bad_aud in (123, [], [CLIENT_ID, 1], {"client": CLIENT_ID}):
        token = _mint_id_token(
            private_pem, sub="sub-bad-aud", nonce="n", aud=bad_aud  # type: ignore[arg-type]
        )
        with pytest.raises(oidc_service.OidcError) as exc:
            oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
        assert exc.value.category == "audience_mismatch", bad_aud


def test_id_token_azp_absent_with_valid_audience_passes(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem, sub="sub-no-azp", nonce="n", aud=CLIENT_ID
    )
    assert "azp" not in jwt.decode(
        token, options={"verify_signature": False}
    )
    claims = oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert claims.subject == "sub-no-azp"


def test_id_token_azp_matches_client_id_passes(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem,
        sub="sub-azp-ok",
        nonce="n",
        aud=CLIENT_ID,
        azp=CLIENT_ID,
    )
    claims = oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert claims.subject == "sub-azp-ok"


def test_id_token_azp_mismatch_fails(oidc_db):
    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem,
        sub="sub-azp-bad",
        nonce="n",
        aud=CLIENT_ID,
        azp="other-client",
    )
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert exc.value.category == "authorized_party_mismatch"


def test_id_token_azp_cannot_rescue_multi_audience(oidc_db):
    """azp matching client_id must not allow additional untrusted audiences."""

    _, private_pem = oidc_db
    token = _mint_id_token(
        private_pem,
        sub="sub-azp-multi",
        nonce="n",
        aud=[CLIENT_ID, "other-client"],
        azp=CLIENT_ID,
    )
    with pytest.raises(oidc_service.OidcError) as exc:
        oidc_service.validate_id_token(token, nonce="n", discovery=_discovery())
    assert exc.value.category == "audience_mismatch"
