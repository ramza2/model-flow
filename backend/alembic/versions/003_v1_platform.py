"""ModelFlow v1 platform schema.

Revision ID: 003_v1_platform
Revises: 002_worker_heartbeats
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "003_v1_platform"
down_revision = "002_worker_heartbeats"
branch_labels = None
depends_on = None


JOB_STATUS = postgresql.ENUM(
    "pending",
    "queued",
    "running",
    "cancel_requested",
    "cancelled",
    "succeeded",
    "failed",
    name="jobstatus",
    create_type=False,
)
PROJECT_ROLE = postgresql.ENUM(
    "PROJECT_ADMIN",
    "ML_ENGINEER",
    "DATA_SCIENTIST",
    "VIEWER",
    name="projectrole",
    create_type=False,
)
DATA_SOURCE_TYPE = postgresql.ENUM(
    "file",
    "postgres",
    name="datasourcetype",
    create_type=False,
)
QUALITY_RESULT = postgresql.ENUM(
    "PASS",
    "WARNING",
    "FAIL",
    name="qualityresult",
    create_type=False,
)
MODEL_LIFECYCLE = postgresql.ENUM(
    "CANDIDATE",
    "VALIDATING",
    "PENDING_APPROVAL",
    "APPROVED",
    "PRODUCTION",
    "REJECTED",
    "ARCHIVED",
    name="modellifecycle",
    create_type=False,
)
PIPELINE_STATUS = postgresql.ENUM(
    "draft",
    "published",
    name="pipelinestatus",
    create_type=False,
)
ALERT_SEVERITY = postgresql.ENUM(
    "info",
    "warning",
    "error",
    "critical",
    name="alertseverity",
    create_type=False,
)


def _create_enum_types() -> None:
    bind = op.get_bind()
    PROJECT_ROLE.create(bind, checkfirst=True)
    DATA_SOURCE_TYPE.create(bind, checkfirst=True)
    QUALITY_RESULT.create(bind, checkfirst=True)
    MODEL_LIFECYCLE.create(bind, checkfirst=True)
    PIPELINE_STATUS.create(bind, checkfirst=True)
    ALERT_SEVERITY.create(bind, checkfirst=True)


def upgrade() -> None:
    # PostgreSQL enum additions need an autocommit block on versions where a newly
    # added value cannot be used until the transaction that added it is committed.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE jobstatus ADD VALUE IF NOT EXISTS 'queued'")
        op.execute("ALTER TYPE jobstatus ADD VALUE IF NOT EXISTS 'cancel_requested'")
        op.execute("ALTER TYPE jobstatus ADD VALUE IF NOT EXISTS 'cancelled'")

    _create_enum_types()

    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("full_name", sa.String(200), nullable=False, server_default=""),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_system_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("failed_login_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.add_column("projects", sa.Column("created_by", sa.Integer(), nullable=True))
    op.add_column(
        "projects",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column("projects", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key("fk_projects_created_by_users", "projects", "users", ["created_by"], ["id"])
    op.alter_column("projects", "created_at", existing_type=sa.DateTime(timezone=True), nullable=False)

    op.create_table(
        "project_memberships",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", PROJECT_ROLE, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_user"),
    )
    op.create_index(
        "ix_project_memberships_project_id", "project_memberships", ["project_id"]
    )
    op.create_index("ix_project_memberships_user_id", "project_memberships", ["user_id"])

    op.add_column(
        "datasets", sa.Column("description", sa.Text(), nullable=False, server_default="")
    )
    op.add_column(
        "datasets", sa.Column("latest_version", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("datasets", sa.Column("created_by", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_datasets_created_by_users", "datasets", "users", ["created_by"], ["id"])
    op.create_index("ix_datasets_project_id", "datasets", ["project_id"])
    op.execute(
        "UPDATE datasets SET row_count = 0 WHERE row_count IS NULL; "
        "UPDATE datasets SET column_count = 0 WHERE column_count IS NULL; "
        "UPDATE datasets SET columns_json = '[]' WHERE columns_json IS NULL; "
        "UPDATE datasets SET stats_json = '{}' WHERE stats_json IS NULL"
    )
    for column, existing_type in (
        ("row_count", sa.Integer()),
        ("column_count", sa.Integer()),
        ("columns_json", sa.Text()),
        ("stats_json", sa.Text()),
        ("created_at", sa.DateTime(timezone=True)),
    ):
        op.alter_column("datasets", column, existing_type=existing_type, nullable=False)

    op.create_table(
        "data_sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("source_type", DATA_SOURCE_TYPE, nullable=False),
        sa.Column("config_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("secret_encrypted", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_test_status", sa.String(50), nullable=True),
        sa.Column("last_test_message", sa.Text(), nullable=True),
        sa.Column("last_tested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_data_sources_project_id", "data_sources", ["project_id"])

    op.create_table(
        "dataset_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id"), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("object_key", sa.String(500), nullable=False),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("format", sa.String(50), nullable=False, server_default="csv"),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("column_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("columns_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("dtypes_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("stats_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("preview_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("source_type", sa.String(50), nullable=False, server_default="upload"),
        sa.Column("data_source_id", sa.Integer(), sa.ForeignKey("data_sources.id"), nullable=True),
        sa.Column("import_job_id", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("dataset_id", "version", name="uq_dataset_version"),
    )
    op.create_index("ix_dataset_versions_dataset_id", "dataset_versions", ["dataset_id"])
    op.create_index("ix_dataset_versions_project_id", "dataset_versions", ["project_id"])

    op.create_table(
        "data_import_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("data_source_id", sa.Integer(), sa.ForeignKey("data_sources.id"), nullable=False),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id"), nullable=True),
        sa.Column(
            "dataset_version_id", sa.Integer(), sa.ForeignKey("dataset_versions.id"), nullable=True
        ),
        sa.Column("query_or_table", sa.Text(), nullable=False),
        sa.Column("status", JOB_STATUS, nullable=False, server_default="pending"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_data_import_jobs_project_id", "data_import_jobs", ["project_id"])

    op.create_table(
        "quality_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("rules_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("block_training_on_fail", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_quality_rules_project_id", "quality_rules", ["project_id"])

    op.create_table(
        "quality_checks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column(
            "quality_rule_id", sa.Integer(), sa.ForeignKey("quality_rules.id"), nullable=True
        ),
        sa.Column("result", QUALITY_RESULT, nullable=False),
        sa.Column("details_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_quality_checks_project_id", "quality_checks", ["project_id"])

    op.create_table(
        "dataset_splits",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False, server_default="default"),
        sa.Column("train_ratio", sa.Float(), nullable=False, server_default="0.7"),
        sa.Column("val_ratio", sa.Float(), nullable=False, server_default="0.15"),
        sa.Column("test_ratio", sa.Float(), nullable=False, server_default="0.15"),
        sa.Column("random_seed", sa.Integer(), nullable=False, server_default="42"),
        sa.Column("train_object_key", sa.String(500), nullable=False, server_default=""),
        sa.Column("val_object_key", sa.String(500), nullable=False, server_default=""),
        sa.Column("test_object_key", sa.String(500), nullable=False, server_default=""),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_dataset_splits_project_id", "dataset_splits", ["project_id"])

    op.add_column("training_jobs", sa.Column("dataset_version_id", sa.Integer(), nullable=True))
    op.add_column("training_jobs", sa.Column("split_id", sa.Integer(), nullable=True))
    op.add_column(
        "training_jobs", sa.Column("description", sa.Text(), nullable=False, server_default="")
    )
    op.add_column(
        "training_jobs",
        sa.Column("problem_type", sa.String(50), nullable=False, server_default="auto"),
    )
    op.add_column(
        "training_jobs",
        sa.Column("preprocessing_json", sa.Text(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "training_jobs",
        sa.Column("feature_columns_json", sa.Text(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "training_jobs",
        sa.Column("metrics_config_json", sa.Text(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "training_jobs", sa.Column("resource_json", sa.Text(), nullable=False, server_default="{}")
    )
    op.add_column(
        "training_jobs", sa.Column("random_seed", sa.Integer(), nullable=False, server_default="42")
    )
    op.add_column(
        "training_jobs", sa.Column("train_ratio", sa.Float(), nullable=False, server_default="0.7")
    )
    op.add_column(
        "training_jobs", sa.Column("val_ratio", sa.Float(), nullable=False, server_default="0.15")
    )
    op.add_column(
        "training_jobs", sa.Column("test_ratio", sa.Float(), nullable=False, server_default="0.15")
    )
    op.add_column(
        "training_jobs", sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "training_jobs", sa.Column("max_retries", sa.Integer(), nullable=False, server_default="1")
    )
    op.add_column("training_jobs", sa.Column("created_by", sa.Integer(), nullable=True))
    op.add_column("training_jobs", sa.Column("parent_job_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_training_jobs_dataset_version",
        "training_jobs",
        "dataset_versions",
        ["dataset_version_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_training_jobs_split", "training_jobs", "dataset_splits", ["split_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_training_jobs_created_by", "training_jobs", "users", ["created_by"], ["id"]
    )
    op.create_foreign_key(
        "fk_training_jobs_parent", "training_jobs", "training_jobs", ["parent_job_id"], ["id"]
    )
    op.create_index("ix_training_jobs_project_id", "training_jobs", ["project_id"])
    op.execute(
        "UPDATE training_jobs SET algorithm = 'random_forest' WHERE algorithm IS NULL; "
        "UPDATE training_jobs SET hyperparameters_json = '{}' WHERE hyperparameters_json IS NULL; "
        "UPDATE training_jobs SET status = 'pending' WHERE status IS NULL; "
        "UPDATE training_jobs SET logs = '' WHERE logs IS NULL; "
        "UPDATE training_jobs SET metrics_json = '{}' WHERE metrics_json IS NULL"
    )
    for column, existing_type in (
        ("algorithm", sa.String(100)),
        ("hyperparameters_json", sa.Text()),
        ("status", JOB_STATUS),
        ("logs", sa.Text()),
        ("metrics_json", sa.Text()),
        ("created_at", sa.DateTime(timezone=True)),
    ):
        op.alter_column("training_jobs", column, existing_type=existing_type, nullable=False)

    # This table must precede the endpoints.model_version_id foreign key.
    op.create_table(
        "model_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("version", sa.String(50), nullable=False),
        sa.Column(
            "lifecycle", MODEL_LIFECYCLE, nullable=False, server_default="CANDIDATE"
        ),
        sa.Column("mlflow_model_name", sa.String(200), nullable=False),
        sa.Column("mlflow_version", sa.String(50), nullable=False),
        sa.Column("mlflow_run_id", sa.String(64), nullable=True),
        sa.Column("model_uri", sa.String(500), nullable=False),
        sa.Column("metrics_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column(
            "dataset_version_id", sa.Integer(), sa.ForeignKey("dataset_versions.id"), nullable=True
        ),
        sa.Column(
            "training_job_id", sa.Integer(), sa.ForeignKey("training_jobs.id"), nullable=True
        ),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=True),
        sa.Column("gate_results_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("gates_passed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("approval_comment", sa.Text(), nullable=True),
        sa.Column("approved_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("project_id", "name", "version", name="uq_model_name_ver"),
    )
    op.create_index("ix_model_versions_project_id", "model_versions", ["project_id"])

    op.add_column("endpoints", sa.Column("model_version_id", sa.Integer(), nullable=True))
    op.add_column(
        "endpoints", sa.Column("success_count", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "endpoints", sa.Column("error_count", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "endpoints", sa.Column("latency_sum_ms", sa.Float(), nullable=False, server_default="0")
    )
    op.add_column(
        "endpoints", sa.Column("latency_p95_ms", sa.Float(), nullable=False, server_default="0")
    )
    op.add_column(
        "endpoints",
        sa.Column("feature_schema_json", sa.Text(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "endpoints",
        sa.Column("recent_errors_json", sa.Text(), nullable=False, server_default="[]"),
    )
    op.add_column("endpoints", sa.Column("previous_model_version", sa.String(50), nullable=True))
    op.add_column("endpoints", sa.Column("previous_model_uri", sa.String(500), nullable=True))
    op.add_column("endpoints", sa.Column("created_by", sa.Integer(), nullable=True))
    op.add_column(
        "endpoints",
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_foreign_key(
        "fk_endpoints_model_version",
        "endpoints",
        "model_versions",
        ["model_version_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_endpoints_created_by_users", "endpoints", "users", ["created_by"], ["id"]
    )
    op.create_index("ix_endpoints_project_id", "endpoints", ["project_id"])
    op.execute(
        "UPDATE endpoints SET status = 'ready' WHERE status IS NULL; "
        "UPDATE endpoints SET request_count = 0 WHERE request_count IS NULL"
    )
    for column, existing_type in (
        ("status", sa.String(50)),
        ("request_count", sa.Integer()),
        ("created_at", sa.DateTime(timezone=True)),
    ):
        op.alter_column("endpoints", column, existing_type=existing_type, nullable=False)

    op.create_table(
        "pipelines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", PIPELINE_STATUS, nullable=False, server_default="draft"),
        sa.Column("latest_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_template", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_pipelines_project_id", "pipelines", ["project_id"])

    op.create_table(
        "pipeline_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("pipeline_id", sa.Integer(), sa.ForeignKey("pipelines.id"), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("graph_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("pipeline_id", "version", name="uq_pipeline_version"),
    )
    op.create_index("ix_pipeline_versions_pipeline_id", "pipeline_versions", ["pipeline_id"])

    op.create_table(
        "pipeline_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("pipeline_id", sa.Integer(), sa.ForeignKey("pipelines.id"), nullable=False),
        sa.Column(
            "pipeline_version_id",
            sa.Integer(),
            sa.ForeignKey("pipeline_versions.id"),
            nullable=False,
        ),
        sa.Column("status", JOB_STATUS, nullable=False, server_default="pending"),
        sa.Column("parameters_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("node_states_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("logs", sa.Text(), nullable=False, server_default=""),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("fail_policy", sa.String(50), nullable=False, server_default="stop"),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_pipeline_runs_project_id", "pipeline_runs", ["project_id"])

    op.create_table(
        "batch_inference_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "dataset_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=True),
        sa.Column(
            "model_version_id", sa.Integer(), sa.ForeignKey("model_versions.id"), nullable=True
        ),
        sa.Column("status", JOB_STATUS, nullable=False, server_default="pending"),
        sa.Column("result_object_key", sa.String(500), nullable=True),
        sa.Column("result_format", sa.String(20), nullable=False, server_default="csv"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("failure_details_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_batch_inference_jobs_project_id", "batch_inference_jobs", ["project_id"]
    )

    op.create_table(
        "drift_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "reference_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column(
            "current_version_id",
            sa.Integer(),
            sa.ForeignKey("dataset_versions.id"),
            nullable=False,
        ),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=True),
        sa.Column("status", JOB_STATUS, nullable=False, server_default="pending"),
        sa.Column("overall_status", sa.String(50), nullable=True),
        sa.Column("results_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("thresholds_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_drift_runs_project_id", "drift_runs", ["project_id"])

    op.create_table(
        "retrain_triggers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("trigger_type", sa.String(50), nullable=False),
        sa.Column("config_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("last_triggered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_training_job_id",
            sa.Integer(),
            sa.ForeignKey("training_jobs.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_retrain_triggers_project_id", "retrain_triggers", ["project_id"])

    op.create_table(
        "alerts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=True),
        sa.Column("alert_type", sa.String(100), nullable=False),
        sa.Column("severity", ALERT_SEVERITY, nullable=False, server_default="info"),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
        sa.Column("resource_type", sa.String(100), nullable=True),
        sa.Column("resource_id", sa.String(100), nullable=True),
        sa.Column("link_path", sa.String(500), nullable=True),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_resolved", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_alerts_project_id", "alerts", ["project_id"])
    op.create_index("ix_alerts_project_unread", "alerts", ["project_id", "is_read"])

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("user_email", sa.String(320), nullable=True),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("resource_type", sa.String(100), nullable=False),
        sa.Column("resource_id", sa.String(100), nullable=True),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("ip_address", sa.String(100), nullable=True),
        sa.Column("request_id", sa.String(100), nullable=True),
        sa.Column("before_summary", sa.Text(), nullable=True),
        sa.Column("after_summary", sa.Text(), nullable=True),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_audit_created", "audit_logs", ["created_at"])
    op.create_index("ix_audit_action", "audit_logs", ["action"])

    op.create_table(
        "inference_stats",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("endpoint_id", sa.Integer(), sa.ForeignKey("endpoints.id"), nullable=False),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("latency_ms", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error_class", sa.String(100), nullable=True),
        sa.Column("payload_json", sa.Text(), nullable=True),
        sa.Column("prediction_summary", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_inference_stats_endpoint_id", "inference_stats", ["endpoint_id"])
    op.create_index("ix_inference_stats_project_id", "inference_stats", ["project_id"])

    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(100), primary_key=True),
        sa.Column("value_json", sa.Text(), nullable=False, server_default="null"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
    )

    op.add_column(
        "worker_heartbeats",
        sa.Column("status_json", sa.Text(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("worker_heartbeats", "status_json")

    op.drop_table("system_settings")
    op.drop_index("ix_inference_stats_project_id", table_name="inference_stats")
    op.drop_index("ix_inference_stats_endpoint_id", table_name="inference_stats")
    op.drop_table("inference_stats")
    op.drop_index("ix_audit_action", table_name="audit_logs")
    op.drop_index("ix_audit_created", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_index("ix_alerts_project_unread", table_name="alerts")
    op.drop_index("ix_alerts_project_id", table_name="alerts")
    op.drop_table("alerts")
    op.drop_index("ix_retrain_triggers_project_id", table_name="retrain_triggers")
    op.drop_table("retrain_triggers")
    op.drop_index("ix_drift_runs_project_id", table_name="drift_runs")
    op.drop_table("drift_runs")
    op.drop_index("ix_batch_inference_jobs_project_id", table_name="batch_inference_jobs")
    op.drop_table("batch_inference_jobs")
    op.drop_index("ix_pipeline_runs_project_id", table_name="pipeline_runs")
    op.drop_table("pipeline_runs")
    op.drop_index("ix_pipeline_versions_pipeline_id", table_name="pipeline_versions")
    op.drop_table("pipeline_versions")
    op.drop_index("ix_pipelines_project_id", table_name="pipelines")
    op.drop_table("pipelines")

    op.drop_index("ix_endpoints_project_id", table_name="endpoints")
    op.drop_constraint("fk_endpoints_created_by_users", "endpoints", type_="foreignkey")
    op.drop_constraint("fk_endpoints_model_version", "endpoints", type_="foreignkey")
    for column in (
        "updated_at",
        "created_by",
        "previous_model_uri",
        "previous_model_version",
        "recent_errors_json",
        "feature_schema_json",
        "latency_p95_ms",
        "latency_sum_ms",
        "error_count",
        "success_count",
        "model_version_id",
    ):
        op.drop_column("endpoints", column)
    for column, existing_type in (
        ("status", sa.String(50)),
        ("request_count", sa.Integer()),
        ("created_at", sa.DateTime(timezone=True)),
    ):
        op.alter_column("endpoints", column, existing_type=existing_type, nullable=True)

    op.drop_index("ix_model_versions_project_id", table_name="model_versions")
    op.drop_table("model_versions")

    op.drop_index("ix_training_jobs_project_id", table_name="training_jobs")
    op.drop_constraint("fk_training_jobs_parent", "training_jobs", type_="foreignkey")
    op.drop_constraint("fk_training_jobs_created_by", "training_jobs", type_="foreignkey")
    op.drop_constraint("fk_training_jobs_split", "training_jobs", type_="foreignkey")
    op.drop_constraint("fk_training_jobs_dataset_version", "training_jobs", type_="foreignkey")
    for column in (
        "parent_job_id",
        "created_by",
        "max_retries",
        "retry_count",
        "test_ratio",
        "val_ratio",
        "train_ratio",
        "random_seed",
        "resource_json",
        "metrics_config_json",
        "feature_columns_json",
        "preprocessing_json",
        "problem_type",
        "description",
        "split_id",
        "dataset_version_id",
    ):
        op.drop_column("training_jobs", column)
    for column, existing_type in (
        ("algorithm", sa.String(100)),
        ("hyperparameters_json", sa.Text()),
        ("status", JOB_STATUS),
        ("logs", sa.Text()),
        ("metrics_json", sa.Text()),
        ("created_at", sa.DateTime(timezone=True)),
    ):
        op.alter_column("training_jobs", column, existing_type=existing_type, nullable=True)

    op.drop_index("ix_dataset_splits_project_id", table_name="dataset_splits")
    op.drop_table("dataset_splits")
    op.drop_index("ix_quality_checks_project_id", table_name="quality_checks")
    op.drop_table("quality_checks")
    op.drop_index("ix_quality_rules_project_id", table_name="quality_rules")
    op.drop_table("quality_rules")
    op.drop_index("ix_data_import_jobs_project_id", table_name="data_import_jobs")
    op.drop_table("data_import_jobs")
    op.drop_index("ix_dataset_versions_project_id", table_name="dataset_versions")
    op.drop_index("ix_dataset_versions_dataset_id", table_name="dataset_versions")
    op.drop_table("dataset_versions")
    op.drop_index("ix_data_sources_project_id", table_name="data_sources")
    op.drop_table("data_sources")

    op.drop_index("ix_datasets_project_id", table_name="datasets")
    op.drop_constraint("fk_datasets_created_by_users", "datasets", type_="foreignkey")
    op.drop_column("datasets", "created_by")
    op.drop_column("datasets", "latest_version")
    op.drop_column("datasets", "description")
    for column, existing_type in (
        ("row_count", sa.Integer()),
        ("column_count", sa.Integer()),
        ("columns_json", sa.Text()),
        ("stats_json", sa.Text()),
        ("created_at", sa.DateTime(timezone=True)),
    ):
        op.alter_column("datasets", column, existing_type=existing_type, nullable=True)

    op.drop_index("ix_project_memberships_user_id", table_name="project_memberships")
    op.drop_index("ix_project_memberships_project_id", table_name="project_memberships")
    op.drop_table("project_memberships")
    op.drop_constraint("fk_projects_created_by_users", "projects", type_="foreignkey")
    op.drop_column("projects", "deleted_at")
    op.drop_column("projects", "is_active")
    op.drop_column("projects", "created_by")
    op.alter_column(
        "projects", "created_at", existing_type=sa.DateTime(timezone=True), nullable=True
    )
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")

    bind = op.get_bind()
    for enum_type in (
        ALERT_SEVERITY,
        PIPELINE_STATUS,
        MODEL_LIFECYCLE,
        QUALITY_RESULT,
        DATA_SOURCE_TYPE,
        PROJECT_ROLE,
    ):
        enum_type.drop(bind, checkfirst=True)

    # PostgreSQL cannot remove individual enum values safely in-place. The three
    # jobstatus values remain after downgrade and are harmless to the v2 schema.
