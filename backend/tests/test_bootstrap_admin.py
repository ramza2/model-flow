from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from app.api.v1 import auth


class _BootstrapRaceSession:
    def __init__(self, resolved_user_id: int | None):
        self.scalar_calls = 0
        self.rollback_calls = 0
        self.closed = False
        self.resolved_user_id = resolved_user_id

    def scalar(self, _statement):
        self.scalar_calls += 1
        if self.scalar_calls <= 2:
            return None
        return self.resolved_user_id

    def add(self, _value):
        return None

    def flush(self):
        raise IntegrityError("INSERT users", {}, Exception("unique email"))

    def rollback(self):
        self.rollback_calls += 1

    def close(self):
        self.closed = True


def test_bootstrap_admin_treats_concurrent_unique_winner_as_success(monkeypatch):
    session = _BootstrapRaceSession(resolved_user_id=42)
    monkeypatch.setattr(auth, "SessionLocal", lambda: session)
    monkeypatch.setattr(auth.settings, "bootstrap_admin_email", "admin@example.com")
    monkeypatch.setattr(auth.settings, "bootstrap_admin_password", "bootstrap-password")
    monkeypatch.setattr(auth, "hash_password", lambda _value: "hashed")

    auth.bootstrap_admin()

    assert session.rollback_calls == 1
    assert session.scalar_calls == 3
    assert session.closed is True


def test_bootstrap_admin_reraises_unresolved_integrity_error(monkeypatch):
    session = _BootstrapRaceSession(resolved_user_id=None)
    monkeypatch.setattr(auth, "SessionLocal", lambda: session)
    monkeypatch.setattr(auth.settings, "bootstrap_admin_email", "admin@example.com")
    monkeypatch.setattr(auth.settings, "bootstrap_admin_password", "bootstrap-password")
    monkeypatch.setattr(auth, "hash_password", lambda _value: "hashed")

    with pytest.raises(IntegrityError):
        auth.bootstrap_admin()

    assert session.rollback_calls == 1
    assert session.closed is True
