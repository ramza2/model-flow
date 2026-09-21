from __future__ import annotations

import os
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app.connectors.oracle import (
    OracleConnector,
    ensure_oracle_service_name_query,
    normalize_oracle_sqlalchemy_url,
)


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


def test_oracle_host_port_url_encodes_password_and_service_name():
    connector = OracleConnector(
        {
            "host": "oracle-source",
            "service_name": "FREEPDB1",
            "user": "reader",
        },
        {"password": "p@ss:word/1"},
    )
    url = connector._connection_url()
    assert url.startswith("oracle+oracledb://")
    assert "reader:p%40ss%3Aword%2F1@oracle-source:1521/" in url
    params = parse_qs(urlparse(url).query)
    assert params["service_name"] == ["FREEPDB1"]
    assert OracleConnector.default_port == 1521


def test_oracle_connection_url_mode_normalizes_bare_oracle_scheme():
    assert (
        normalize_oracle_sqlalchemy_url(
            "oracle://u:p@h:1521/?service_name=FREEPDB1"
        )
        == "oracle+oracledb://u:p@h:1521/?service_name=FREEPDB1"
    )
    connector = OracleConnector(
        {}, {"dsn": "oracle://u:p@h:1521/?service_name=ORCLPDB1"}
    )
    url = connector._connection_url()
    assert url.startswith("oracle+oracledb://u:p@h:1521/")
    assert parse_qs(urlparse(url).query)["service_name"] == ["ORCLPDB1"]


def test_oracle_connection_url_rejects_cross_dialect_schemes():
    for raw in (
        "postgresql://u:secret@h:5432/db",
        "mysql://u:secret@h:3306/db",
        "mssql://u:secret@h:1433/db",
        "mssql+pyodbc://u:secret@h:1433/db",
        "oracle+cx_oracle://u:secret@h/?service_name=X",
        "sqlite+pysqlite:///:memory:",
        "arbitrary+driver://u:secret@h/db",
    ):
        with pytest.raises(ValueError, match="oracle"):
            normalize_oracle_sqlalchemy_url(raw)
        with pytest.raises(ValueError, match="oracle") as raised:
            OracleConnector({}, {"dsn": raw})._connection_url()
        message = str(raised.value)
        assert "secret" not in message
        assert raw not in message


def test_oracle_connection_url_query_parameter_allowlist():
    base = "oracle+oracledb://reader:secret-pass@oracle-source:1521/"
    rejected = (
        f"{base}?sid=ORCL",
        f"{base}?mode=SYSDBA",
        f"{base}?config_dir=/etc/oracle",
        f"{base}?wallet_location=/wallets/x",
        f"{base}?thick_mode=true",
        f"{base}?service_name=FREEPDB1&sid=ORCL",
        f"{base}?service_name=FREEPDB1%3Bmode%3DSYSDBA",
        f"{base}?service_name=",
        "oracle+oracledb://reader:secret-pass@oracle-source:1521/FREEPDB1",
    )
    for raw in rejected:
        with pytest.raises(ValueError) as raised:
            OracleConnector({}, {"dsn": raw})._connection_url()
        message = str(raised.value)
        assert "secret-pass" not in message
        assert raw not in message
        assert "wallet" not in message.lower() or "unsupported" in message.lower()

    allowed = f"{base}?service_name=FREEPDB1"
    url = OracleConnector({}, {"dsn": allowed})._connection_url()
    assert parse_qs(urlparse(url).query)["service_name"] == ["FREEPDB1"]
    assert "secret-pass" not in str(parse_qs(urlparse(url).query))


