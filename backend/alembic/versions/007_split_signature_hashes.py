"""Add config signature and artifact hashes for dataset splits.

Revision ID: 007_split_signature_hashes
Revises: 006_quality_rule_dataset_scope
Create Date: 2026-08-10
"""

from alembic import op
import sqlalchemy as sa


revision = "007_split_signature_hashes"
down_revision = "006_quality_rule_dataset_scope"
branch_labels = None
depends_on = None


def _signature(train_ratio: float, val_ratio: float, test_ratio: float, random_seed: int) -> str:
    return (
        f"{round(float(train_ratio), 6):.6f}:"
        f"{round(float(val_ratio), 6):.6f}:"
        f"{round(float(test_ratio), 6):.6f}:"
        f"{int(random_seed)}"
    )


def upgrade() -> None:
    op.add_column(
        "dataset_splits",
        sa.Column("config_signature", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "dataset_splits",
        sa.Column("train_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "dataset_splits",
        sa.Column("validation_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "dataset_splits",
        sa.Column("test_hash", sa.String(length=64), nullable=True),
    )

    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT id, train_ratio, val_ratio, test_ratio, random_seed "
            "FROM dataset_splits ORDER BY id"
        )
    ).fetchall()
    used: set[str] = set()
    for row in rows:
        signature = _signature(
            row.train_ratio, row.val_ratio, row.test_ratio, row.random_seed
        )
        # Preserve uniqueness if legacy duplicates already exist.
        if signature in used:
            signature = f"{signature}#legacy-{row.id}"
        used.add(signature)
        connection.execute(
            sa.text(
                "UPDATE dataset_splits SET config_signature = :signature WHERE id = :id"
            ),
            {"signature": signature, "id": row.id},
        )

    op.alter_column(
        "dataset_splits",
        "config_signature",
        existing_type=sa.String(length=120),
        nullable=False,
    )
    op.create_unique_constraint(
        "uq_dataset_splits_version_config",
        "dataset_splits",
        ["dataset_version_id", "config_signature"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_dataset_splits_version_config",
        "dataset_splits",
        type_="unique",
    )
    op.drop_column("dataset_splits", "test_hash")
    op.drop_column("dataset_splits", "validation_hash")
    op.drop_column("dataset_splits", "train_hash")
    op.drop_column("dataset_splits", "config_signature")
