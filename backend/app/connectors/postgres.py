from __future__ import annotations

from app.connectors.sql_relational import SqlAlchemyRelationalConnector


class PostgresConnector(SqlAlchemyRelationalConnector):
    source_label = "PostgreSQL data source"
    connection_failure_message = (
        "Connection failed. Check the host, database, and credentials."
    )
    default_port = 5432
    sqlalchemy_drivername = "postgresql+psycopg2"
    connect_args = {"connect_timeout": 5}

    # PostgreSQL keeps SET TRANSACTION READ ONLY from the shared base.
