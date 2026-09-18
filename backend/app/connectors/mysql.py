from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import text
from sqlalchemy.engine import Connection

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

    @contextmanager
    def _read_only_transaction(self, connection: Connection) -> Iterator[Connection]:
        """Start the import transaction itself as READ ONLY.

        ``SET SESSION TRANSACTION READ ONLY`` only affects *subsequent*
        transactions, so it is useless after SQLAlchemy has already begun one.
        Use ``START TRANSACTION READ ONLY`` under AUTOCOMMIT so the statement
        that runs the import query is the read-only transaction.
        """
        autocommit = connection.execution_options(isolation_level="AUTOCOMMIT")
        autocommit.execute(text("START TRANSACTION READ ONLY"))
        try:
            yield connection
            autocommit.execute(text("COMMIT"))
        except Exception:
            try:
                autocommit.execute(text("ROLLBACK"))
            except Exception:
                pass
            raise
