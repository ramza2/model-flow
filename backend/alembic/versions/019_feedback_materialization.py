"""Phase 5-B feedback dataset materialization.

Revision ID: 019_feedback_materialization
Revises: 018_closed_loop_mlops
Create Date: 2026-09-22
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "019_feedback_materialization"
down_revision: Union[str, None] = "018_closed_loop_mlops"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "feedback_materialization_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=False),
        sa.Column(
            "source_model_version_id",
            sa.Integer(),
            sa.ForeignKey("model_versions.id"),
            nullable=False,
        ),
        sa.Column(
            "source_training_job_id",
            sa.Integer(),
            sa.ForeignKey("training_jobs.id"),
            nullable=False,
        ),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id"), nullable=False),
        sa.Column(
            "base_dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column(
            "output_dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "queued",
                "running",
                "cancel_requested",
                "cancelled",
                "succeeded",
                "failed",
                name="jobstatus",
                create_type=False,
            ),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("feedback_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("feedback_ids_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("row_count_before", sa.Integer(), nullable=True),
        sa.Column("row_count_added", sa.Integer(), nullable=True),
        sa.Column("row_count_after", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_feedback_materialization_runs_project_id",
        "feedback_materialization_runs",
        ["project_id"],
    )
    op.create_index(
        "ix_feedback_materialization_runs_status",
        "feedback_materialization_runs",
        ["status"],
    )
    op.create_index(
        "ix_feedback_materialization_runs_endpoint_id",
        "feedback_materialization_runs",
        ["endpoint_id"],
    )

    op.add_column(
        "prediction_observations",
        sa.Column("input_json", sa.Text(), nullable=True),
    )

    op.add_column(
        "ground_truth_feedback",
        sa.Column(
            "review_status",
            sa.String(length=20),
            nullable=False,
            server_default="PENDING",
        ),
    )
    op.add_column(
        "ground_truth_feedback",
        sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
    )
    op.add_column(
        "ground_truth_feedback",
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ground_truth_feedback",
        sa.Column("review_comment", sa.Text(), nullable=True),
    )
    op.add_column(
        "ground_truth_feedback",
        sa.Column(
            "materialization_run_id",
            sa.Integer(),
            sa.ForeignKey("feedback_materialization_runs.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "ground_truth_feedback",
        sa.Column(
            "materialized_dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_ground_truth_feedback_review_status",
        "ground_truth_feedback",
        ["review_status"],
    )
    op.create_index(
        "ix_ground_truth_feedback_materialization_run_id",
        "ground_truth_feedback",
        ["materialization_run_id"],
    )
    op.create_index(
        "ix_ground_truth_feedback_materialized_dataset_version_id",
        "ground_truth_feedback",
        ["materialized_dataset_version_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ground_truth_feedback_materialized_dataset_version_id",
        table_name="ground_truth_feedback",
    )
    op.drop_index(
        "ix_ground_truth_feedback_materialization_run_id",
        table_name="ground_truth_feedback",
    )
    op.drop_index(
        "ix_ground_truth_feedback_review_status",
        table_name="ground_truth_feedback",
    )
    op.drop_column("ground_truth_feedback", "materialized_dataset_version_id")
    op.drop_column("ground_truth_feedback", "materialization_run_id")
    op.drop_column("ground_truth_feedback", "review_comment")
    op.drop_column("ground_truth_feedback", "reviewed_at")
    op.drop_column("ground_truth_feedback", "reviewed_by")
    op.drop_column("ground_truth_feedback", "review_status")
    op.drop_column("prediction_observations", "input_json")
    op.drop_index(
        "ix_feedback_materialization_runs_endpoint_id",
        table_name="feedback_materialization_runs",
    )
    op.drop_index(
        "ix_feedback_materialization_runs_status",
        table_name="feedback_materialization_runs",
    )
    op.drop_index(
        "ix_feedback_materialization_runs_project_id",
        table_name="feedback_materialization_runs",
    )
    op.drop_table("feedback_materialization_runs")
