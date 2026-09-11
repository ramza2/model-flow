"""Add dataset preparation foundation tables.

Revision ID: 012_dataset_prep_foundation
Revises: 011_target_columns
Create Date: 2026-09-11
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "012_dataset_prep_foundation"
down_revision = "011_target_columns"
branch_labels = None
depends_on = None

PREPARATION_RUN_STATUS = postgresql.ENUM(
    "created",
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    name="datasetpreparationrunstatus",
    create_type=False,
)


def _create_enum_types() -> None:
    bind = op.get_bind()
    PREPARATION_RUN_STATUS.create(bind, checkfirst=True)


def upgrade() -> None:
    _create_enum_types()
    op.create_table(
        "dataset_preparations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "output_dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id"),
            nullable=True,
        ),
        sa.Column("latest_version", sa.Integer(), nullable=False, server_default="0"),
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
        sa.UniqueConstraint(
            "project_id",
            "name",
            name="uq_dataset_preparation_project_name",
        ),
    )
    op.create_index(
        "ix_dataset_preparations_project_id",
        "dataset_preparations",
        ["project_id"],
    )
    op.create_index(
        "ix_dataset_preparations_output_dataset_id",
        "dataset_preparations",
        ["output_dataset_id"],
    )

    op.create_table(
        "dataset_preparation_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "preparation_id",
            sa.Integer(),
            sa.ForeignKey("dataset_preparations.id"),
            nullable=False,
        ),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "graph_json",
            sa.Text(),
            nullable=False,
            server_default='{"schema_version":1,"nodes":[],"edges":[]}',
        ),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "preparation_id",
            "version",
            name="uq_dataset_preparation_version",
        ),
    )
    op.create_index(
        "ix_dataset_preparation_versions_preparation_id",
        "dataset_preparation_versions",
        ["preparation_id"],
    )
    op.create_index(
        "ix_dataset_preparation_versions_project_id",
        "dataset_preparation_versions",
        ["project_id"],
    )

    op.create_table(
        "dataset_preparation_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "preparation_id",
            sa.Integer(),
            sa.ForeignKey("dataset_preparations.id"),
            nullable=False,
        ),
        sa.Column(
            "preparation_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_preparation_versions.id"),
            nullable=False,
        ),
        sa.Column("status", PREPARATION_RUN_STATUS, nullable=False),
        sa.Column(
            "output_dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=True,
        ),
        sa.Column("logs", sa.Text(), nullable=False, server_default=""),
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
        "ix_dataset_preparation_runs_project_id",
        "dataset_preparation_runs",
        ["project_id"],
    )
    op.create_index(
        "ix_dataset_preparation_runs_preparation_id",
        "dataset_preparation_runs",
        ["preparation_id"],
    )
    op.create_index(
        "ix_dataset_preparation_runs_preparation_version_id",
        "dataset_preparation_runs",
        ["preparation_version_id"],
    )
    op.create_index(
        "ix_dataset_preparation_runs_output_dataset_version_id",
        "dataset_preparation_runs",
        ["output_dataset_version_id"],
    )

    op.create_table(
        "dataset_preparation_run_inputs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Integer(),
            sa.ForeignKey("dataset_preparation_runs.id"),
            nullable=False,
        ),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("node_id", sa.String(length=200), nullable=False),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id"), nullable=False),
        sa.Column(
            "dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column("version_strategy", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "run_id",
            "node_id",
            name="uq_dataset_preparation_run_input_node",
        ),
    )
    op.create_index(
        "ix_dataset_preparation_run_inputs_run_id",
        "dataset_preparation_run_inputs",
        ["run_id"],
    )
    op.create_index(
        "ix_dataset_preparation_run_inputs_project_id",
        "dataset_preparation_run_inputs",
        ["project_id"],
    )
    op.create_index(
        "ix_dataset_preparation_run_inputs_dataset_id",
        "dataset_preparation_run_inputs",
        ["dataset_id"],
    )
    op.create_index(
        "ix_dataset_preparation_run_inputs_dataset_version_id",
        "dataset_preparation_run_inputs",
        ["dataset_version_id"],
    )


def downgrade() -> None:
    op.drop_table("dataset_preparation_run_inputs")
    op.drop_table("dataset_preparation_runs")
    op.drop_table("dataset_preparation_versions")
    op.drop_table("dataset_preparations")
    bind = op.get_bind()
    PREPARATION_RUN_STATUS.drop(bind, checkfirst=True)
