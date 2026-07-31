"""worker heartbeats

Revision ID: 002_worker_heartbeats
Revises: 001_initial
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa

revision = "002_worker_heartbeats"
down_revision = "001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "worker_heartbeats",
        sa.Column("worker_id", sa.String(100), primary_key=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("worker_heartbeats")
