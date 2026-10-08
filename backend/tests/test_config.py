import pytest

from app.core.config import INSECURE_SECRET_KEYS, Settings, validate_security_settings


@pytest.mark.parametrize("secret_key", ["", *sorted(INSECURE_SECRET_KEYS)])
def test_security_validation_rejects_missing_and_known_defaults(secret_key):
    config = Settings(_env_file=None, MODELFLOW_SECRET_KEY=secret_key)

    with pytest.raises(RuntimeError, match="known insecure default"):
        validate_security_settings(config)


def test_security_validation_accepts_generated_secret():
    config = Settings(_env_file=None, MODELFLOW_SECRET_KEY="a" * 96)

    validate_security_settings(config)


def test_oidc_enabled_requires_issuer_client_secret_redirect():
    config = Settings(
        _env_file=None,
        MODELFLOW_SECRET_KEY="a" * 96,
        MODELFLOW_OIDC_ENABLED=True,
        MODELFLOW_OIDC_ISSUER="",
        MODELFLOW_OIDC_CLIENT_ID="client",
        MODELFLOW_OIDC_CLIENT_SECRET="secret",
        MODELFLOW_OIDC_REDIRECT_URI="http://localhost/callback",
    )
    with pytest.raises(RuntimeError, match="MODELFLOW_OIDC_ISSUER"):
        validate_security_settings(config)

    config = Settings(
        _env_file=None,
        MODELFLOW_SECRET_KEY="a" * 96,
        MODELFLOW_OIDC_ENABLED=True,
        MODELFLOW_OIDC_ISSUER="https://idp.example.com",
        MODELFLOW_OIDC_CLIENT_ID="",
        MODELFLOW_OIDC_CLIENT_SECRET="secret",
        MODELFLOW_OIDC_REDIRECT_URI="http://localhost/callback",
    )
    with pytest.raises(RuntimeError, match="MODELFLOW_OIDC_CLIENT_ID"):
        validate_security_settings(config)

    config = Settings(
        _env_file=None,
        MODELFLOW_SECRET_KEY="a" * 96,
        MODELFLOW_OIDC_ENABLED=True,
        MODELFLOW_OIDC_ISSUER="https://idp.example.com",
        MODELFLOW_OIDC_CLIENT_ID="client",
        MODELFLOW_OIDC_CLIENT_SECRET="",
        MODELFLOW_OIDC_REDIRECT_URI="http://localhost/callback",
    )
    with pytest.raises(RuntimeError, match="MODELFLOW_OIDC_CLIENT_SECRET") as exc:
        validate_security_settings(config)
    assert "secret-value" not in str(exc.value).lower()

    config = Settings(
        _env_file=None,
        MODELFLOW_SECRET_KEY="a" * 96,
        MODELFLOW_OIDC_ENABLED=True,
        MODELFLOW_OIDC_ISSUER="https://idp.example.com",
        MODELFLOW_OIDC_CLIENT_ID="client",
        MODELFLOW_OIDC_CLIENT_SECRET="secret",
        MODELFLOW_OIDC_REDIRECT_URI="",
    )
    with pytest.raises(RuntimeError, match="MODELFLOW_OIDC_REDIRECT_URI"):
        validate_security_settings(config)


def test_oidc_disabled_startup_unaffected_by_missing_oidc_settings():
    config = Settings(
        _env_file=None,
        MODELFLOW_SECRET_KEY="a" * 96,
        MODELFLOW_OIDC_ENABLED=False,
        MODELFLOW_OIDC_ISSUER="",
        MODELFLOW_OIDC_CLIENT_ID="",
        MODELFLOW_OIDC_CLIENT_SECRET="",
        MODELFLOW_OIDC_REDIRECT_URI="",
    )
    validate_security_settings(config)


def test_oidc_enabled_accepts_complete_configuration():
    config = Settings(
        _env_file=None,
        MODELFLOW_SECRET_KEY="a" * 96,
        MODELFLOW_OIDC_ENABLED=True,
        MODELFLOW_OIDC_ISSUER="https://idp.example.com/",
        MODELFLOW_OIDC_CLIENT_ID="client",
        MODELFLOW_OIDC_CLIENT_SECRET="secret",
        MODELFLOW_OIDC_REDIRECT_URI="http://localhost/callback",
    )
    validate_security_settings(config)
