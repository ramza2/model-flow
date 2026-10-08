"""PostgreSQL-authoritative OIDC concurrency tests (Phase 8-C).

Skipped on non-PostgreSQL dialects (Fast Gate SQLite hosts). Full
``./scripts/verify.sh`` runs these against Postgres.
"""

from __future__ import annotations

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.core.security import encrypt_secret, hash_password
from app.db.models import OidcLoginTransaction, User
from app.services import oidc as oidc_service
from app.services.oidc import OidcError


def _is_postgres_url(url: str) -> bool:
    return url.startswith("postgresql")


pytestmark = pytest.mark.skipif(
    not _is_postgres_url(settings.database_url),
    reason="PostgreSQL required for OIDC FOR UPDATE concurrency proofs",
)


@pytest.fixture
def pg_engine(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", settings.secret_key or ("a" * 64))
    if not settings.secret_key.strip():
        monkeypatch.setattr(settings, "secret_key", "a" * 64)
    engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=6)
    yield engine
    engine.dispose()


def _seed_exchange_ready_row(SessionLocal) -> tuple[str, int]:
    """Insert a transaction that already has an unused exchange code."""

    plaintext = oidc_service._b64url_no_pad(uuid.uuid4().bytes + uuid.uuid4().bytes)
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        user = User(
            email=f"oidc-race-{uuid.uuid4().hex[:10]}@example.com",
            full_name="Race",
            password_hash=hash_password(uuid.uuid4().hex),
            is_active=True,
            local_login_enabled=False,
        )
        db.add(user)
        db.flush()
        row = OidcLoginTransaction(
            id=str(uuid.uuid4()),
            state_hash=oidc_service._sha256_hex(uuid.uuid4().hex),
            nonce_encrypted=encrypt_secret("nonce"),
            code_verifier_encrypted=encrypt_secret("verifier"),
            return_to="/",
            expires_at=now + timedelta(minutes=10),
            consumed_at=now,
            exchange_code_hash=oidc_service._sha256_hex(plaintext),
            exchange_expires_at=now + timedelta(minutes=5),
            exchange_consumed_at=None,
            user_id=user.id,
        )
        db.add(row)
        db.commit()
        return plaintext, user.id


def test_postgres_concurrent_exchange_exactly_one_success(pg_engine):
    SessionLocal = sessionmaker(bind=pg_engine, autocommit=False, autoflush=False)
    code, _user_id = _seed_exchange_ready_row(SessionLocal)
    barrier = threading.Barrier(2)
    outcomes: list[str] = []
    lock = threading.Lock()

    def race() -> None:
        db = SessionLocal()
        try:
            barrier.wait(timeout=10)
            try:
                oidc_service.consume_exchange_code(db, code)
                db.commit()
                with lock:
                    outcomes.append("success")
            except OidcError as exc:
                db.rollback()
                with lock:
                    outcomes.append(exc.category)
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(race), pool.submit(race)]
        for future in futures:
            future.result(timeout=20)

    assert outcomes.count("success") == 1
    assert len(outcomes) == 2
    assert set(outcomes) - {"success"} <= {"exchange_replay", "exchange_invalid"}
    # Exactly one ModelFlow token issuance path succeeded.
    assert sum(1 for item in outcomes if item == "success") == 1


def test_postgres_concurrent_state_claim_exactly_one(pg_engine):
    SessionLocal = sessionmaker(bind=pg_engine, autocommit=False, autoflush=False)
    state = oidc_service._b64url_no_pad(uuid.uuid4().bytes)
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.add(
            OidcLoginTransaction(
                id=str(uuid.uuid4()),
                state_hash=oidc_service._sha256_hex(state),
                nonce_encrypted=encrypt_secret("nonce"),
                code_verifier_encrypted=encrypt_secret("verifier"),
                return_to="/",
                expires_at=now + timedelta(minutes=10),
                consumed_at=None,
            )
        )
        db.commit()

    barrier = threading.Barrier(2)
    outcomes: list[str] = []
    lock = threading.Lock()

    def race() -> None:
        db = SessionLocal()
        try:
            barrier.wait(timeout=10)
            try:
                oidc_service._claim_transaction_by_state(db, state, mark_consumed=True)
                db.commit()
                with lock:
                    outcomes.append("success")
            except OidcError as exc:
                db.rollback()
                with lock:
                    outcomes.append(exc.category)
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(race), pool.submit(race)]
        for future in futures:
            future.result(timeout=20)

    assert outcomes.count("success") == 1
    assert outcomes.count("callback_replay") == 1

    with SessionLocal() as db:
        row = db.scalar(
            select(OidcLoginTransaction).where(
                OidcLoginTransaction.state_hash == oidc_service._sha256_hex(state)
            )
        )
        assert row is not None
        assert row.consumed_at is not None


def test_postgres_sequential_exchange_replay_still_rejected(pg_engine):
    SessionLocal = sessionmaker(bind=pg_engine, autocommit=False, autoflush=False)
    code, _ = _seed_exchange_ready_row(SessionLocal)
    with SessionLocal() as db:
        user = oidc_service.consume_exchange_code(db, code)
        db.commit()
        assert user.id is not None
    with SessionLocal() as db:
        with pytest.raises(OidcError) as exc:
            oidc_service.consume_exchange_code(db, code)
        assert exc.value.category == "exchange_replay"
