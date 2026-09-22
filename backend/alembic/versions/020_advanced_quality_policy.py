"""Phase 5-C advanced quality policies.

Revision ID: 020_advanced_quality_policy
Revises: 019_feedback_materialization
Create Date: 2026-09-22
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "020_advanced_quality_policy"
down_revision: Union[str, None] = "019_feedback_materialization"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_quality_policies",
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "model_quality_policies",
        sa.Column(
            "evaluation_delay_hours",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "model_quality_policies",
        sa.Column("minimum_match_rate", sa.Float(), nullable=True),
    )
    op.add_column(
        "model_quality_policies",
        sa.Column(
            "rule_logic",
            sa.String(20),
            nullable=False,
            server_default="any",
        ),
    )
    op.add_column(
        "model_quality_policies",
        sa.Column(
            "rules_json",
            sa.Text(),
            nullable=False,
            server_default="[]",
        ),
    )

    op.add_column(
        "model_quality_runs",
        sa.Column("policy_revision", sa.Integer(), nullable=True),
    )
    op.add_column(
        "model_quality_runs",
        sa.Column(
            "policy_snapshot_json",
            sa.Text(),
            nullable=False,
            server_default="{}",
        ),
    )
    op.add_column(
        "model_quality_runs",
        sa.Column(
            "evaluation_json",
            sa.Text(),
            nullable=False,
            server_default="{}",
        ),
    )

    op.create_table(
        "model_quality_baselines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "policy_id",
            sa.Integer(),
            sa.ForeignKey("model_quality_policies.id"),
            nullable=False,
        ),
        sa.Column(
            "quality_run_id",
            sa.Integer(),
            sa.ForeignKey("model_quality_runs.id"),
            nullable=False,
        ),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=False),
        sa.Column(
            "model_version_id",
            sa.Integer(),
            sa.ForeignKey("model_versions.id"),
            nullable=False,
        ),
        sa.Column("metrics_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("matched_ground_truth_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("match_rate", sa.Float(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("policy_id", name="uq_model_quality_baselines_policy_id"),
    )
    op.create_index(
        "ix_model_quality_baselines_project_id",
        "model_quality_baselines",
        ["project_id"],
    )
    op.create_index(
        "ix_model_quality_baselines_quality_run_id",
        "model_quality_baselines",
        ["quality_run_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_model_quality_baselines_quality_run_id", table_name="model_quality_baselines")
    op.drop_index("ix_model_quality_baselines_project_id", table_name="model_quality_baselines")
    op.drop_table("model_quality_baselines")
    op.drop_column("model_quality_runs", "evaluation_json")
    op.drop_column("model_quality_runs", "policy_snapshot_json")
    op.drop_column("model_quality_runs", "policy_revision")
    op.drop_column("model_quality_policies", "rules_json")
    op.drop_column("model_quality_policies", "rule_logic")
    op.drop_column("model_quality_policies", "minimum_match_rate")
    op.drop_column("model_quality_policies", "evaluation_delay_hours")
    op.drop_column("model_quality_policies", "revision")
