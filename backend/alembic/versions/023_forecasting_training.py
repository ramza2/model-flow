"""Phase 6-C forecasting training — training_task / forecast fields.

Revision ID: 023_forecasting_training
Revises: 022_time_series_foundation
Create Date: 2026-10-01
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "023_forecasting_training"
down_revision: Union[str, None] = "022_time_series_foundation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_jobs",
        sa.Column(
            "training_task",
            sa.String(length=20),
            nullable=False,
            server_default="tabular",
        ),
    )
    op.add_column(
        "training_jobs",
        sa.Column("forecast_strategy", sa.String(length=40), nullable=True),
    )
    op.add_column(
        "training_jobs",
        sa.Column(
            "forecast_horizons_json",
            sa.Text(),
            nullable=False,
            server_default="[]",
        ),
    )


def downgrade() -> None:
    op.drop_column("training_jobs", "forecast_horizons_json")
    op.drop_column("training_jobs", "forecast_strategy")
    op.drop_column("training_jobs", "training_task")
