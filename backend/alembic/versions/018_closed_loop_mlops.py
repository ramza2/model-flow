"""Add closed-loop MLOps foundation tables and schedule target.

Revision ID: 018_closed_loop_mlops
Revises: 017_oracle_data_source
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "018_closed_loop_mlops"
down_revision = "017_oracle_data_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE scheduletargettype ADD VALUE IF NOT EXISTS 'model_quality'")

    op.create_table(
        "prediction_observations",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=False),
        sa.Column(
            "model_version_id",
            sa.Integer(),
            sa.ForeignKey("model_versions.id"),
            nullable=True,
        ),
        sa.Column("request_id", sa.String(length=36), nullable=False),
        sa.Column("instance_index", sa.Integer(), nullable=False),
        sa.Column("prediction_json", sa.Text(), nullable=False),
        sa.Column("predicted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_prediction_observations_project_id",
        "prediction_observations",
        ["project_id"],
    )
    op.create_index(
        "ix_prediction_observations_endpoint_id",
        "prediction_observations",
        ["endpoint_id"],
    )
    op.create_index(
        "ix_prediction_observations_model_version_id",
        "prediction_observations",
        ["model_version_id"],
    )
    op.create_index(
        "ix_prediction_observations_request_id",
        "prediction_observations",
        ["request_id"],
    )
    op.create_index(
        "ix_prediction_observations_endpoint_predicted",
        "prediction_observations",
        ["endpoint_id", "predicted_at"],
    )

    op.create_table(
        "ground_truth_feedback",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "prediction_observation_id",
            sa.String(length=36),
            sa.ForeignKey("prediction_observations.id"),
            nullable=False,
        ),
        sa.Column("actual_json", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=50), nullable=False, server_default="api"),
        sa.Column("submitted_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "service_api_key_id",
            sa.Integer(),
            sa.ForeignKey("service_api_keys.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "prediction_observation_id",
            name="uq_ground_truth_prediction_observation",
        ),
    )
    op.create_index(
        "ix_ground_truth_feedback_project_id",
        "ground_truth_feedback",
        ["project_id"],
    )

    op.create_table(
        "model_quality_policies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("window_hours", sa.Integer(), nullable=False, server_default="24"),
        sa.Column(
            "minimum_matched_samples",
            sa.Integer(),
            nullable=False,
            server_default="20",
        ),
        sa.Column("primary_metric", sa.String(length=50), nullable=False),
        sa.Column("warning_threshold", sa.Float(), nullable=False),
        sa.Column("critical_threshold", sa.Float(), nullable=False),
        sa.Column("consecutive_breaches", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("cooldown_hours", sa.Integer(), nullable=False, server_default="24"),
        sa.Column("auto_retrain", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_model_quality_policies_project_id",
        "model_quality_policies",
        ["project_id"],
    )
    op.create_index(
        "ix_model_quality_policies_endpoint_id",
        "model_quality_policies",
        ["endpoint_id"],
    )

    job_status = postgresql.ENUM(
        "pending",
        "queued",
        "running",
        "cancel_requested",
        "cancelled",
        "succeeded",
        "failed",
        name="jobstatus",
        create_type=False,
    )
    op.create_table(
        "model_quality_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "policy_id",
            sa.Integer(),
            sa.ForeignKey("model_quality_policies.id"),
            nullable=False,
        ),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=False),
        sa.Column(
            "model_version_id",
            sa.Integer(),
            sa.ForeignKey("model_versions.id"),
            nullable=True,
        ),
        sa.Column("status", job_status, nullable=False, server_default="pending"),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("prediction_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "matched_ground_truth_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("match_rate", sa.Float(), nullable=True),
        sa.Column("metrics_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("thresholds_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("quality_status", sa.String(length=50), nullable=True),
        sa.Column("trigger_decision_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "schedule_run_id",
            sa.Integer(),
            sa.ForeignKey("automation_schedule_runs.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_model_quality_runs_project_id",
        "model_quality_runs",
        ["project_id"],
    )
    op.create_index(
        "ix_model_quality_runs_policy_id",
        "model_quality_runs",
        ["policy_id"],
    )
    op.create_index(
        "ix_model_quality_runs_status",
        "model_quality_runs",
        ["status"],
    )

    op.add_column(
        "retrain_triggers",
        sa.Column(
            "quality_run_id",
            sa.Integer(),
            sa.ForeignKey("model_quality_runs.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "retrain_triggers",
        sa.Column(
            "source_model_version_id",
            sa.Integer(),
            sa.ForeignKey("model_versions.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "retrain_triggers",
        sa.Column(
            "target_dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "retrain_triggers",
        sa.Column(
            "candidate_model_version_id",
            sa.Integer(),
            sa.ForeignKey("model_versions.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_retrain_triggers_quality_run_id",
        "retrain_triggers",
        ["quality_run_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_retrain_triggers_quality_run_id", table_name="retrain_triggers")
    op.drop_column("retrain_triggers", "candidate_model_version_id")
    op.drop_column("retrain_triggers", "target_dataset_version_id")
    op.drop_column("retrain_triggers", "source_model_version_id")
    op.drop_column("retrain_triggers", "quality_run_id")
    op.drop_table("model_quality_runs")
    op.drop_table("model_quality_policies")
    op.drop_table("ground_truth_feedback")
    op.drop_table("prediction_observations")
    # PostgreSQL cannot easily remove enum values; leave scheduletargettype.model_quality.
