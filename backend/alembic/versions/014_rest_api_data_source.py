"""Add REST API data source type.

Revision ID: 014_rest_api_data_source
Revises: 013_prep_run_output_dataset
Create Date: 2026-09-18
"""

from __future__ import annotations

from alembic import op

revision = "014_rest_api_data_source"
down_revision = "013_prep_run_output_dataset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute(
                "ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'rest_api'"
            )


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed safely in-place. Keeping the
    # additive value is consistent with existing enum downgrade policy.
    pass
