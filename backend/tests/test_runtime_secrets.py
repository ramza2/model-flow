import os
import pytest

from app.core.config import Settings
from app.core.runtime_secrets import configure_object_store_library_environment


def test_file_mounted_object_store_credentials_reach_mlflow_environment(
    monkeypatch, tmp_path
):
    access_file = tmp_path / "access-key"
    secret_file = tmp_path / "secret-key"
    access_file.write_text("file-access\n", encoding="utf-8")
    secret_file.write_text("file-secret\n", encoding="utf-8")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "stale-access")
    monkeypatch.setenv("MINIO_SECRET_KEY", "stale-secret")
    monkeypatch.setenv("MINIO_ACCESS_KEY_FILE", str(access_file))
    monkeypatch.setenv("MINIO_SECRET_KEY_FILE", str(secret_file))
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "stale-aws-access")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "stale-aws-secret")
    monkeypatch.setenv("MLFLOW_S3_ENDPOINT_URL", "http://stale-endpoint")

    config = Settings(
        _env_file=None,
        minio_endpoint="object-store.internal:9443",
        minio_secure=True,
    )
    configure_object_store_library_environment(config)

    assert config.minio_access_key == "file-access"
    assert config.minio_secret_key == "file-secret"
    assert os.environ.get("AWS_ACCESS_KEY_ID") == "file-access"
    assert os.environ.get("AWS_SECRET_ACCESS_KEY") == "file-secret"
    assert (
        os.environ.get("MLFLOW_S3_ENDPOINT_URL")
        == "https://object-store.internal:9443"
    )


def test_object_store_library_environment_rejects_partial_credentials(monkeypatch):
    config = Settings(
        _env_file=None,
        minio_access_key="access-only",
        minio_secret_key="",
    )

    with pytest.raises(
        RuntimeError,
        match="MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be configured together",
    ):
        configure_object_store_library_environment(config)


def test_empty_object_store_credentials_do_not_overwrite_library_environment(
    monkeypatch,
):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "existing-access")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "existing-secret")
    monkeypatch.setenv("MLFLOW_S3_ENDPOINT_URL", "http://existing-endpoint")
    config = Settings(
        _env_file=None,
        minio_access_key="",
        minio_secret_key="",
    )

    configure_object_store_library_environment(config)

    assert os.environ.get("AWS_ACCESS_KEY_ID") == "existing-access"
    assert os.environ.get("AWS_SECRET_ACCESS_KEY") == "existing-secret"
    assert os.environ.get("MLFLOW_S3_ENDPOINT_URL") == "http://existing-endpoint"
