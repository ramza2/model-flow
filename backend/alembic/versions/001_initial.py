"""initial schema

Revision ID: 001_initial
Revises:
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa

revision = "001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("object_key", sa.String(500), nullable=False),
        sa.Column("row_count", sa.Integer(), server_default="0"),
        sa.Column("column_count", sa.Integer(), server_default="0"),
        sa.Column("columns_json", sa.Text(), server_default="[]"),
        sa.Column("stats_json", sa.Text(), server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "training_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("target_column", sa.String(200), nullable=False),
        sa.Column("algorithm", sa.String(100), server_default="random_forest"),
        sa.Column("hyperparameters_json", sa.Text(), server_default="{}"),
        sa.Column(
            "status",
            sa.Enum("pending", "running", "succeeded", "failed", name="jobstatus"),
            server_default="pending",
        ),
        sa.Column("logs", sa.Text(), server_default=""),
        sa.Column("mlflow_run_id", sa.String(64), nullable=True),
        sa.Column("model_uri", sa.String(500), nullable=True),
        sa.Column("metrics_json", sa.Text(), server_default="{}"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "endpoints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("model_name", sa.String(200), nullable=False),
        sa.Column("model_version", sa.String(50), nullable=False),
        sa.Column("model_uri", sa.String(500), nullable=False),
        sa.Column("status", sa.String(50), server_default="ready"),
        sa.Column("request_count", sa.Integer(), server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("endpoints")
    op.drop_table("training_jobs")
    op.drop_table("datasets")
    op.drop_table("projects")
    sa.Enum(name="jobstatus").drop(op.get_bind(), checkfirst=True)
