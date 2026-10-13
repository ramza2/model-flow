"""File-mounted secret loading for ModelFlow settings.

The application uses a vendor-neutral `<ENV_NAME>_FILE` convention.  When a
supported *_FILE variable is set, its UTF-8 file content overrides the normal
environment/.env value for that setting.  Explicit Settings(...) constructor
values remain highest precedence so tests and callers can still inject values
without reading ambient files.

Secret file contents are read once at Settings construction time.  Runtime
rotation therefore requires restarting the dependent service.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

MAX_SECRET_FILE_BYTES = 64 * 1024

# env name -> (Settings input key, explicit constructor keys)
#
# Keep this allowlist narrow: *_FILE must never become an arbitrary environment
# to filesystem indirection primitive.
FILE_SECRET_SPECS: dict[str, tuple[str, frozenset[str]]] = {
    "DATABASE_URL": (
        "database_url",
        frozenset({"database_url", "DATABASE_URL"}),
    ),
    "MINIO_ACCESS_KEY": (
        "minio_access_key",
        frozenset({"minio_access_key", "MINIO_ACCESS_KEY"}),
    ),
    "MINIO_SECRET_KEY": (
        "minio_secret_key",
        frozenset({"minio_secret_key", "MINIO_SECRET_KEY"}),
    ),
    "MODELFLOW_SECRET_KEY": (
        "MODELFLOW_SECRET_KEY",
        frozenset({"secret_key", "MODELFLOW_SECRET_KEY", "SECRET_KEY"}),
    ),
    "MODELFLOW_ENCRYPTION_KEY": (
        "MODELFLOW_ENCRYPTION_KEY",
        frozenset(
            {"encryption_key", "MODELFLOW_ENCRYPTION_KEY", "ENCRYPTION_KEY"}
        ),
    ),
    "MODELFLOW_INFERENCE_SERVICE_TOKEN": (
        "MODELFLOW_INFERENCE_SERVICE_TOKEN",
        frozenset(
            {
                "inference_service_token",
                "MODELFLOW_INFERENCE_SERVICE_TOKEN",
                "INFERENCE_SERVICE_TOKEN",
            }
        ),
    ),
    "MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD": (
        "MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD",
        frozenset(
            {
                "bootstrap_admin_password",
                "MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD",
                "BOOTSTRAP_ADMIN_PASSWORD",
            }
        ),
    ),
    "MODELFLOW_OIDC_CLIENT_SECRET": (
        "MODELFLOW_OIDC_CLIENT_SECRET",
        frozenset(
            {
                "oidc_client_secret",
                "MODELFLOW_OIDC_CLIENT_SECRET",
                "OIDC_CLIENT_SECRET",
            }
        ),
    ),
    "MODELFLOW_LLM_API_KEY": (
        "MODELFLOW_LLM_API_KEY",
        frozenset({"llm_api_key", "MODELFLOW_LLM_API_KEY", "LLM_API_KEY"}),
    ),
}

SUPPORTED_FILE_SECRET_ENV_VARS = frozenset(FILE_SECRET_SPECS)


def _read_secret_file(file_env_name: str, path: str) -> str:
    """Read one bounded UTF-8 secret without exposing its path or value."""

    try:
        with open(path, "rb") as handle:
            payload = handle.read(MAX_SECRET_FILE_BYTES + 1)
    except OSError:
        raise RuntimeError(
            f"{file_env_name} is configured but its secret file cannot be read."
        ) from None

    if len(payload) > MAX_SECRET_FILE_BYTES:
        raise RuntimeError(
            f"{file_env_name} secret file exceeds the {MAX_SECRET_FILE_BYTES}-byte limit."
        )

    try:
        value = payload.decode("utf-8")
    except UnicodeDecodeError:
        raise RuntimeError(f"{file_env_name} secret file must contain UTF-8 text.") from None

    # Docker/Kubernetes/Vault-style mounted secrets commonly end with one or more
    # newline characters.  Do not strip other whitespace from a credential.
    value = value.rstrip("\r\n")
    if not value:
        raise RuntimeError(f"{file_env_name} secret file is empty.")
    if "\x00" in value:
        raise RuntimeError(f"{file_env_name} secret file contains invalid NUL bytes.")
    return value


def load_file_secret_overrides(
    explicit_values: Mapping[str, Any] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return Settings constructor overrides sourced from supported secret files.

    Runtime precedence is:
      explicit Settings(...) input > *_FILE > environment > .env > defaults.

    If a *_FILE variable is present, read errors fail closed instead of silently
    falling back to a potentially stale environment value.
    """

    explicit_keys = set((explicit_values or {}).keys())
    source = os.environ if environ is None else environ
    overrides: dict[str, str] = {}

    for env_name, (input_key, constructor_keys) in FILE_SECRET_SPECS.items():
        file_env_name = f"{env_name}_FILE"
        path = source.get(file_env_name)
        if path is None or not path.strip():
            continue
        if explicit_keys.intersection(constructor_keys):
            continue
        overrides[input_key] = _read_secret_file(file_env_name, path)

    return overrides
