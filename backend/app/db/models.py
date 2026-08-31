from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class JobStatus(str, enum.Enum):
    pending = "pending"
    queued = "queued"
    running = "running"
    cancel_requested = "cancel_requested"
    cancelled = "cancelled"
    succeeded = "succeeded"
    failed = "failed"


class ProjectRole(str, enum.Enum):
    PROJECT_ADMIN = "PROJECT_ADMIN"
    ML_ENGINEER = "ML_ENGINEER"
    DATA_SCIENTIST = "DATA_SCIENTIST"
    VIEWER = "VIEWER"


class DataSourceType(str, enum.Enum):
    file = "file"
    postgres = "postgres"


class ModelLifecycle(str, enum.Enum):
    CANDIDATE = "CANDIDATE"
    VALIDATING = "VALIDATING"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    PRODUCTION = "PRODUCTION"
    REJECTED = "REJECTED"
    ARCHIVED = "ARCHIVED"


class PipelineStatus(str, enum.Enum):
    draft = "draft"
    published = "published"


class QualityResult(str, enum.Enum):
    PASS = "PASS"
    WARNING = "WARNING"
    FAIL = "FAIL"


class AlertSeverity(str, enum.Enum):
    info = "info"
    warning = "warning"
    error = "error"
    critical = "critical"


class ScheduleTargetType(str, enum.Enum):
    data_import = "data_import"
    batch_inference = "batch_inference"
    pipeline_run = "pipeline_run"


class ConcurrencyPolicy(str, enum.Enum):
    skip = "skip"
    queue = "queue"


class ScheduleRunStatus(str, enum.Enum):
    pending = "pending"
    dispatched = "dispatched"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    skipped = "skipped"


class ScheduleTriggerSource(str, enum.Enum):
    cron = "cron"
    manual = "manual"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_system_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    memberships: Mapped[list[ProjectMembership]] = relationship(back_populates="user")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    datasets: Mapped[list[Dataset]] = relationship(back_populates="project")
    jobs: Mapped[list[TrainingJob]] = relationship(back_populates="project")
    endpoints: Mapped[list[Endpoint]] = relationship(back_populates="project")
    memberships: Mapped[list[ProjectMembership]] = relationship(back_populates="project")


class ProjectMembership(Base):
    __tablename__ = "project_memberships"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    role: Mapped[ProjectRole] = mapped_column(Enum(ProjectRole), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(back_populates="memberships")


class Dataset(Base):
    """Logical dataset container; versions hold immutable blobs."""

    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # MVP compatibility: latest version mirrored fields
    object_key: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    column_count: Mapped[int] = mapped_column(Integer, default=0)
    columns_json: Mapped[str] = mapped_column(Text, default="[]")
    stats_json: Mapped[str] = mapped_column(Text, default="{}")
    latest_version: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="datasets")
    jobs: Mapped[list[TrainingJob]] = relationship(back_populates="dataset")
    versions: Mapped[list[DatasetVersion]] = relationship(back_populates="dataset")


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version", name="uq_dataset_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"), nullable=False, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    object_key: Mapped[str] = mapped_column(String(500), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    format: Mapped[str] = mapped_column(String(50), default="csv")
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    column_count: Mapped[int] = mapped_column(Integer, default=0)
    columns_json: Mapped[str] = mapped_column(Text, default="[]")
    dtypes_json: Mapped[str] = mapped_column(Text, default="{}")
    stats_json: Mapped[str] = mapped_column(Text, default="{}")
    preview_json: Mapped[str] = mapped_column(Text, default="[]")
    source_type: Mapped[str] = mapped_column(String(50), default="upload")
    data_source_id: Mapped[int | None] = mapped_column(ForeignKey("data_sources.id"), nullable=True)
    import_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    dataset: Mapped[Dataset] = relationship(back_populates="versions")


