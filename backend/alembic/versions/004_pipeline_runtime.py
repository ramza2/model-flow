"""Persist pipeline node artifacts for restartable execution.

Revision ID: 004_pipeline_runtime
Revises: 003_v1_platform
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa


revision = "004_pipeline_runtime"
down_revision = "003_v1_platform"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pipeline_runs",
        sa.Column("node_artifacts_json", sa.Text(), nullable=False, server_default="{}"),
    )
    op.create_index(
        "ix_pipeline_runs_status_scheduled_for",
        "pipeline_runs",
        ["status", "scheduled_for"],
    )


def downgrade() -> None:
    op.drop_index("ix_pipeline_runs_status_scheduled_for", table_name="pipeline_runs")
    op.drop_column("pipeline_runs", "node_artifacts_json")