def test_oracle_connection_url_requires_explicit_username():
    rejected = (
        "oracle+oracledb://oracle-source:1521/?service_name=FREEPDB1",
        "oracle://oracle-source:1521/?service_name=FREEPDB1",
        "oracle+oracledb://:secret-pass@oracle-source:1521/?service_name=FREEPDB1",
        "oracle://:secret-pass@oracle-source:1521/?service_name=FREEPDB1",
        "oracle+oracledb://%20@oracle-source:1521/?service_name=FREEPDB1",
    )
    for raw in rejected:
        with pytest.raises(
            ValueError, match="Oracle Connection URL requires an explicit username"
        ) as raised:
            OracleConnector({}, {"dsn": raw})._connection_url()
        message = str(raised.value)
        assert "secret-pass" not in message
        assert raw not in message

    ok = OracleConnector(
        {},
        {
            "dsn": (
                "oracle+oracledb://user:secret-pass@oracle-source:1521/"
                "?service_name=FREEPDB1"
            )
        },
    )._connection_url()
    assert ok.startswith("oracle+oracledb://user:secret-pass@oracle-source:1521/")
    assert "service_name=FREEPDB1" in ok


def test_oracle_ensure_service_name_query_helper():
    ensured = ensure_oracle_service_name_query(
        "oracle+oracledb://u:p@h:1521/?service_name=X"
    )
    assert ensured.endswith("service_name=X") or "service_name=X" in ensured


def test_oracle_connection_url_rejects_duplicate_service_name():
    base = "oracle+oracledb://reader:secret-pass@oracle-source:1521/"
    for raw in (
        f"{base}?service_name=A&service_name=B",
        f"{base}?service_name=A&SERVICE_NAME=B",
        f"{base}?Service_Name=A&service_name=B",
    ):
        with pytest.raises(ValueError, match="duplicate") as raised:
            OracleConnector({}, {"dsn": raw})._connection_url()
        message = str(raised.value)
        assert "secret-pass" not in message
        assert raw not in message

    ok = OracleConnector(
        {}, {"dsn": f"{base}?service_name=FREEPDB1"}
    )._connection_url()
    assert "service_name=FREEPDB1" in ok


def test_oracle_import_query_allows_select_with_rejects_mutations_and_plsql():
    assert OracleConnector._import_query(engine, "CUSTOMERS") == (
        'SELECT * FROM "CUSTOMERS"'
    )
    assert OracleConnector._import_query(engine, "MODELFLOW.CUSTOMERS") == (
        'SELECT * FROM "MODELFLOW"."CUSTOMERS"'
    )
    # SQLite dialect denormalize is identity; lowercase table form still quotes.
    assert OracleConnector._import_query(engine, "customers").endswith(
        '"customers"'
    ) or OracleConnector._import_query(engine, "customers").endswith(
        '"CUSTOMERS"'
    )
    assert OracleConnector._import_query(engine, "SELECT id FROM customers;") == (
        "SELECT id FROM customers"
    )
    assert OracleConnector._import_query(
        engine, "WITH cte AS (SELECT 1 AS id FROM dual) SELECT * FROM cte"
    ).lower().startswith("with ")

    # Built-in / SQL constructs with parentheses remain allowed.
    for ok in (
        "SELECT COUNT(*) AS n FROM customers",
        "SELECT SUM(lifetime_value) FROM customers",
        "SELECT AVG(lifetime_value) FROM customers",
        "SELECT NVL(segment, 'x') FROM customers",
        "SELECT COALESCE(segment, 'x') FROM customers",
        "SELECT CAST(id AS VARCHAR2(32)) FROM customers",
        "SELECT TO_CHAR(id) FROM customers",
        "SELECT UPPER(name) FROM customers WHERE EXISTS (SELECT 1 FROM dual)",
    ):
        assert OracleConnector._import_query(engine, ok) == ok

    for bad in (
        "DELETE FROM customers",
        "INSERT INTO customers VALUES (1)",
        "UPDATE customers SET name='x'",
        "DROP TABLE customers",
        "MERGE INTO customers t USING (SELECT 1 id FROM dual) s "
        "ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET name='x'",
        "BEGIN NULL; END;",
        "DECLARE x NUMBER; BEGIN NULL; END;",
        "CALL some_proc()",
        "EXEC some_proc",
        "EXECUTE some_proc",
        "SELECT id FROM customers FOR UPDATE",
        "SELECT seq.NEXTVAL FROM dual",
        "select my_seq.nextval from dual",
        "SELECT side_effect_probe() FROM dual",
        "SELECT app.side_effect_probe() FROM dual",
        "SELECT pkg.evil_fn(1) FROM dual",
        "SELECT my_udf(id) FROM customers",
    ):
        with pytest.raises(ValueError, match="read-only"):
            OracleConnector._import_query(engine, bad)

    assert OracleConnector._import_query(
        engine, "SELECT 'seq.NEXTVAL' AS note FROM dual"
    ) == ("SELECT 'seq.NEXTVAL' AS note FROM dual")

    with pytest.raises(ValueError, match="one read-only"):
        OracleConnector._import_query(engine, "SELECT 1 FROM dual; DROP TABLE customers")


