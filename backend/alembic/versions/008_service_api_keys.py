"""Add service_api_keys for external inference authentication.

Revision ID: 008_service_api_keys
Revises: 007_split_signature_hashes
Create Date: 2026-08-14
"""

from alembic import op
import sqlalchemy as sa


revision = "008_service_api_keys"
down_revision = "007_split_signature_hashes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "service_api_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("key_prefix", sa.String(length=32), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("key_prefix", name="uq_service_api_keys_key_prefix"),
    )
    op.create_index(
        "ix_service_api_keys_project_id",
        "service_api_keys",
        ["project_id"],
    )
    op.create_index(
        "ix_service_api_keys_endpoint_id",
        "service_api_keys",
        ["endpoint_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_service_api_keys_endpoint_id", table_name="service_api_keys")
    op.drop_index("ix_service_api_keys_project_id", table_name="service_api_keys")
    op.drop_table("service_api_keys")
