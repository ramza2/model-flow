from __future__ import annotations

from sqlalchemy import text

from app.connectors.sql_relational import (
    SqlAlchemyRelationalConnector,
    normalize_sqlalchemy_url,
)


class MySqlConnector(SqlAlchemyRelationalConnector):
    """MySQL and MariaDB share one source type (`mysql`) and driver path."""

    source_label = "MySQL / MariaDB data source"
    connection_failure_message = (
        "Connection failed. Check the host, database, and credentials."
    )
    default_port = 3306
    sqlalchemy_drivername = "mysql+pymysql"
    # PyMySQL uses `connect_timeout` in seconds.
    connect_args = {"connect_timeout": 5}

    def _secret_url(self) -> str | None:
        raw = self.secrets.get("url") or self.secrets.get("dsn")
        if not raw:
            return None
        return normalize_sqlalchemy_url(
            str(raw), default_drivername=self.sqlalchemy_drivername
        )

    def _apply_read_only(self, connection) -> None:
        # MySQL/MariaDB accept session-level read-only transactions. Keep this
        # dialect-specific rather than forcing PostgreSQL's statement into a
        # shared helper.
        connection.execute(text("SET SESSION TRANSACTION READ ONLY"))
