from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app.connectors.mysql import MySqlConnector
from app.connectors.sql_relational import (
    host_port_sqlalchemy_url,
    normalize_sqlalchemy_url,
)


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


def test_mysql_host_port_url_encodes_password_and_defaults_port():
    connector = MySqlConnector(
        {"host": "mysql-source", "database": "analytics", "user": "reader"},
        {"password": "p@ss:word/1"},
    )
    url = connector._connection_url()
    assert url.startswith("mysql+pymysql://")
    assert "reader:p%40ss%3Aword%2F1@mysql-source:3306/analytics" in url


def test_mysql_connection_url_mode_normalizes_vendor_schemes():
    assert (
        normalize_sqlalchemy_url(
            "mysql://u:p@h:3306/db", default_drivername="mysql+pymysql"
        )
        == "mysql+pymysql://u:p@h:3306/db"
    )
    assert (
        normalize_sqlalchemy_url(
            "mariadb://u:p@h:3306/db", default_drivername="mysql+pymysql"
        )
        == "mysql+pymysql://u:p@h:3306/db"
    )
    connector = MySqlConnector({}, {"dsn": "mysql://u:p@h:3306/db"})
    assert connector._connection_url() == "mysql+pymysql://u:p@h:3306/db"
    # Already-drivered URLs stay untouched.
    assert (
        MySqlConnector({}, {"url": "mysql+pymysql://u:p@h:3306/db"})._connection_url()
        == "mysql+pymysql://u:p@h:3306/db"
    )


def test_mysql_host_port_helper_matches_connector():
    assert host_port_sqlalchemy_url(
        drivername="mysql+pymysql",
        host="db",
        port=3306,
        database="app",
        user="u",
        password="x y",
    ) == "mysql+pymysql://u:x+y@db:3306/app"


def test_mysql_import_query_allows_table_select_and_with_rejects_mutations():
    assert MySqlConnector._import_query(engine, "customers") == (
        'SELECT * FROM "customers"'
    )
    assert MySqlConnector._import_query(engine, "sales.customers") == (
        'SELECT * FROM "sales"."customers"'
    )
    assert MySqlConnector._import_query(engine, "SELECT id FROM customers;") == (
        "SELECT id FROM customers"
    )
    assert MySqlConnector._import_query(
        engine, "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte"
    ).lower().startswith("with ")
    with pytest.raises(ValueError, match="read-only"):
        MySqlConnector._import_query(engine, "DELETE FROM customers")
    with pytest.raises(ValueError, match="read-only"):
        MySqlConnector._import_query(engine, "INSERT INTO customers VALUES (1)")
    with pytest.raises(ValueError, match="read-only"):
        MySqlConnector._import_query(engine, "UPDATE customers SET name='x'")
    with pytest.raises(ValueError, match="read-only"):
        MySqlConnector._import_query(engine, "DROP TABLE customers")
    with pytest.raises(ValueError, match="one read-only"):
        MySqlConnector._import_query(engine, "SELECT 1; DROP TABLE customers")
    with pytest.raises(ValueError, match="read-only"):
        MySqlConnector._import_query(engine, "CALL refresh_customers()")


def _live_source(prefix: str) -> dict[str, str] | None:
    user = os.environ.get(f"{prefix}_USER", "").strip()
    password = os.environ.get(f"{prefix}_PASSWORD", "").strip()
    database = os.environ.get(f"{prefix}_DB", "").strip()
    host = os.environ.get(f"{prefix}_HOST", "").strip()
    port = os.environ.get(f"{prefix}_PORT", "3306").strip()
    if not all([user, password, database, host]):
        return None
    return {
        "host": host,
        "port": port,
        "database": database,
        "user": user,
        "password": password,
    }


@pytest.mark.parametrize(
    "prefix,label",
    [
        ("SOURCE_MYSQL", "MySQL"),
        ("SOURCE_MARIADB", "MariaDB"),
    ],
)
def test_live_mysql_family_connection_discovery_and_read(prefix: str, label: str):
    creds = _live_source(prefix)
    if creds is None:
        pytest.skip(f"{label} disposable source credentials are not configured")

    connector = MySqlConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "database": creds["database"],
            "user": creds["user"],
        },
        {"password": creds["password"]},
    )
    assert connector.test_connection() == "Connection succeeded."
    schemas = connector.list_schemas()
    assert creds["database"] in schemas
    tables = connector.list_tables(schema=creds["database"])
    names = {row["name"] for row in tables}
    assert "customers" in names

    preview = connector.preview(f"{creds['database']}.customers", limit=2)
    assert "name" in preview.columns
    assert len(preview.rows) == 2

    frame = connector.read_frame(
        f"SELECT name, segment FROM `{creds['database']}`.customers "
        "WHERE segment = 'enterprise'"
    )
    assert list(frame.columns) == ["name", "segment"]
    assert frame.iloc[0]["name"] == "Ada Lovelace"

    with_frame = connector.read_frame(
        "WITH top AS (SELECT name FROM customers WHERE segment = 'growth') "
        "SELECT name FROM top"
    )
    assert with_frame.iloc[0]["name"] == "Grace Hopper"
