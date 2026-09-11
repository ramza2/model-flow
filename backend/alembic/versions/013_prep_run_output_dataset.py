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
    op.add_column(
        "dataset_preparation_runs",
        sa.Column("output_dataset_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_dataset_preparation_runs_output_dataset_id",
        "dataset_preparation_runs",
        ["output_dataset_id"],
    )
    op.create_foreign_key(
        "fk_dataset_preparation_runs_output_dataset_id",
        "dataset_preparation_runs",
        "datasets",
        ["output_dataset_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_dataset_preparation_runs_output_dataset_id",
        "dataset_preparation_runs",
        type_="foreignkey",
    )
    op.drop_index(
        "ix_dataset_preparation_runs_output_dataset_id",
        table_name="dataset_preparation_runs",
    )
    op.drop_column("dataset_preparation_runs", "output_dataset_id")
