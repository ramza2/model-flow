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


@pytest.mark.parametrize(
    ("env_name", "field_name", "file_value"),
    [
        ("DATABASE_URL", "database_url", "postgresql+psycopg2://file-user:file-pass@db/app"),
        ("MINIO_ACCESS_KEY", "minio_access_key", "file-access"),
        ("MINIO_SECRET_KEY", "minio_secret_key", "file-secret"),
        ("MODELFLOW_SECRET_KEY", "secret_key", "f" * 96),
        ("MODELFLOW_ENCRYPTION_KEY", "encryption_key", "file-fernet-key"),
        ("MODELFLOW_INFERENCE_SERVICE_TOKEN", "inference_service_token", "i" * 48),
        (
            "MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD",
            "bootstrap_admin_password",
            "bootstrap-from-file",
        ),
        ("MODELFLOW_OIDC_CLIENT_SECRET", "oidc_client_secret", "oidc-from-file"),
        ("MODELFLOW_LLM_API_KEY", "llm_api_key", "llm-from-file"),
    ],
)
def test_supported_file_secret_overrides_environment(
    monkeypatch, tmp_path, env_name, field_name, file_value
):
    secret_file = tmp_path / env_name.lower()
    secret_file.write_text(file_value + "\n", encoding="utf-8")
    monkeypatch.setenv(env_name, "environment-value")
    monkeypatch.setenv(f"{env_name}_FILE", str(secret_file))

    config = Settings(_env_file=None)

    assert getattr(config, field_name) == file_value


def test_explicit_settings_value_overrides_file_secret(monkeypatch, tmp_path):
    secret_file = tmp_path / "secret-key"
    secret_file.write_text("file-secret\n", encoding="utf-8")
    monkeypatch.setenv("MODELFLOW_SECRET_KEY_FILE", str(secret_file))

    config = Settings(_env_file=None, MODELFLOW_SECRET_KEY="constructor-secret")

    assert config.secret_key == "constructor-secret"


def test_file_secret_read_failure_is_fail_closed_and_redacted(monkeypatch, tmp_path):
    missing_path = tmp_path / "do-not-render-this-path"
    monkeypatch.setenv("MODELFLOW_SECRET_KEY", "environment-fallback-must-not-win")
    monkeypatch.setenv("MODELFLOW_SECRET_KEY_FILE", str(missing_path))

    with pytest.raises(RuntimeError, match="MODELFLOW_SECRET_KEY_FILE") as exc:
        Settings(_env_file=None)

    assert str(missing_path) not in str(exc.value)
    assert "environment-fallback-must-not-win" not in str(exc.value)


def test_empty_file_secret_is_rejected(monkeypatch, tmp_path):
    secret_file = tmp_path / "empty-secret"
    secret_file.write_text("\n", encoding="utf-8")
    monkeypatch.setenv("MODELFLOW_LLM_API_KEY_FILE", str(secret_file))

    with pytest.raises(RuntimeError, match="MODELFLOW_LLM_API_KEY_FILE secret file is empty"):
        Settings(_env_file=None)


def test_settings_repr_redacts_secret_values():
    values = {
        "database_url": "postgresql://db-user:db-secret@db/app",
        "minio_access_key": "access-secret",
        "minio_secret_key": "minio-secret",
        "MODELFLOW_SECRET_KEY": "jwt-secret",
        "MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD": "bootstrap-secret",
        "MODELFLOW_ENCRYPTION_KEY": "fernet-secret",
        "MODELFLOW_LLM_API_KEY": "llm-secret",
        "MODELFLOW_INFERENCE_SERVICE_TOKEN": "inference-secret",
        "MODELFLOW_OIDC_CLIENT_SECRET": "oidc-secret",
    }

    config = Settings(_env_file=None, **values)
    rendered = repr(config)
    serialized = config.model_dump()

    for value in values.values():
        assert value not in rendered
        assert value not in serialized.values()
