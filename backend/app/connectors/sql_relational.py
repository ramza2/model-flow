"""Shared helpers for SQLAlchemy-backed relational connectors.

Postgres, MySQL/MariaDB, and later SQL Server/Oracle keep driver URL
construction, connect args, and transaction read-only semantics in the
concrete connector. Only truly shared read-path behavior lives here.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote_plus, urlparse, urlunparse

import pandas as pd
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

from app.connectors.base import ConnectorPreview, DataConnector, frame_preview

_TABLE_NAME = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$"
)


def quote_identifier(engine: Engine, name: str) -> str:
    return engine.dialect.identifier_preparer.quote_identifier(name)


def validate_table_name(value: str) -> bool:
    return bool(_TABLE_NAME.fullmatch(value))


def build_import_query(engine: Engine, resource: str) -> str:
    """Accept one table name or a single read-only SELECT / WITH statement."""
    value = resource.strip()
    if value.endswith(";"):
        value = value[:-1].rstrip()
    if not value or ";" in value:
        raise ValueError("Data imports accept one read-only SELECT or table name.")
    if validate_table_name(value):
        parts = value.split(".", 1)
        quoted = [quote_identifier(engine, part) for part in parts]
        return f"SELECT * FROM {'.'.join(quoted)}"
    if not re.match(r"^(select|with)\b", value, flags=re.IGNORECASE):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )
    return value


def wrap_preview_query(query: str, limit: int) -> str:
    return (
        "SELECT * FROM ("
        + query
        + f") AS modelflow_preview LIMIT {int(limit)}"
    )


def host_port_sqlalchemy_url(
    *,
    drivername: str,
    host: str,
    port: int,
    database: str,
    user: str,
    password: str = "",
) -> str:
    auth = quote_plus(user)
    if password:
        auth = f"{auth}:{quote_plus(password)}"
    db = quote_plus(database)
    return f"{drivername}://{auth}@{host}:{port}/{db}"


def normalize_sqlalchemy_url(raw: str, *, default_drivername: str) -> str:
    """Ensure a stored DSN/URL uses the connector's SQLAlchemy drivername.

    Accepts vendor URLs such as ``mysql://…`` / ``mariadb://…`` /
    ``postgresql://…`` and rewrites only the scheme when needed.
    """
    value = raw.strip()
    if not value:
        raise ValueError("Connection URL / DSN is required.")
    parsed = urlparse(value)
    if not parsed.scheme:
        raise ValueError("Connection URL / DSN must include a scheme.")
    scheme = parsed.scheme.lower()
    if "+" in scheme:
        return value
    # Bare vendor schemes → SQLAlchemy driver URL.
    return urlunparse(parsed._replace(scheme=default_drivername))


class SqlAlchemyRelationalConnector(DataConnector):
    """Relational connector base using SQLAlchemy Engine + Inspector."""

    supports_import = True
    default_port: int = 5432
    sqlalchemy_drivername: str = "postgresql+psycopg2"
    connect_args: dict[str, Any] = {"connect_timeout": 5}

    def __init__(self, config: dict, secrets: dict):
        self.config = config
        self.secrets = secrets

    def _secret_url(self) -> str | None:
        raw = self.secrets.get("url") or self.secrets.get("dsn")
        if not raw:
            return None
        return str(raw)

    def _connection_url(self) -> str:
        secret_url = self._secret_url()
        if secret_url:
            return secret_url
        required = ("host", "database", "user")
        missing = [
            key
            for key in required
            if not (self.config.get(key) or self.secrets.get(key))
        ]
        if missing:
            raise ValueError(f"Data source is missing: {', '.join(missing)}.")
        user = str(self.config.get("user") or self.secrets.get("user"))
        password = str(self.secrets.get("password", ""))
        host = str(self.config.get("host") or self.secrets.get("host"))
        port = int(
            self.config.get("port") or self.secrets.get("port") or self.default_port
        )
        database = str(self.config.get("database") or self.secrets.get("database"))
        return host_port_sqlalchemy_url(
            drivername=self.sqlalchemy_drivername,
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
        )

    def _engine(self) -> Engine:
        return create_engine(
            self._connection_url(),
            pool_pre_ping=True,
            connect_args=dict(self.connect_args),
        )

    @classmethod
    def _import_query(cls, engine: Engine, resource: str) -> str:
        return build_import_query(engine, resource)

    def _apply_read_only(self, connection) -> None:
        """Dialect-specific read-only transaction setup. Override per engine."""
        connection.execute(text("SET TRANSACTION READ ONLY"))

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
                query = wrap_preview_query(query, limit)
            with engine.connect() as connection, connection.begin():
                self._apply_read_only(connection)
                return pd.read_sql_query(text(query), connection)
        finally:
            engine.dispose()

    def preview(self, resource: str, limit: int = 20) -> ConnectorPreview:
        return frame_preview(self._read(resource, limit=limit), limit)

    def read_frame(self, resource: str) -> pd.DataFrame:
        return self._read(resource)
