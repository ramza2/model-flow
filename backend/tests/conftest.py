import secrets

import pytest

from app.core.config import settings


@pytest.fixture(autouse=True)
def secure_test_signing_key(monkeypatch):
    """PyJWT 2.13 rejects empty HMAC keys even before application startup."""
    monkeypatch.setattr(settings, "secret_key", secrets.token_urlsafe(48))
