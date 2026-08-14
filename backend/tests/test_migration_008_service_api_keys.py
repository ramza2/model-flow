"""Migration 008 service_api_keys upgrade/downgrade smoke tests."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.core.config import settings
from app.db.models import Base, ServiceApiKey

BACKEND = Path(__file__).resolve().parents[1]


def _alembic_config() -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    return cfg


def test_migration_008_upgrade_downgrade_roundtrip(tmp_path, monkeypatch):
    db_path = tmp_path / "mig008.sqlite"
    db_url = f"sqlite+pysqlite:///{db_path}"
    monkeypatch.setattr(settings, "database_url", db_url)

    engine = create_engine(db_url)
    tables = [t for t in Base.metadata.sorted_tables if t.name != ServiceApiKey.__tablename__]
    Base.metadata.create_all(engine, tables=tables)

    cfg = _alembic_config()
    command.stamp(cfg, "007_split_signature_hashes")

    with engine.connect() as conn:
        assert "service_api_keys" not in inspect(conn).get_table_names()
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "007_split_signature_hashes"

    command.upgrade(cfg, "008_service_api_keys")
    with engine.connect() as conn:
        assert "service_api_keys" in inspect(conn).get_table_names()
        cols = {c["name"] for c in inspect(conn).get_columns("service_api_keys")}
        assert {
            "id",
            "project_id",
            "endpoint_id",
            "name",
            "key_prefix",
            "key_hash",
            "is_active",
            "created_by",
            "created_at",
            "last_used_at",
            "expires_at",
            "revoked_at",
        } <= cols
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "008_service_api_keys"

    command.downgrade(cfg, "007_split_signature_hashes")
    with engine.connect() as conn:
        assert "service_api_keys" not in inspect(conn).get_table_names()
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "007_split_signature_hashes"

    command.upgrade(cfg, "008_service_api_keys")
    with engine.connect() as conn:
        assert "service_api_keys" in inspect(conn).get_table_names()
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert version == "008_service_api_keys"
