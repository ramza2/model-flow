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


def assign_legacy_config_signatures(
    rows: list[tuple[int, int, float, float, float, int]],
) -> list[tuple[int, str]]:
    """Map legacy split rows to config_signature values.

    Duplicate detection matches the UNIQUE scope ``(dataset_version_id, config_signature)``.
    Rows must be ``(id, dataset_version_id, train_ratio, val_ratio, test_ratio, random_seed)``
    ordered by ``id`` ascending so the first row keeps the canonical signature.
    """
    used: set[tuple[int, str]] = set()
    assigned: list[tuple[int, str]] = []
    for row_id, dataset_version_id, train_ratio, val_ratio, test_ratio, random_seed in rows:
        canonical = _signature(train_ratio, val_ratio, test_ratio, random_seed)
        key = (int(dataset_version_id), canonical)
        if key in used:
            signature = f"{canonical}#legacy-{row_id}"
        else:
            signature = canonical
        used.add((int(dataset_version_id), signature))
        assigned.append((int(row_id), signature))
    return assigned


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
            "SELECT id, dataset_version_id, train_ratio, val_ratio, test_ratio, random_seed "
            "FROM dataset_splits ORDER BY id"
        )
    ).fetchall()
    assigned = assign_legacy_config_signatures(
        [
            (
                row.id,
                row.dataset_version_id,
                row.train_ratio,
                row.val_ratio,
                row.test_ratio,
                row.random_seed,
            )
            for row in rows
        ]
    )
    for row_id, signature in assigned:
        connection.execute(
            sa.text(
                "UPDATE dataset_splits SET config_signature = :signature WHERE id = :id"
            ),
            {"signature": signature, "id": row_id},
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
