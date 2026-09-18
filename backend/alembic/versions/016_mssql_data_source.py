"""Add Microsoft SQL Server data source type.

Revision ID: 016_mssql_data_source
Revises: 015_mysql_data_source
Create Date: 2026-09-18
"""

from __future__ import annotations

from alembic import op

revision = "016_mssql_data_source"
down_revision = "015_mysql_data_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute(
                "ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'mssql'"
            )


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed safely in-place. Keeping the
    # additive value is consistent with existing enum downgrade policy.
    pass
