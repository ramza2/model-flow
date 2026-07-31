from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class ProjectOut(BaseModel):
    id: int
    name: str
    description: str
    created_at: datetime

    model_config = {"from_attributes": True}


class DatasetOut(BaseModel):
    id: int
    project_id: int
    name: str
    object_key: str
    row_count: int
    column_count: int
    columns: list[str]
    stats: dict[str, Any]
    created_at: datetime


class JobCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: int
    target_column: str
    algorithm: str = "random_forest"
    hyperparameters: dict[str, Any] = Field(default_factory=dict)


class JobOut(BaseModel):
    id: int
    project_id: int
    dataset_id: int
    name: str
    target_column: str
    algorithm: str
    hyperparameters: dict[str, Any]
    status: str
    logs: str
    mlflow_run_id: str | None
    model_uri: str | None
    metrics: dict[str, Any]
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class RunOut(BaseModel):
    run_id: str
    experiment_id: str
    status: str
    start_time: int | None
    end_time: int | None
    params: dict[str, str]
    metrics: dict[str, float]
    artifact_uri: str | None
    tags: dict[str, str]


class ModelVersionOut(BaseModel):
    name: str
    version: str
    status: str
    run_id: str | None
    source: str | None
    creation_timestamp: int | None


class RegisteredModelOut(BaseModel):
    name: str
    latest_versions: list[ModelVersionOut]


class RegisterModelRequest(BaseModel):
    run_id: str
    model_name: str = Field(min_length=1, max_length=200)
    artifact_path: str = "model"


class EndpointCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    model_name: str
    model_version: str


class EndpointOut(BaseModel):
    id: int
    project_id: int
    name: str
    model_name: str
    model_version: str
    model_uri: str
    status: str
    request_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


class PredictRequest(BaseModel):
    instances: list[dict[str, Any]]


class PredictResponse(BaseModel):
    predictions: list[Any]
    model_uri: str


class SystemStatus(BaseModel):
    api: str
    database: str
    minio: str
    mlflow: str
    pending_jobs: int
    running_jobs: int


class DashboardStats(BaseModel):
    projects: int
    datasets: int
    jobs: int
    endpoints: int
    succeeded_jobs: int
    failed_jobs: int


class ErrorBody(BaseModel):
    detail: str
    hint: str | None = None
