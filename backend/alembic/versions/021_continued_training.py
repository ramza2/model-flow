"""Phase 5.1 continued training — additive `continued_from_job_id` lineage.

Revision ID: 021_continued_training
Revises: 020_advanced_quality_policy
Create Date: 2026-09-23
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "021_continued_training"
down_revision: Union[str, None] = "020_advanced_quality_policy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_jobs",
        sa.Column("continued_from_job_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_training_jobs_continued_from_job_id",
        "training_jobs",
        "training_jobs",
        ["continued_from_job_id"],
        ["id"],
    )
    op.create_index(
        "ix_training_jobs_continued_from_job_id",
        "training_jobs",
        ["continued_from_job_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_training_jobs_continued_from_job_id", table_name="training_jobs")
    op.drop_constraint(
        "fk_training_jobs_continued_from_job_id",
        "training_jobs",
        type_="foreignkey",
    )
    op.drop_column("training_jobs", "continued_from_job_id")
