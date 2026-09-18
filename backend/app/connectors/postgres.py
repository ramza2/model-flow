from __future__ import annotations

import re
from urllib.parse import quote_plus

import pandas as pd
from sqlalchemy import create_engine, inspect, text

from app.connectors.base import ConnectorPreview, DataConnector, frame_preview

_TABLE_NAME = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$"
)


class PostgresConnector(DataConnector):
    source_label = "PostgreSQL data source"
    connection_failure_message = (
        "Connection failed. Check the host, database, and credentials."
    )
    supports_import = True

    def __init__(self, config: dict, secrets: dict):
        self.config = config
        self.secrets = secrets

    def _connection_url(self) -> str:
        if self.secrets.get("url") or self.secrets.get("dsn"):
            return str(self.secrets.get("url") or self.secrets.get("dsn"))
        required = ("host", "database", "user")
        missing = [
            key
            for key in required
            if not (self.config.get(key) or self.secrets.get(key))
        ]
        if missing:
            raise ValueError(f"Data source is missing: {', '.join(missing)}.")
        user = quote_plus(str(self.config.get("user") or self.secrets.get("user")))
        password = quote_plus(str(self.secrets.get("password", "")))
        auth = f"{user}:{password}" if password else user
        host = str(self.config.get("host") or self.secrets.get("host"))
        port = int(self.config.get("port") or self.secrets.get("port") or 5432)
        database = quote_plus(
            str(self.config.get("database") or self.secrets.get("database"))
        )
        return f"postgresql+psycopg2://{auth}@{host}:{port}/{database}"

    def _engine(self):
        return create_engine(
            self._connection_url(),
            pool_pre_ping=True,
            connect_args={"connect_timeout": 5},
        )

    @staticmethod
    def _import_query(engine, resource: str) -> str:
        value = resource.strip()
        if value.endswith(";"):
            value = value[:-1].rstrip()
        if not value or ";" in value:
            raise ValueError(
                "Data imports accept one read-only SELECT or table name."
            )
        if _TABLE_NAME.fullmatch(value):
            parts = value.split(".", 1)
            quoted = [
                engine.dialect.identifier_preparer.quote_identifier(part)
                for part in parts
            ]
            return f"SELECT * FROM {'.'.join(quoted)}"
        if not re.match(r"^(select|with)\b", value, flags=re.IGNORECASE):
            raise ValueError(
                "Data imports accept only a read-only SELECT or table name."
            )
        return value

    def test_connection(self) -> str:
        engine = self._engine()
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return "Connection succeeded."
        finally:
            engine.dispose()

    def list_schemas(self) -> list[str]:
        engine = self._engine()
        try:
            return inspect(engine).get_schema_names()
        finally:
            engine.dispose()

    def list_tables(self, schema: str | None = None) -> list[dict[str, str | None]]:
        engine = self._engine()
        try:
            inspector = inspect(engine)
            return [
                {"schema": schema, "name": name}
                for name in inspector.get_table_names(schema=schema)
            ]
        finally:
            engine.dispose()

    def _read(self, resource: str, *, limit: int | None = None) -> pd.DataFrame:
        engine = self._engine()
        try:
            query = self._import_query(engine, resource)
            if limit is not None:
                query = (
                    "SELECT * FROM ("
                    + query
                    + f") AS modelflow_preview LIMIT {int(limit)}"
                )
            with engine.connect() as connection, connection.begin():
                connection.execute(text("SET TRANSACTION READ ONLY"))
                return pd.read_sql_query(text(query), connection)
        finally:
            engine.dispose()

    def preview(self, resource: str, limit: int = 20) -> ConnectorPreview:
        return frame_preview(self._read(resource, limit=limit), limit)

    def read_frame(self, resource: str) -> pd.DataFrame:
        return self._read(resource)
