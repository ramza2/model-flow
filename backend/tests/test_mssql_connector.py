from __future__ import annotations

import os
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app.connectors.mssql import (
    MssqlConnector,
    ensure_mssql_odbc_query,
    normalize_mssql_sqlalchemy_url,
)
from app.connectors.sql_relational import host_port_sqlalchemy_url


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


def test_mssql_host_port_url_encodes_password_defaults_port_and_tls():
    connector = MssqlConnector(
        {"host": "mssql-source", "database": "analytics", "user": "reader"},
        {"password": "p@ss:word/1"},
    )
    url = connector._connection_url()
    assert url.startswith("mssql+pyodbc://")
    assert "reader:p%40ss%3Aword%2F1@mssql-source:1433/analytics" in url
    params = parse_qs(urlparse(url).query)
    assert params["driver"] == ["ODBC Driver 18 for SQL Server"]
    assert params["Encrypt"] == ["yes"]
    assert params["TrustServerCertificate"] == ["no"]


def test_mssql_trust_server_certificate_config_option():
    connector = MssqlConnector(
        {
            "host": "mssql-source",
            "database": "analytics",
            "user": "reader",
            "trust_server_certificate": True,
            "encrypt": True,
        },
        {"password": "secret"},
    )
    params = parse_qs(urlparse(connector._connection_url()).query)
    assert params["Encrypt"] == ["yes"]
    assert params["TrustServerCertificate"] == ["yes"]


def test_mssql_connection_url_mode_normalizes_and_injects_odbc_defaults():
    assert (
        normalize_mssql_sqlalchemy_url("mssql://u:p@h:1433/db")
        == "mssql+pyodbc://u:p@h:1433/db"
    )
    connector = MssqlConnector({}, {"dsn": "mssql://u:p@h:1433/db"})
    url = connector._connection_url()
    assert url.startswith("mssql+pyodbc://u:p@h:1433/db?")
    params = parse_qs(urlparse(url).query)
    assert params["driver"] == ["ODBC Driver 18 for SQL Server"]
    assert params["Encrypt"] == ["yes"]
    assert params["TrustServerCertificate"] == ["no"]
    # Already-drivered URLs keep caller query and only fill missing ODBC keys.
    with_driver = (
        "mssql+pyodbc://u:p@h:1433/db"
        "?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=no"
    )
    ensured = ensure_mssql_odbc_query(with_driver, trust_server_certificate=True)
    params = parse_qs(urlparse(ensured).query)
    assert params["Encrypt"] == ["no"]
    assert params["TrustServerCertificate"] == ["yes"]


def test_mssql_connection_url_rejects_cross_dialect_schemes():
    for raw in (
        "postgresql://u:secret@h:5432/db",
        "postgresql+psycopg2://u:secret@h:5432/db",
        "mysql://u:secret@h:3306/db",
        "mysql+pymysql://u:secret@h:3306/db",
        "sqlite+pysqlite:///:memory:",
        "oracle+oracledb://u:secret@h/db",
        "arbitrary+driver://u:secret@h/db",
    ):
        with pytest.raises(ValueError, match="mssql scheme"):
            normalize_mssql_sqlalchemy_url(raw)
        with pytest.raises(ValueError, match="mssql scheme") as raised:
            MssqlConnector({}, {"dsn": raw})._connection_url()
        message = str(raised.value)
        assert "secret" not in message
        assert raw not in message


def test_mssql_import_query_allows_select_with_rejects_mutations_and_select_into():
    assert MssqlConnector._import_query(engine, "customers") == (
        'SELECT * FROM "customers"'
    )
    assert MssqlConnector._import_query(engine, "dbo.customers") == (
        'SELECT * FROM "dbo"."customers"'
    )
    assert MssqlConnector._import_query(engine, "SELECT id FROM customers;") == (
        "SELECT id FROM customers"
    )
    assert MssqlConnector._import_query(
        engine, "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte"
    ).lower().startswith("with ")

    for bad in (
        "DELETE FROM customers",
        "INSERT INTO customers VALUES (1)",
        "UPDATE customers SET name='x'",
        "DROP TABLE customers",
        "EXEC sp_help",
        "EXECUTE sp_help",
        "MERGE customers AS t USING (SELECT 1 AS id) AS s ON 1=1 "
        "WHEN MATCHED THEN UPDATE SET name='x';",
        "WITH target AS (SELECT id FROM customers) "
        "UPDATE customers SET segment='x' WHERE id IN (SELECT id FROM target)",
        "WITH target AS (SELECT id FROM customers) "
        "DELETE FROM customers WHERE id IN (SELECT id FROM target)",
        "WITH target AS (SELECT id FROM customers) "
        "INSERT INTO customers (name) SELECT name FROM target",
        "WITH src AS (SELECT 1 AS id) MERGE customers AS t USING src AS s "
        "ON t.id = s.id WHEN MATCHED THEN UPDATE SET name='x';",
        "SELECT id, name INTO new_customers FROM customers",
        "SELECT * INTO #tmp FROM customers",
    ):
        with pytest.raises(ValueError, match="read-only"):
            MssqlConnector._import_query(engine, bad)

    with pytest.raises(ValueError, match="one read-only"):
        MssqlConnector._import_query(engine, "SELECT 1; DROP TABLE customers")


