"""Add model_gate_policies and link model_versions.

Revision ID: 005_model_gate_policies
Revises: 004_pipeline_runtime
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa


revision = "005_model_gate_policies"
down_revision = "004_pipeline_runtime"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "model_gate_policies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False, server_default="default"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("metric_name", sa.String(100), nullable=True),
        sa.Column("metric_minimum", sa.Float(), nullable=True),
        sa.Column("metric_maximum", sa.Float(), nullable=True),
        sa.Column("max_inference_latency_ms", sa.Float(), nullable=False, server_default="5000"),
        sa.Column("require_artifact", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("require_schema", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("require_model_load", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("require_test_inference", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("require_mlflow_project", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("project_id", "name", "version", name="uq_gate_policy_name_ver"),
    )
    op.create_index("ix_model_gate_policies_project_id", "model_gate_policies", ["project_id"])
    op.create_index(
        "ix_gate_policy_project_active",
        "model_gate_policies",
        ["project_id", "is_active"],
    )
    op.add_column(
        "model_versions",
        sa.Column("gate_policy_id", sa.Integer(), sa.ForeignKey("model_gate_policies.id"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("model_versions", "gate_policy_id")
    op.drop_index("ix_gate_policy_project_active", table_name="model_gate_policies")
    op.drop_index("ix_model_gate_policies_project_id", table_name="model_gate_policies")
    op.drop_table("model_gate_policies")
