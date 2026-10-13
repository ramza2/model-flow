"""Runtime secret bridges for third-party libraries.

ModelFlow owns secret loading through Settings. Some libraries (notably MLflow's
S3 artifact repository / boto3) still resolve credentials from AWS-style process
environment variables. Keep that compatibility bridge in one place so a
file-mounted ModelFlow secret remains authoritative without leaking values to
logs or configuration serialization.
"""

from __future__ import annotations

import os

from app.core.config import Settings, settings


def configure_object_store_library_environment(config: Settings = settings) -> None:
    """Apply ModelFlow object-store settings to MLflow/boto3 process variables."""

    access_key = config.minio_access_key
    secret_key = config.minio_secret_key

    if bool(access_key) != bool(secret_key):
        raise RuntimeError(
            "MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be configured together."
        )

    if not access_key:
        return

    scheme = "https" if config.minio_secure else "http"
    os.environ["AWS_ACCESS_KEY_ID"] = access_key
    os.environ["AWS_SECRET_ACCESS_KEY"] = secret_key
    os.environ["AWS_DEFAULT_REGION"] = config.minio_region
    os.environ["MLFLOW_S3_ENDPOINT_URL"] = f"{scheme}://{config.minio_endpoint}"
