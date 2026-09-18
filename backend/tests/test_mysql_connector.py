from __future__ import annotations

import os

import pandas as pd
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app.connectors.mysql import MySqlConnector, normalize_mysql_sqlalchemy_url
from app.connectors.sql_relational import (
    build_import_query,
    host_port_sqlalchemy_url,
    reject_select_side_effects,
    strip_sql_literals_and_comments,
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
        normalize_mysql_sqlalchemy_url("mysql://u:p@h:3306/db")
        == "mysql+pymysql://u:p@h:3306/db"
    )
    assert (
        normalize_mysql_sqlalchemy_url("mariadb://u:p@h:3306/db")
        == "mysql+pymysql://u:p@h:3306/db"
    )
    connector = MySqlConnector({}, {"dsn": "mysql://u:p@h:3306/db"})
    assert connector._connection_url() == "mysql+pymysql://u:p@h:3306/db"
    # Already-drivered URLs stay untouched.
    assert (
        MySqlConnector({}, {"url": "mysql+pymysql://u:p@h:3306/db"})._connection_url()
        == "mysql+pymysql://u:p@h:3306/db"
    )


def test_mysql_connection_url_rejects_cross_dialect_schemes():
    for raw in (
        "postgresql://u:secret@h:5432/db",
        "postgresql+psycopg2://u:secret@h:5432/db",
        "sqlite+pysqlite:///:memory:",
        "mssql+pyodbc://u:secret@h/db",
        "oracle+oracledb://u:secret@h/db",
        "arbitrary+driver://u:secret@h/db",
    ):
        with pytest.raises(ValueError, match="mysql or mariadb scheme"):
            normalize_mysql_sqlalchemy_url(raw)
        with pytest.raises(ValueError, match="mysql or mariadb scheme") as raised:
            MySqlConnector({}, {"dsn": raw})._connection_url()
        message = str(raised.value)
        assert "secret" not in message
        assert raw not in message


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


def test_import_query_rejects_select_side_effects_without_blocking_literals():
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(
            engine, "SELECT id FROM customers INTO OUTFILE '/tmp/customers.csv'"
        )
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(
            engine, "SELECT id FROM customers INTO DUMPFILE '/tmp/customers.bin'"
        )
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(engine, "SELECT id FROM customers FOR UPDATE")
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(engine, "SELECT id FROM customers LOCK IN SHARE MODE")
    # Comment-glued keywords must still be rejected (space separator after strip).
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(
            engine, "SELECT id FROM customers INTO/**/OUTFILE '/tmp/x'"
        )
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(
            engine, "SELECT id FROM customers INTO/*x*/DUMPFILE '/tmp/x'"
        )
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(engine, "SELECT id FROM customers FOR/**/UPDATE")
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(
            engine, "SELECT id FROM customers LOCK/**/IN SHARE MODE"
        )
    # MySQL executable comments are fail-closed.
    with pytest.raises(ValueError, match="read-only"):
        build_import_query(
            engine, "SELECT id FROM customers /*! INTO OUTFILE '/tmp/x' */"
        )
    # String literals containing forbidden phrases must still be allowed.
    assert build_import_query(engine, "SELECT 'FOR UPDATE' AS note") == (
        "SELECT 'FOR UPDATE' AS note"
    )
    assert build_import_query(engine, "SELECT 'INTO OUTFILE /tmp/x' AS note") == (
        "SELECT 'INTO OUTFILE /tmp/x' AS note"
    )
    allowed = (
        "SELECT 'FOR UPDATE' AS note, 'INTO OUTFILE /tmp/x' AS path "
        "FROM customers WHERE name = 'LOCK IN SHARE MODE'"
    )
    assert build_import_query(engine, allowed) == allowed
    cleaned = strip_sql_literals_and_comments(allowed)
    assert "FOR UPDATE" not in cleaned.upper()
    reject_select_side_effects(allowed)


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


def _connector_for(creds: dict[str, str]) -> MySqlConnector:
    return MySqlConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "database": creds["database"],
            "user": creds["user"],
        },
        {"password": creds["password"]},
    )


def _customer_fingerprint(creds: dict[str, str]) -> list[tuple]:
    engine = create_engine(
        host_port_sqlalchemy_url(
            drivername="mysql+pymysql",
            host=creds["host"],
            port=int(creds["port"]),
            database=creds["database"],
            user=creds["user"],
            password=creds["password"],
        ),
        pool_pre_ping=True,
    )
    try:
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT id, name, email, segment, lifetime_value "
                    "FROM customers ORDER BY id"
                )
            ).fetchall()
            return [tuple(row) for row in rows]
    finally:
        engine.dispose()


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

    connector = _connector_for(creds)
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


@pytest.mark.parametrize(
    "prefix,label",
    [
        ("SOURCE_MYSQL", "MySQL"),
        ("SOURCE_MARIADB", "MariaDB"),
    ],
)
def test_live_mysql_family_read_only_transaction_rejects_writes(
    prefix: str, label: str
):
    creds = _live_source(prefix)
    if creds is None:
        pytest.skip(f"{label} disposable source credentials are not configured")

    connector = _connector_for(creds)
    before = _customer_fingerprint(creds)
    assert len(before) >= 3

    # Validator allows WITH …; DB-level READ ONLY must still reject mutation.
    with_update = (
        "WITH target AS (SELECT id FROM customers WHERE segment = 'starter') "
        "UPDATE customers SET segment = 'mutated' "
        "WHERE id IN (SELECT id FROM target)"
    )
    assert MySqlConnector._import_query(engine, with_update) == with_update
    with pytest.raises(Exception):
        connector.read_frame(with_update)

    with_delete = (
        "WITH target AS (SELECT id FROM customers WHERE segment = 'growth') "
        "DELETE FROM customers WHERE id IN (SELECT id FROM target)"
    )
    assert MySqlConnector._import_query(engine, with_delete) == with_delete
    with pytest.raises(Exception):
        connector.read_frame(with_delete)

    # Locking SELECT is rejected by the import validator before execution.
    with pytest.raises(ValueError, match="read-only"):
        connector.read_frame("SELECT id FROM customers FOR UPDATE")

    after = _customer_fingerprint(creds)
    assert after == before

    # Normal SELECT still works after rejected write attempts.
    ok = connector.read_frame("SELECT name FROM customers WHERE segment = 'enterprise'")
    assert isinstance(ok, pd.DataFrame)
    assert ok.iloc[0]["name"] == "Ada Lovelace"
