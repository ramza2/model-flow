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
