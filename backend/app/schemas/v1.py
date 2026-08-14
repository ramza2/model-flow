from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.db.models import AlertSeverity, DataSourceType, ProjectRole


class LoginRequest(BaseModel):
    # Login must accept the documented local bootstrap identity
    # (admin@localhost.local), which EmailStr rejects as a reserved TLD.
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=1024)


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=1024)
    full_name: str = Field(default="", max_length=200)
    is_system_admin: bool = False


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, max_length=200)
    is_active: bool | None = None
    is_system_admin: bool | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None


class MemberCreate(BaseModel):
    user_id: int | None = None
    email: EmailStr | None = None
    role: ProjectRole = ProjectRole.VIEWER

    @model_validator(mode="after")
    def identify_user(self) -> MemberCreate:
        if self.user_id is None and self.email is None:
            raise ValueError("Provide user_id or email")
        return self


class DataSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    source_type: DataSourceType
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, Any] = Field(default_factory=dict)


class DataSourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    config: dict[str, Any] | None = None
    secrets: dict[str, Any] | None = None
    is_active: bool | None = None


class DataImportRequest(BaseModel):
    dataset_name: str = Field(min_length=1, max_length=200)
    table_or_query: str = Field(min_length=1)


class QualityRuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: int
    rules: list[dict[str, Any]] = Field(default_factory=list)
    block_training_on_fail: bool = True
    is_active: bool = True


class QualityRuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    dataset_id: int | None = None
    rules: list[dict[str, Any]] | None = None
    block_training_on_fail: bool | None = None
    is_active: bool | None = None


class QualityRunRequest(BaseModel):
    quality_rule_id: int | None = None


class SplitCreate(BaseModel):
    name: str = Field(default="default", min_length=1, max_length=200)
    train_ratio: float = Field(default=0.7, gt=0, lt=1)
    val_ratio: float = Field(default=0.15, gt=0, lt=1)
    test_ratio: float = Field(default=0.15, gt=0, lt=1)
    random_seed: int = Field(default=42)

    @model_validator(mode="after")
    def ratios_sum_to_one(self) -> SplitCreate:
        if abs(self.train_ratio + self.val_ratio + self.test_ratio - 1.0) > 1e-6:
            raise ValueError("train_ratio, val_ratio and test_ratio must total 1")
        return self


class JobCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: int
    dataset_version_id: int | None = None
    split_id: int | None = None
    description: str = ""
    target_column: str = Field(min_length=1, max_length=200)
    problem_type: Literal["auto", "classification", "regression"] = "auto"
    algorithm: str = Field(default="random_forest", min_length=1, max_length=100)
    hyperparameters: dict[str, Any] = Field(default_factory=dict)
    preprocessing: dict[str, Any] = Field(default_factory=dict)
    feature_columns: list[str] = Field(default_factory=list)
    metrics_config: list[str] = Field(default_factory=list)
    resources: dict[str, Any] = Field(default_factory=dict)
    random_seed: int = 42
    train_ratio: float = Field(default=0.7, gt=0, lt=1)
    val_ratio: float = Field(default=0.15, ge=0, lt=1)
    test_ratio: float = Field(default=0.15, ge=0, lt=1)
    max_retries: int = Field(default=1, ge=0, le=10)

    @model_validator(mode="after")
    def ratios_sum_to_one(self) -> JobCreate:
        if abs(self.train_ratio + self.val_ratio + self.test_ratio - 1.0) > 1e-6:
            raise ValueError("train_ratio, val_ratio and test_ratio must total 1")
        return self


class JobCloneRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    overrides: dict[str, Any] = Field(default_factory=dict)


class PipelineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    graph: dict[str, Any] = Field(default_factory=lambda: {"nodes": [], "edges": []})
    is_template: bool = False


class PipelineUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    is_template: bool | None = None


class PipelineGraphRequest(BaseModel):
    graph: dict[str, Any]


class PipelineRunRequest(BaseModel):
    version: int | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    fail_policy: Literal["stop", "continue"] = "stop"
    scheduled_for: datetime | None = None


class PipelineImportRequest(BaseModel):
    pipeline: dict[str, Any]
    name: str | None = Field(default=None, min_length=1, max_length=200)


class ModelRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    training_job_id: int | None = None
    run_id: str | None = None
    artifact_path: str = "model"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("metadata")
    @classmethod
    def reject_gate_policy_metadata(cls, value: dict[str, Any]) -> dict[str, Any]:
        forbidden = {
            "gates",
            "test_instance",
            "metric_threshold",
            "max_inference_latency_ms",
        }
        banned = sorted(forbidden.intersection(value or {}))
        if banned:
            raise ValueError(
                "metadata must not include gate policy controls: "
                + ", ".join(banned)
            )
        return value

    @model_validator(mode="after")
    def source_required(self) -> ModelRegisterRequest:
        if self.training_job_id is None and not self.run_id:
            raise ValueError("Provide training_job_id or run_id")
        return self


class ModelGatePolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    metric_name: str | None = Field(default=None, max_length=100)
    metric_minimum: float | None = None
    metric_maximum: float | None = None
    max_inference_latency_ms: float | None = Field(default=None, gt=0)
    require_artifact: bool | None = None
    require_schema: bool | None = None
    require_model_load: bool | None = None
    require_test_inference: bool | None = None
    require_mlflow_project: bool | None = None


class ApprovalRequest(BaseModel):
    comment: str | None = None


class RollbackRequest(BaseModel):
    model_version_id: int | None = None


class EndpointCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    model_version_id: int
    feature_schema: list[Any] = Field(default_factory=list)


class EndpointUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class EndpointSwapRequest(BaseModel):
    model_version_id: int


class PredictRequest(BaseModel):
    instances: list[dict[str, Any]] = Field(min_length=1)


class ServiceApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    endpoint_id: int | None = None
    expires_at: datetime | None = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("name must not be blank")
        return cleaned


class BatchCreate(BaseModel):
    dataset_version_id: int
    endpoint_id: int | None = None
    model_version_id: int | None = None
    result_format: Literal["csv", "json", "parquet"] = "csv"

    @model_validator(mode="after")
    def prediction_target_required(self) -> BatchCreate:
        if self.endpoint_id is None and self.model_version_id is None:
            raise ValueError("Provide endpoint_id or model_version_id")
        return self


class DriftCreate(BaseModel):
    reference_version_id: int
    current_version_id: int
    endpoint_id: int | None = None
    thresholds: dict[str, Any] = Field(default_factory=dict)


class RetrainRequest(BaseModel):
    source_job_id: int
    dataset_version_id: int | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    overrides: dict[str, Any] = Field(default_factory=dict)


class AlertFilters(BaseModel):
    severity: AlertSeverity | None = None
    is_read: bool | None = None
    is_resolved: bool | None = None


class SettingsUpdate(BaseModel):
    values: dict[str, Any]


class RetentionPolicyUpdate(BaseModel):
    training_logs_days: int = Field(ge=0)
    inference_stats_days: int = Field(ge=0)
    audit_logs_days: int = Field(ge=0)
    batch_results_days: int = Field(ge=0)
    archived_models_days: int = Field(ge=0)