def test_oracle_preview_uses_fetchmany_not_limit_wrapper(monkeypatch):
    connector = OracleConnector(
        {
            "host": "oracle-source",
            "service_name": "FREEPDB1",
            "user": "reader",
        },
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

    class NoopResult:
        def keys(self):
            return []

        def fetchmany(self, size):
            return []

        def fetchall(self):
            return []

    class FakeConnection:
        def execute(self, statement):
            sql = str(statement)
            if "SET TRANSACTION" in sql.upper():
                return NoopResult()
            captured["sql"] = sql
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
    user = os.environ.get("SOURCE_ORACLE_USER", "").strip()
    password = os.environ.get("SOURCE_ORACLE_PASSWORD", "").strip()
    service_name = os.environ.get("SOURCE_ORACLE_SERVICE_NAME", "").strip()
    host = os.environ.get("SOURCE_ORACLE_HOST", "").strip()
    port = os.environ.get("SOURCE_ORACLE_PORT", "1521").strip()
    app_user = os.environ.get("SOURCE_ORACLE_APP_USER", "").strip()
    if not all([user, password, service_name, host]):
        return None
    return {
        "user": user,
        "password": password,
        "service_name": service_name,
        "host": host,
        "port": port,
        "app_user": app_user or user,
    }


def test_live_oracle_connection_discovery_preview_and_read():
    creds = _live_source()
    if creds is None:
        pytest.skip("Oracle disposable source credentials are not configured")

    connector = OracleConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "service_name": creds["service_name"],
            "user": creds["user"],
        },
        {"password": creds["password"]},
    )
    assert "succeeded" in connector.test_connection().lower()
    schemas = connector.list_schemas()
    app_schema = next(
        (s for s in schemas if s.lower() == creds["app_user"].lower()),
        None,
    )
    assert app_schema is not None
    tables = connector.list_tables(schema=app_schema)
    names = {str(row["name"]).lower() for row in tables}
    assert "customers" in names

    preview = connector.preview(f"{app_schema}.customers", limit=2)
    assert len(preview.rows) == 2
    assert preview.columns

    frame = connector.read_frame(f"{app_schema}.customers")
    assert len(frame) >= 3

    # Uppercase resource forms also resolve (Oracle unquoted identifiers).
    upper_schema = app_schema.upper()
    frame_upper = connector.read_frame(f"{upper_schema}.CUSTOMERS")
    assert len(frame_upper) >= 3

    select_frame = connector.read_frame(
        f"SELECT name, segment FROM {upper_schema}.customers"
    )
    cols = [str(c).lower() for c in select_frame.columns]
    assert "name" in cols
    assert "segment" in cols

    with_frame = connector.read_frame(
        f"WITH x AS (SELECT name FROM {upper_schema}.customers) SELECT * FROM x"
    )
    assert len(with_frame) >= 3


