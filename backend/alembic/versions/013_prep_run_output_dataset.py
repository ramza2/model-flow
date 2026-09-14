"""Add output_dataset_id pin on preparation runs.

Revision ID: 013_prep_run_output_dataset
Revises: 012_dataset_prep_foundation
Create Date: 2026-09-11
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "013_prep_run_output_dataset"
down_revision = "012_dataset_prep_foundation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # batch_alter_table keeps SQLite migration tests working while remaining
    # additive on Postgres.
    with op.batch_alter_table("dataset_preparation_runs") as batch_op:
        batch_op.add_column(sa.Column("output_dataset_id", sa.Integer(), nullable=True))
        batch_op.create_index(
            "ix_dataset_preparation_runs_output_dataset_id",
            ["output_dataset_id"],
        )
        batch_op.create_foreign_key(
            "fk_dataset_preparation_runs_output_dataset_id",
            "datasets",
            ["output_dataset_id"],
            ["id"],
        )


def downgrade() -> None:
    with op.batch_alter_table("dataset_preparation_runs") as batch_op:
        batch_op.drop_constraint(
            "fk_dataset_preparation_runs_output_dataset_id",
            type_="foreignkey",
        )
        batch_op.drop_index("ix_dataset_preparation_runs_output_dataset_id")
        batch_op.drop_column("output_dataset_id")
