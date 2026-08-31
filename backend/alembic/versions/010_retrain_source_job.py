"""Add retrain_source_job_id to training_jobs.

Revision ID: 010_retrain_source_job
Revises: 009_automation_schedules
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "010_retrain_source_job"
down_revision = "009_automation_schedules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "training_jobs",
        sa.Column("retrain_source_job_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_training_jobs_retrain_source",
        "training_jobs",
        "training_jobs",
        ["retrain_source_job_id"],
        ["id"],
    )
    op.create_index(
        "ix_training_jobs_retrain_source_job_id",
        "training_jobs",
        ["retrain_source_job_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_training_jobs_retrain_source_job_id", table_name="training_jobs")
    op.drop_constraint("fk_training_jobs_retrain_source", "training_jobs", type_="foreignkey")
    op.drop_column("training_jobs", "retrain_source_job_id")