class DataSource(Base):
    __tablename__ = "data_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    source_type: Mapped[DataSourceType] = mapped_column(Enum(DataSourceType), nullable=False)
    config_json: Mapped[str] = mapped_column(Text, default="{}")  # non-secret config
    secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_test_status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    last_test_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DataImportJob(Base):
    __tablename__ = "data_import_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    data_source_id: Mapped[int] = mapped_column(ForeignKey("data_sources.id"), nullable=False)
    dataset_id: Mapped[int | None] = mapped_column(ForeignKey("datasets.id"), nullable=True)
    dataset_version_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_versions.id"), nullable=True)
    query_or_table: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class QualityRule(Base):
    __tablename__ = "quality_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    dataset_id: Mapped[int | None] = mapped_column(
        ForeignKey("datasets.id", name="fk_quality_rules_dataset_id"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    rules_json: Mapped[str] = mapped_column(Text, default="[]")
    block_training_on_fail: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    dataset: Mapped[Dataset | None] = relationship()


class QualityCheck(Base):
    __tablename__ = "quality_checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    dataset_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"), nullable=False)
    quality_rule_id: Mapped[int | None] = mapped_column(ForeignKey("quality_rules.id"), nullable=True)
    result: Mapped[QualityResult] = mapped_column(Enum(QualityResult), nullable=False)
    details_json: Mapped[str] = mapped_column(Text, default="[]")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DatasetSplit(Base):
    __tablename__ = "dataset_splits"
    __table_args__ = (
        UniqueConstraint(
            "dataset_version_id",
            "config_signature",
            name="uq_dataset_splits_version_config",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    dataset_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), default="default")
    train_ratio: Mapped[float] = mapped_column(Float, default=0.7)
    val_ratio: Mapped[float] = mapped_column(Float, default=0.15)
    test_ratio: Mapped[float] = mapped_column(Float, default=0.15)
    random_seed: Mapped[int] = mapped_column(Integer, default=42)
    config_signature: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    train_object_key: Mapped[str] = mapped_column(String(500), default="")
    val_object_key: Mapped[str] = mapped_column(String(500), default="")
    test_object_key: Mapped[str] = mapped_column(String(500), default="")
    train_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    validation_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    test_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TrainingJob(Base):
    __tablename__ = "training_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"), nullable=False)
    dataset_version_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_versions.id"), nullable=True)
    split_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_splits.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    target_column: Mapped[str] = mapped_column(String(200), nullable=False)
    problem_type: Mapped[str] = mapped_column(String(50), default="auto")  # classification|regression|auto
    algorithm: Mapped[str] = mapped_column(String(100), default="random_forest")
    hyperparameters_json: Mapped[str] = mapped_column(Text, default="{}")
    preprocessing_json: Mapped[str] = mapped_column(Text, default="{}")
    feature_columns_json: Mapped[str] = mapped_column(Text, default="[]")
    metrics_config_json: Mapped[str] = mapped_column(Text, default="[]")
    resource_json: Mapped[str] = mapped_column(Text, default="{}")
    random_seed: Mapped[int] = mapped_column(Integer, default=42)
    train_ratio: Mapped[float] = mapped_column(Float, default=0.7)
    val_ratio: Mapped[float] = mapped_column(Float, default=0.15)
    test_ratio: Mapped[float] = mapped_column(Float, default=0.15)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    logs: Mapped[str] = mapped_column(Text, default="")
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_uri: Mapped[str | None] = mapped_column(String(500), nullable=True)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    parent_job_id: Mapped[int | None] = mapped_column(ForeignKey("training_jobs.id"), nullable=True)
    retrain_source_job_id: Mapped[int | None] = mapped_column(
        ForeignKey("training_jobs.id"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship(back_populates="jobs")
    dataset: Mapped[Dataset] = relationship(back_populates="jobs")


class Endpoint(Base):
    __tablename__ = "endpoints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    model_name: Mapped[str] = mapped_column(String(200), nullable=False)
    model_version: Mapped[str] = mapped_column(String(50), nullable=False)
    model_version_id: Mapped[int | None] = mapped_column(ForeignKey("model_versions.id"), nullable=True)
    model_uri: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="ready")  # ready|stopped|error|loading
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    success_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    latency_sum_ms: Mapped[float] = mapped_column(Float, default=0.0)
    latency_p95_ms: Mapped[float] = mapped_column(Float, default=0.0)
    feature_schema_json: Mapped[str] = mapped_column(Text, default="[]")
    recent_errors_json: Mapped[str] = mapped_column(Text, default="[]")
    previous_model_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    previous_model_uri: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship(back_populates="endpoints")


class ServiceApiKey(Base):
    """Project- or endpoint-scoped credential for external inference only."""

    __tablename__ = "service_api_keys"
    __table_args__ = (
        Index("ix_service_api_keys_project_id", "project_id"),
        Index("ix_service_api_keys_endpoint_id", "endpoint_id"),
        UniqueConstraint("key_prefix", name="uq_service_api_keys_key_prefix"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    endpoint_id: Mapped[int | None] = mapped_column(ForeignKey("endpoints.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(32), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ModelGatePolicy(Base):
    """Server-managed evaluation policy for model gates (not client-supplied)."""

    __tablename__ = "model_gate_policies"
    __table_args__ = (
        UniqueConstraint("project_id", "name", "version", name="uq_gate_policy_name_ver"),
        Index("ix_gate_policy_project_active", "project_id", "is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="default")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    metric_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    metric_minimum: Mapped[float | None] = mapped_column(Float, nullable=True)
    metric_maximum: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_inference_latency_ms: Mapped[float] = mapped_column(Float, default=5000.0, nullable=False)
    require_artifact: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    require_schema: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    require_model_load: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    require_test_inference: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    require_mlflow_project: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ModelVersion(Base):
    __tablename__ = "model_versions"
    __table_args__ = (UniqueConstraint("project_id", "name", "version", name="uq_model_name_ver"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    version: Mapped[str] = mapped_column(String(50), nullable=False)
    lifecycle: Mapped[ModelLifecycle] = mapped_column(
        Enum(ModelLifecycle), default=ModelLifecycle.CANDIDATE
    )
    mlflow_model_name: Mapped[str] = mapped_column(String(200), nullable=False)
    mlflow_version: Mapped[str] = mapped_column(String(50), nullable=False)
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_uri: Mapped[str] = mapped_column(String(500), nullable=False)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}")
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    dataset_version_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_versions.id"), nullable=True)
    training_job_id: Mapped[int | None] = mapped_column(ForeignKey("training_jobs.id"), nullable=True)
    pipeline_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gate_policy_id: Mapped[int | None] = mapped_column(ForeignKey("model_gate_policies.id"), nullable=True)
    gate_results_json: Mapped[str] = mapped_column(Text, default="{}")
    gates_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    approval_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Pipeline(Base):
    __tablename__ = "pipelines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[PipelineStatus] = mapped_column(Enum(PipelineStatus), default=PipelineStatus.draft)
    latest_version: Mapped[int] = mapped_column(Integer, default=0)
    is_template: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PipelineVersion(Base):
    __tablename__ = "pipeline_versions"
    __table_args__ = (UniqueConstraint("pipeline_id", "version", name="uq_pipeline_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_id: Mapped[int] = mapped_column(ForeignKey("pipelines.id"), nullable=False, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    graph_json: Mapped[str] = mapped_column(Text, default="{}")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PipelineRun(Base):
    __tablename__ = "pipeline_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    pipeline_id: Mapped[int] = mapped_column(ForeignKey("pipelines.id"), nullable=False)
    pipeline_version_id: Mapped[int] = mapped_column(ForeignKey("pipeline_versions.id"), nullable=False)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    parameters_json: Mapped[str] = mapped_column(Text, default="{}")
    node_states_json: Mapped[str] = mapped_column(Text, default="{}")
    node_artifacts_json: Mapped[str] = mapped_column(Text, default="{}")
    logs: Mapped[str] = mapped_column(Text, default="")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    fail_policy: Mapped[str] = mapped_column(String(50), default="stop")  # stop|continue
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class BatchInferenceJob(Base):
    __tablename__ = "batch_inference_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    dataset_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"), nullable=False)
    endpoint_id: Mapped[int | None] = mapped_column(ForeignKey("endpoints.id"), nullable=True)
    model_version_id: Mapped[int | None] = mapped_column(ForeignKey("model_versions.id"), nullable=True)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    result_object_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    result_format: Mapped[str] = mapped_column(String(20), default="csv")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_details_json: Mapped[str] = mapped_column(Text, default="[]")
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DriftRun(Base):
    __tablename__ = "drift_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    reference_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"), nullable=False)
    current_version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id"), nullable=False)
    endpoint_id: Mapped[int | None] = mapped_column(ForeignKey("endpoints.id"), nullable=True)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    overall_status: Mapped[str | None] = mapped_column(String(50), nullable=True)  # ok|watch|critical
    results_json: Mapped[str] = mapped_column(Text, default="{}")
    thresholds_json: Mapped[str] = mapped_column(Text, default="{}")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RetrainTrigger(Base):
    __tablename__ = "retrain_triggers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    trigger_type: Mapped[str] = mapped_column(String(50), nullable=False)  # manual|schedule|drift|new_version
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_training_job_id: Mapped[int | None] = mapped_column(ForeignKey("training_jobs.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (Index("ix_alerts_project_unread", "project_id", "is_read"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    alert_type: Mapped[str] = mapped_column(String(100), nullable=False)
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), default=AlertSeverity.info)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    message: Mapped[str] = mapped_column(Text, default="")
    resource_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    link_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    is_resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_created", "created_at"),
        Index("ix_audit_action", "action"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    user_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    ip_address: Mapped[str | None] = mapped_column(String(100), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    before_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    after_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class InferenceStat(Base):
    __tablename__ = "inference_stats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    endpoint_id: Mapped[int] = mapped_column(ForeignKey("endpoints.id"), nullable=False, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    error_class: Mapped[str | None] = mapped_column(String(100), nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # only if enabled
    prediction_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text, default="null")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"

    worker_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status_json: Mapped[str] = mapped_column(Text, default="{}")


class AutomationSchedule(Base):
    __tablename__ = "automation_schedules"
    __table_args__ = (
        Index("ix_automation_schedules_project_id", "project_id"),
        Index("ix_automation_schedules_enabled_next_run", "is_enabled", "next_run_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    target_type: Mapped[ScheduleTargetType] = mapped_column(
        Enum(ScheduleTargetType), nullable=False
    )
    target_config_json: Mapped[str] = mapped_column(Text, default="{}")
    cron_expression: Mapped[str] = mapped_column(String(120), nullable=False)
    timezone: Mapped[str] = mapped_column(String(100), default="UTC", nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    concurrency_policy: Mapped[ConcurrencyPolicy] = mapped_column(
        Enum(ConcurrencyPolicy), default=ConcurrencyPolicy.skip, nullable=False
    )
    max_concurrent_runs: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    max_retries: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    retry_delay_seconds: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    runs: Mapped[list[AutomationScheduleRun]] = relationship(back_populates="schedule")


class AutomationScheduleRun(Base):
    __tablename__ = "automation_schedule_runs"
    __table_args__ = (
        UniqueConstraint(
            "schedule_id",
            "scheduled_for",
            "attempt",
            "trigger_source",
            name="uq_schedule_run_occurrence",
        ),
        Index("ix_schedule_runs_schedule_id", "schedule_id"),
        Index("ix_schedule_runs_project_id", "project_id"),
        Index("ix_schedule_runs_status", "status"),
        Index("ix_schedule_runs_ready_at", "ready_at"),
        Index("ix_schedule_runs_scheduled_for", "scheduled_for"),
        Index(
            "ix_schedule_runs_dispatch",
            "status",
            "ready_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    schedule_id: Mapped[int] = mapped_column(
        ForeignKey("automation_schedules.id"), nullable=False
    )
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    trigger_source: Mapped[ScheduleTriggerSource] = mapped_column(
        Enum(ScheduleTriggerSource), default=ScheduleTriggerSource.cron, nullable=False
    )
    status: Mapped[ScheduleRunStatus] = mapped_column(
        Enum(ScheduleRunStatus), default=ScheduleRunStatus.pending, nullable=False
    )
    target_type: Mapped[ScheduleTargetType] = mapped_column(
        Enum(ScheduleTargetType), nullable=False
    )
    target_resource_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    schedule: Mapped[AutomationSchedule] = relationship(back_populates="runs")