def test_live_oracle_read_only_transaction_rejects_mutations():
    creds = _live_source()
    if creds is None:
        pytest.skip("Oracle disposable source credentials are not configured")

    # Use APP user (owns CUSTOMERS) so privilege is not the reason mutations fail.
    app_user = creds["app_user"]
    app_password = os.environ.get("SOURCE_ORACLE_APP_PASSWORD", "").strip()
    if not app_password:
        pytest.skip("Oracle APP password not configured for read-only txn probe")

    connector = OracleConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "service_name": creds["service_name"],
            "user": app_user,
        },
        {"password": app_password},
    )
    engine = connector._engine()
    try:
        with engine.connect() as connection:
            with connector._read_only_transaction(connection):
                assert connection.execute(text("SELECT 1 FROM dual")).scalar() == 1
                for sql in (
                    "INSERT INTO customers (name, email, segment, lifetime_value) "
                    "VALUES ('x', 'x@e.com', 's', 1)",
                    "UPDATE customers SET segment = 'x' WHERE ROWNUM = 1",
                    "DELETE FROM customers WHERE ROWNUM = 1",
                    "SELECT id FROM customers FOR UPDATE",
                ):
                    with pytest.raises(Exception) as raised:
                        connection.execute(text(sql))
                    message = str(raised.value)
                    assert "ORA-01456" in message or "READ ONLY" in message.upper()
    finally:
        engine.dispose()


def test_live_oracle_read_only_user_rejects_writes_at_permission_layer():
    creds = _live_source()
    if creds is None:
        pytest.skip("Oracle disposable source credentials are not configured")

    connector = OracleConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "service_name": creds["service_name"],
            "user": creds["user"],
        },
        {"password": creds["password"]},
    )
    app_schema = creds["app_user"].upper()
    engine = create_engine(connector._connection_url())
    try:
        with engine.begin() as connection:
            with pytest.raises(Exception) as raised:
                connection.execute(
                    text(
                        f"INSERT INTO {app_schema}.customers "
                        "(name, email, segment, lifetime_value) "
                        "VALUES ('x', 'x@e.com', 's', 1)"
                    )
                )
            assert "ORA-" in str(raised.value)
    finally:
        engine.dispose()


def test_live_oracle_autonomous_function_bypass_is_blocked_by_validator():
    """Prove autonomous UDF can side-effect under READ ONLY; connector rejects it."""
    creds = _live_source()
    if creds is None:
        pytest.skip("Oracle disposable source credentials are not configured")

    app_user = creds["app_user"]
    app_password = os.environ.get("SOURCE_ORACLE_APP_PASSWORD", "").strip()
    if not app_password:
        pytest.skip("Oracle APP password not configured for autonomous probe")

    app_connector = OracleConnector(
        {
            "host": creds["host"],
            "port": int(creds["port"]),
            "service_name": creds["service_name"],
            "user": app_user,
        },
        {"password": app_password},
    )
    engine = app_connector._engine()
    try:
        with engine.connect() as connection:
            before = connection.execute(
                text("SELECT COUNT(*) FROM customers")
            ).scalar()
            with app_connector._read_only_transaction(connection):
                # Under READ ONLY, autonomous function can still INSERT.
                result = connection.execute(
                    text("SELECT side_effect_probe() FROM dual")
                ).scalar()
                assert int(result) == 1
            after = connection.execute(
                text("SELECT COUNT(*) FROM customers")
            ).scalar()
            assert int(after) == int(before) + 1
            connection.execute(
                text(
                    "DELETE FROM customers WHERE email = 'probe@example.com'"
                )
            )
            connection.commit()
    finally:
        engine.dispose()

    # Application validator must reject before the DB is reached.
    with pytest.raises(ValueError, match="read-only"):
        app_connector.read_frame("SELECT side_effect_probe() FROM dual")
    with pytest.raises(ValueError, match="read-only"):
        app_connector.read_frame(
            f"SELECT {app_user}.side_effect_probe() FROM dual"
        )

    # Built-in aggregates remain allowed through the connector path.
    frame = app_connector.read_frame("SELECT COUNT(*) AS n FROM customers")
    assert len(frame) == 1
