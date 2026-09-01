"""Add target_columns_json to training_jobs for multi-output regression."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "011_target_columns"
down_revision = "010_retrain_source_job"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "training_jobs",
        sa.Column(
            "target_columns_json",
            sa.Text(),
            nullable=False,
            server_default="[]",
        ),
    )


def downgrade() -> None:
    op.drop_column("training_jobs", "target_columns_json")
