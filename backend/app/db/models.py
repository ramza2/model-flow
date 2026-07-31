import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class JobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    datasets: Mapped[list["Dataset"]] = relationship(back_populates="project")
    jobs: Mapped[list["TrainingJob"]] = relationship(back_populates="project")
    endpoints: Mapped[list["Endpoint"]] = relationship(back_populates="project")


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    object_key: Mapped[str] = mapped_column(String(500), nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    column_count: Mapped[int] = mapped_column(Integer, default=0)
    columns_json: Mapped[str] = mapped_column(Text, default="[]")
    stats_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="datasets")
    jobs: Mapped[list["TrainingJob"]] = relationship(back_populates="dataset")


class TrainingJob(Base):
    __tablename__ = "training_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    target_column: Mapped[str] = mapped_column(String(200), nullable=False)
    algorithm: Mapped[str] = mapped_column(String(100), default="random_forest")
    hyperparameters_json: Mapped[str] = mapped_column(Text, default="{}")
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    logs: Mapped[str] = mapped_column(Text, default="")
    mlflow_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_uri: Mapped[str | None] = mapped_column(String(500), nullable=True)
    metrics_json: Mapped[str] = mapped_column(Text, default="{}")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship(back_populates="jobs")
    dataset: Mapped[Dataset] = relationship(back_populates="jobs")


class Endpoint(Base):
    __tablename__ = "endpoints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    model_name: Mapped[str] = mapped_column(String(200), nullable=False)
    model_version: Mapped[str] = mapped_column(String(50), nullable=False)
    model_uri: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="ready")
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="endpoints")
