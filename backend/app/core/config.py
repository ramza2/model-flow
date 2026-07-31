from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "ModelFlow"
    app_version: str = "1.0.0-rc"
    database_url: str = "postgresql+psycopg2://modelflow:modelflow@localhost:5432/modelflow"
    mlflow_tracking_uri: str = "http://localhost:5000"
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    minio_datasets_bucket: str = "datasets"
    minio_mlflow_bucket: str = "mlflow"
    minio_batch_bucket: str = "batch-results"
    minio_artifacts_bucket: str = "artifacts"
    worker_poll_seconds: float = 2.0
    worker_id: str = "default"
    worker_heartbeat_max_age_seconds: int = 30
    worker_max_concurrent_jobs: int = 2
    cors_origins: str = "http://localhost:5173,http://localhost:3000,http://localhost"

    # Auth (never hardcode bootstrap password in code — set via env)
    secret_key: str = Field(
        default="dev-only-change-me-modelflow-secret-key-32b",
        validation_alias=AliasChoices("MODELFLOW_SECRET_KEY", "SECRET_KEY"),
    )
    access_token_expire_minutes: int = 480
    bootstrap_admin_email: str = Field(
        default="admin@modelflow.local",
        validation_alias=AliasChoices(
            "MODELFLOW_BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_EMAIL"
        ),
    )
    bootstrap_admin_password: str = Field(
        default="",  # required on first boot in compose
        validation_alias=AliasChoices(
            "MODELFLOW_BOOTSTRAP_ADMIN_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD"
        ),
    )
    login_max_failures: int = 5
    login_lockout_minutes: int = 15
    rate_limit_per_minute: int = 120

    # Crypto for data-source secrets (Fernet key); empty → derived from secret_key
    encryption_key: str = Field(
        default="",
        validation_alias=AliasChoices("MODELFLOW_ENCRYPTION_KEY", "ENCRYPTION_KEY"),
    )

    # Defaults
    store_inference_payloads: bool = False
    allow_train_on_quality_fail: bool = False
    max_upload_bytes: int = 100 * 1024 * 1024
    git_sha: str = "unknown"

    # Retention days (0 = keep forever)
    retention_training_logs_days: int = 90
    retention_inference_stats_days: int = 90
    retention_audit_logs_days: int = 365
    retention_batch_results_days: int = 30
    retention_archived_models_days: int = 180


settings = Settings()
