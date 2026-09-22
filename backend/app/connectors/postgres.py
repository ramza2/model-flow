from __future__ import annotations

from urllib.parse import urlparse, urlunparse

from app.connectors.sql_relational import SqlAlchemyRelationalConnector

_ALLOWED_POSTGRES_URL_SCHEMES = frozenset(
    {"postgresql", "postgres", "postgresql+psycopg2"}
)


def normalize_postgres_sqlalchemy_url(raw: str) -> str:
    """Accept only PostgreSQL URL schemes; never echo credentials."""
    value = raw.strip()
    if not value:
        raise ValueError("Connection URL / DSN is required.")
    parsed = urlparse(value)
    scheme = (parsed.scheme or "").lower()
    if not scheme:
        raise ValueError("Connection URL / DSN must include a scheme.")
    if scheme not in _ALLOWED_POSTGRES_URL_SCHEMES:
        raise ValueError(
            "PostgreSQL connection URL must use a postgresql or postgres scheme."
        )
    if scheme in {"postgresql", "postgres"}:
        return urlunparse(parsed._replace(scheme="postgresql+psycopg2"))
    return value


class PostgresConnector(SqlAlchemyRelationalConnector):
    source_label = "PostgreSQL data source"
    connection_failure_message = (
        "Connection failed. Check the host, database, and credentials."
    )
    default_port = 5432
    sqlalchemy_drivername = "postgresql+psycopg2"
    connect_args = {"connect_timeout": 5}

    # PostgreSQL keeps SET TRANSACTION READ ONLY from the shared base.

    def _secret_url(self) -> str | None:
        raw = self.secrets.get("url") or self.secrets.get("dsn")
        if not raw:
            return None
        return normalize_postgres_sqlalchemy_url(str(raw))
