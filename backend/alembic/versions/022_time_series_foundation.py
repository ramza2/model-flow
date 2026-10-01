"""Phase 6-A time-aware training foundation — split_strategy / time_column.

Revision ID: 022_time_series_foundation
Revises: 021_continued_training
Create Date: 2026-09-30
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "022_time_series_foundation"
down_revision: Union[str, None] = "021_continued_training"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dataset_splits",
        sa.Column(
            "split_strategy",
            sa.String(length=20),
            nullable=False,
            server_default="random",
        ),
    )
    op.add_column(
        "dataset_splits",
        sa.Column("time_column", sa.String(length=200), nullable=True),
    )
    op.add_column(
        "training_jobs",
        sa.Column(
            "split_strategy",
            sa.String(length=20),
            nullable=False,
            server_default="random",
        ),
    )
    op.add_column(
        "training_jobs",
        sa.Column("time_column", sa.String(length=200), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("training_jobs", "time_column")
    op.drop_column("training_jobs", "split_strategy")
    op.drop_column("dataset_splits", "time_column")
    op.drop_column("dataset_splits", "split_strategy")
