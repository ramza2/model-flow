"""Phase 8-C OIDC SSO — external identities, login transactions, local_login_enabled.

Revision ID: 024_oidc_enterprise_identity
Revises: 023_forecasting_training
Create Date: 2026-10-08
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "024_oidc_enterprise_identity"
down_revision: Union[str, None] = "023_forecasting_training"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "local_login_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )

    op.create_table(
        "external_identities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("issuer", sa.String(length=500), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("email_at_link", sa.String(length=320), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=True,
        ),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "issuer", "subject", name="uq_external_identity_issuer_subject"
        ),
        sa.UniqueConstraint(
            "user_id", "issuer", name="uq_external_identity_user_issuer"
        ),
    )
    op.create_index(
        "ix_external_identities_user_id", "external_identities", ["user_id"]
    )

    op.create_table(
        "oidc_login_transactions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("nonce_encrypted", sa.Text(), nullable=False),
        sa.Column("code_verifier_encrypted", sa.Text(), nullable=False),
        sa.Column("return_to", sa.String(length=500), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exchange_code_hash", sa.String(length=64), nullable=True),
        sa.Column("exchange_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exchange_consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=True,
        ),
        sa.UniqueConstraint("state_hash", name="uq_oidc_login_transactions_state_hash"),
    )
    op.create_index(
        "ix_oidc_login_transactions_expires_at",
        "oidc_login_transactions",
        ["expires_at"],
    )
    op.create_index(
        "ix_oidc_login_transactions_exchange_expires",
        "oidc_login_transactions",
        ["exchange_expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_oidc_login_transactions_exchange_expires",
        table_name="oidc_login_transactions",
    )
    op.drop_index(
        "ix_oidc_login_transactions_expires_at", table_name="oidc_login_transactions"
    )
    op.drop_table("oidc_login_transactions")
    op.drop_index("ix_external_identities_user_id", table_name="external_identities")
    op.drop_table("external_identities")
    op.drop_column("users", "local_login_enabled")
