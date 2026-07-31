from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "ModelFlow"
    database_url: str = "postgresql+psycopg2://modelflow:modelflow@localhost:5432/modelflow"
    mlflow_tracking_uri: str = "http://localhost:5000"
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    minio_datasets_bucket: str = "datasets"
    minio_mlflow_bucket: str = "mlflow"
    worker_poll_seconds: float = 2.0
    cors_origins: str = "http://localhost:5173,http://localhost:3000,http://localhost"


settings = Settings()
