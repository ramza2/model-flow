"""Shared helpers for SQLAlchemy-backed relational connectors.

Postgres, MySQL/MariaDB, and later SQL Server/Oracle keep driver URL
construction, connect args, and transaction read-only semantics in the
concrete connector. Only truly shared read-path behavior lives here.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Any, Iterator
from urllib.parse import quote_plus, urlparse, urlunparse

import pandas as pd
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Connection, Engine

from app.connectors.base import ConnectorPreview, DataConnector, frame_preview

_TABLE_NAME = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$"
)

# Side-effect / locking forms that look like SELECT/WITH but must not import.
_FORBIDDEN_SELECT_FORMS = (
    re.compile(r"\binto\s+outfile\b", re.IGNORECASE),
    re.compile(r"\binto\s+dumpfile\b", re.IGNORECASE),
    re.compile(r"\bfor\s+update\b", re.IGNORECASE),
    re.compile(r"\block\s+in\s+share\s+mode\b", re.IGNORECASE),
)


def quote_identifier(engine: Engine, name: str) -> str:
    return engine.dialect.identifier_preparer.quote_identifier(name)


def validate_table_name(value: str) -> bool:
    return bool(_TABLE_NAME.fullmatch(value))


def strip_sql_literals_and_comments(sql: str) -> str:
    """Strip comments/literals for keyword checks.

    Ordinary comments are replaced with a space so ``INTO/**/OUTFILE`` cannot
    glue into a bypass. MySQL ``/*! ... */`` executable comments are rejected
    fail-closed rather than treated as inert comments.
    """
    out: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            while i < n and sql[i] not in "\r\n":
                i += 1
            out.append(" ")
            continue
        if ch == "/" and nxt == "*":
            # MySQL executable comments are not inert; refuse them.
            if i + 2 < n and sql[i + 2] == "!":
                raise ValueError(
                    "Data imports accept only a read-only SELECT or table name."
                )
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i = min(i + 2, n)
            out.append(" ")
            continue
        if ch == "#":
            while i < n and sql[i] not in "\r\n":
                i += 1
            out.append(" ")
            continue
        if ch in {"'", '"', "`"}:
            quote = ch
            out.append(" ")
            i += 1
            while i < n:
                if sql[i] == "\\" and i + 1 < n:
                    i += 2
                    continue
                if sql[i] == quote:
                    # SQL '' escape inside single quotes
                    if quote == "'" and i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def reject_select_side_effects(sql: str) -> None:
    cleaned = strip_sql_literals_and_comments(sql)
    for pattern in _FORBIDDEN_SELECT_FORMS:
        if pattern.search(cleaned):
            raise ValueError(
                "Data imports accept only a read-only SELECT or table name."
            )


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
    reject_select_side_effects(value)
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

    @contextmanager
    def _read_only_transaction(self, connection: Connection) -> Iterator[Connection]:
        """PostgreSQL: begin, then SET TRANSACTION READ ONLY for this txn."""
        with connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            yield connection

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
            with engine.connect() as connection:
                with self._read_only_transaction(connection):
                    return pd.read_sql_query(text(query), connection)
        finally:
            engine.dispose()

    def preview(self, resource: str, limit: int = 20) -> ConnectorPreview:
        return frame_preview(self._read(resource, limit=limit), limit)

    def read_frame(self, resource: str) -> pd.DataFrame:
        return self._read(resource)
