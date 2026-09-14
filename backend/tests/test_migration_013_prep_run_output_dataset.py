"""Migration 013 preparation run output_dataset_id upgrade/downgrade smoke."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.core.config import settings
from app.db.models import DatasetPreparationRun

BACKEND = Path(__file__).resolve().parents[1]


def _alembic_config() -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    return cfg


def test_migration_013_upgrade_downgrade_roundtrip(tmp_path, monkeypatch):
    """Apply 013 against a Phase 2-A-shaped SQLite schema (no Postgres ENUM deps)."""
    db_path = tmp_path / "mig013.sqlite"
    db_url = f"sqlite+pysqlite:///{db_path}"
    monkeypatch.setattr(settings, "database_url", db_url)

    engine = create_engine(db_url)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE projects (id INTEGER PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE datasets (id INTEGER PRIMARY KEY)"))
        conn.execute(
            text(
                """
                CREATE TABLE dataset_preparation_runs (
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER NOT NULL,
                    preparation_id INTEGER NOT NULL,
                    preparation_version_id INTEGER NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    output_dataset_version_id INTEGER,
                    logs TEXT NOT NULL DEFAULT '',
                    error_message TEXT,
                    created_by INTEGER,
                    created_at DATETIME,
                    started_at DATETIME,
                    finished_at DATETIME
                )
                """
            )
        )

    cfg = _alembic_config()
    command.stamp(cfg, "012_dataset_prep_foundation")

    with engine.connect() as conn:
        cols = {c["name"] for c in inspect(conn).get_columns("dataset_preparation_runs")}
        assert "output_dataset_id" not in cols
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "012_dataset_prep_foundation"
        assert len(str(version)) <= 32

    command.upgrade(cfg, "013_prep_run_output_dataset")
    with engine.connect() as conn:
        cols = {c["name"] for c in inspect(conn).get_columns("dataset_preparation_runs")}
        assert "output_dataset_id" in cols
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "013_prep_run_output_dataset"
        assert len(str(version)) <= 32

    command.downgrade(cfg, "012_dataset_prep_foundation")
    with engine.connect() as conn:
        cols = {c["name"] for c in inspect(conn).get_columns("dataset_preparation_runs")}
        assert "output_dataset_id" not in cols
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "012_dataset_prep_foundation"

    command.upgrade(cfg, "013_prep_run_output_dataset")
    with engine.connect() as conn:
        cols = {c["name"] for c in inspect(conn).get_columns("dataset_preparation_runs")}
        assert "output_dataset_id" in cols
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "013_prep_run_output_dataset"

    assert hasattr(DatasetPreparationRun, "output_dataset_id")