def test_mssql_preview_uses_fetchmany_not_limit_wrapper(monkeypatch):
    connector = MssqlConnector(
        {"host": "mssql-source", "database": "analytics", "user": "reader"},
        {"password": "secret"},
    )
    captured: dict[str, object] = {}

    class FakeResult:
        def keys(self):
            return ["id", "name"]

        def fetchmany(self, size):
            captured["fetchmany"] = size
            return [(1, "Ada"), (2, "Grace")]

        def fetchall(self):
            raise AssertionError("preview must not fetchall when limited")

    class FakeConnection:
        def execute(self, statement):
            captured["sql"] = str(statement)
            return FakeResult()

        def begin(self):
            class _Txn:
                def __enter__(self_inner):
                    return FakeConnection()

                def __exit__(self_inner, *args):
                    return False

            return _Txn()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class FakeEngine:
        def connect(self):
            return FakeConnection()

        def dispose(self):
            captured["disposed"] = True

        @property
        def dialect(self):
            return engine.dialect

    monkeypatch.setattr(connector, "_engine", lambda: FakeEngine())
    preview = connector.preview("SELECT id, name FROM customers", limit=2)
    assert captured["fetchmany"] == 2
    assert "LIMIT" not in str(captured["sql"]).upper()
    assert preview.columns == ["id", "name"]
    assert len(preview.rows) == 2


def _live_source() -> dict[str, str] | None:
    user = os.environ.get("SOURCE_MSSQL_USER", "").strip()
    password = os.environ.get("SOURCE_MSSQL_PASSWORD", "").strip()
    database = os.environ.get("SOURCE_MSSQL_DB", "").strip()
    host = os.environ.get("SOURCE_MSSQL_HOST", "").strip()
    port = os.environ.get("SOURCE_MSSQL_PORT", "1433").strip()
    if not all([user, password, database, host]):
        return None
    return {
        "host": host,
        "port": port,
        "database": database,
        "user": user,
        "password": password,
    }


def _connector_for(creds: dict[str, str]) -> MssqlConnector:
    return MssqlConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "database": creds["database"],
            "user": creds["user"],
            "encrypt": True,
            "trust_server_certificate": True,
        },
        {"password": creds["password"]},
    )


def _customer_fingerprint(creds: dict[str, str]) -> list[tuple]:
    # Use SA only when available to verify mutation attempts failed; otherwise
    # reuse the reader connection for a SELECT fingerprint.
    sa_password = os.environ.get("SOURCE_MSSQL_SA_PASSWORD", "").strip()
    user = "sa" if sa_password else creds["user"]
    password = sa_password or creds["password"]
    url = ensure_mssql_odbc_query(
        host_port_sqlalchemy_url(
            drivername="mssql+pyodbc",
            host=creds["host"],
            port=int(creds["port"]),
            database=creds["database"],
            user=user,
            password=password,
        ),
        encrypt=True,
        trust_server_certificate=True,
    )
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT id, name, email, segment, lifetime_value "
                    "FROM dbo.customers ORDER BY id"
                )
            ).fetchall()
            return [tuple(row) for row in rows]
    finally:
        engine.dispose()


def test_live_mssql_connection_discovery_preview_and_read():
    creds = _live_source()
    if creds is None:
        pytest.skip("SQL Server disposable source credentials are not configured")

    connector = _connector_for(creds)
    assert connector.test_connection() == "Connection succeeded."
    schemas = connector.list_schemas()
    assert "dbo" in schemas
    tables = connector.list_tables(schema="dbo")
    names = {row["name"] for row in tables}
    assert "customers" in names

    preview = connector.preview("dbo.customers", limit=2)
    assert "name" in preview.columns
    assert len(preview.rows) == 2

    frame = connector.read_frame(
        "SELECT name, segment FROM dbo.customers WHERE segment = 'enterprise'"
    )
    assert list(frame.columns) == ["name", "segment"]
    assert frame.iloc[0]["name"] == "Ada Lovelace"

    with_frame = connector.read_frame(
        "WITH growth_customers AS ("
        "SELECT name FROM dbo.customers WHERE segment = 'growth'"
        ") SELECT name FROM growth_customers"
    )
    assert with_frame.iloc[0]["name"] == "Grace Hopper"


def test_live_mssql_read_only_user_rejects_writes_at_permission_layer():
    creds = _live_source()
    if creds is None:
        pytest.skip("SQL Server disposable source credentials are not configured")

    connector = _connector_for(creds)
    before = _customer_fingerprint(creds)
    assert len(before) >= 3

    # Validator rejects WITH … UPDATE before execution.
    with_update = (
        "WITH target AS (SELECT id FROM dbo.customers WHERE segment = 'starter') "
        "UPDATE dbo.customers SET segment = 'mutated' "
        "WHERE id IN (SELECT id FROM target)"
    )
    with pytest.raises(ValueError, match="read-only"):
        connector.read_frame(with_update)

    # Permission layer: even if validation were bypassed, SELECT-only login fails.
    engine = connector._engine()
    try:
        with engine.connect() as connection:
            with pytest.raises(Exception):
                connection.execute(
                    text(
                        "UPDATE dbo.customers SET segment = 'mutated' "
                        "WHERE segment = 'starter'"
                    )
                )
                connection.commit()
    finally:
        engine.dispose()

    after = _customer_fingerprint(creds)
    assert after == before

    ok = connector.read_frame(
        "SELECT name FROM dbo.customers WHERE segment = 'enterprise'"
    )
    assert isinstance(ok, pd.DataFrame)
    assert ok.iloc[0]["name"] == "Ada Lovelace"
