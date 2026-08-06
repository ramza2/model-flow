"""Scope quality rules to datasets with is_active flag.

Revision ID: 006_quality_rule_dataset_scope
Revises: 005_model_gate_policies
Create Date: 2026-08-06
"""

from alembic import op
import sqlalchemy as sa


revision = "006_quality_rule_dataset_scope"
down_revision = "005_model_gate_policies"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "quality_rules",
        sa.Column("dataset_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "quality_rules",
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.create_foreign_key(
        "fk_quality_rules_dataset_id",
        "quality_rules",
        "datasets",
        ["dataset_id"],
        ["id"],
    )
    op.create_index(
        "ix_quality_rules_dataset_id",
        "quality_rules",
        ["dataset_id"],
    )
    # Preserve existing rows as legacy inactive unassigned rules.
    op.execute(
        sa.text(
            "UPDATE quality_rules SET dataset_id = NULL, is_active = false"
        )
    )


def downgrade() -> None:
    op.drop_index("ix_quality_rules_dataset_id", table_name="quality_rules")
    op.drop_constraint(
        "fk_quality_rules_dataset_id", "quality_rules", type_="foreignkey"
    )
    op.drop_column("quality_rules", "is_active")
    op.drop_column("quality_rules", "dataset_id")
