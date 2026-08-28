"""Add automation schedules and schedule run history.

Revision ID: 009_automation_schedules
Revises: 008_service_api_keys
Create Date: 2026-08-28
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "009_automation_schedules"
down_revision = "008_service_api_keys"
branch_labels = None
depends_on = None

SCHEDULE_TARGET_TYPE = postgresql.ENUM(
    "data_import",
    "batch_inference",
    "pipeline_run",
    name="scheduletargettype",
    create_type=False,
)
CONCURRENCY_POLICY = postgresql.ENUM(
    "skip",
    "queue",
    name="concurrencypolicy",
    create_type=False,
)
SCHEDULE_RUN_STATUS = postgresql.ENUM(
    "pending",
    "dispatched",
    "running",
    "succeeded",
    "failed",
    "skipped",
    name="schedulerunstatus",
    create_type=False,
)
SCHEDULE_TRIGGER_SOURCE = postgresql.ENUM(
    "cron",
    "manual",
    name="scheduletriggersource",
    create_type=False,
)


def _create_enum_types() -> None:
    bind = op.get_bind()
    SCHEDULE_TARGET_TYPE.create(bind, checkfirst=True)
    CONCURRENCY_POLICY.create(bind, checkfirst=True)
    SCHEDULE_RUN_STATUS.create(bind, checkfirst=True)
    SCHEDULE_TRIGGER_SOURCE.create(bind, checkfirst=True)


def upgrade() -> None:
    _create_enum_types()
    op.create_table(
        "automation_schedules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("target_type", SCHEDULE_TARGET_TYPE, nullable=False),
        sa.Column("target_config_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("cron_expression", sa.String(length=120), nullable=False),
        sa.Column("timezone", sa.String(length=100), nullable=False, server_default="UTC"),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("concurrency_policy", CONCURRENCY_POLICY, nullable=False, server_default="skip"),
        sa.Column("max_concurrent_runs", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("max_retries", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("retry_delay_seconds", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
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
    )
    op.create_index(
        "ix_automation_schedules_project_id",
        "automation_schedules",
        ["project_id"],
    )
    op.create_index(
        "ix_automation_schedules_enabled_next_run",
        "automation_schedules",
        ["is_enabled", "next_run_at"],
    )

    op.create_table(
        "automation_schedule_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "schedule_id",
            sa.Integer(),
            sa.ForeignKey("automation_schedules.id"),
            nullable=False,
        ),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "trigger_source",
            SCHEDULE_TRIGGER_SOURCE,
            nullable=False,
            server_default="cron",
        ),
        sa.Column("status", SCHEDULE_RUN_STATUS, nullable=False, server_default="pending"),
        sa.Column("target_type", SCHEDULE_TARGET_TYPE, nullable=False),
        sa.Column("target_resource_id", sa.Integer(), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "schedule_id",
            "scheduled_for",
            "attempt",
            "trigger_source",
            name="uq_schedule_run_occurrence",
        ),
    )
    op.create_index(
        "ix_schedule_runs_schedule_id",
        "automation_schedule_runs",
        ["schedule_id"],
    )
    op.create_index(
        "ix_schedule_runs_project_id",
        "automation_schedule_runs",
        ["project_id"],
    )
    op.create_index(
        "ix_schedule_runs_status",
        "automation_schedule_runs",
        ["status"],
    )
    op.create_index(
        "ix_schedule_runs_ready_at",
        "automation_schedule_runs",
        ["ready_at"],
    )
    op.create_index(
        "ix_schedule_runs_scheduled_for",
        "automation_schedule_runs",
        ["scheduled_for"],
    )
    op.create_index(
        "ix_schedule_runs_dispatch",
        "automation_schedule_runs",
        ["status", "ready_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_schedule_runs_dispatch", table_name="automation_schedule_runs")
    op.drop_index("ix_schedule_runs_scheduled_for", table_name="automation_schedule_runs")
    op.drop_index("ix_schedule_runs_ready_at", table_name="automation_schedule_runs")
    op.drop_index("ix_schedule_runs_status", table_name="automation_schedule_runs")
    op.drop_index("ix_schedule_runs_project_id", table_name="automation_schedule_runs")
    op.drop_index("ix_schedule_runs_schedule_id", table_name="automation_schedule_runs")
    op.drop_table("automation_schedule_runs")
    op.drop_index(
        "ix_automation_schedules_enabled_next_run",
        table_name="automation_schedules",
    )
    op.drop_index("ix_automation_schedules_project_id", table_name="automation_schedules")
    op.drop_table("automation_schedules")
    bind = op.get_bind()
    SCHEDULE_TRIGGER_SOURCE.drop(bind, checkfirst=True)
    SCHEDULE_RUN_STATUS.drop(bind, checkfirst=True)
    CONCURRENCY_POLICY.drop(bind, checkfirst=True)
    SCHEDULE_TARGET_TYPE.drop(bind, checkfirst=True)
