"""Phase 4-E cross-connector security / read-only regression helpers.

This module documents the acceptance matrix and encodes gap-filling checks
that are not already covered by per-connector suites.
"""

from __future__ import annotations

import pytest

from app.connectors.mssql import MssqlConnector, normalize_mssql_sqlalchemy_url
from app.connectors.mysql import MySqlConnector, normalize_mysql_sqlalchemy_url
from app.connectors.oracle import OracleConnector, normalize_oracle_sqlalchemy_url
from app.connectors.postgres import (
    PostgresConnector,
    normalize_postgres_sqlalchemy_url,
)
from app.connectors.sql_relational import parse_unique_query_params


# Relational acceptance matrix (covered by unit + live + lifecycle + E2E suites):
#
# | concern              | PG | MySQL | MariaDB | MSSQL | Oracle |
# | connection           | Y  | Y     | Y       | Y     | Y      |
# | schema/table disc.   | Y  | Y     | Y       | Y     | Y      |
# | preview              | Y  | Y     | Y       | Y     | Y      |
# | table / SELECT / WITH| Y  | Y     | Y       | Y     | Y      |
# | mutation reject      | Y  | Y     | Y       | Y     | Y      |
# | DB read-only defense | Y  | Y     | Y       | N*    | Y      |
# | secret redaction     | Y  | Y     | Y       | Y     | Y      |
# | mode-switch cleanup  | Y  | Y     | Y       | Y     | Y      |
# | DatasetVersion/lineage| Y | Y     | Y       | Y     | Y      |
#
# * MSSQL has no transaction READ ONLY; application validator + SELECT-only fixture.
#
# REST (separate): GET-only, auth redaction, size/timeout bounds, JSON path, lineage.


def test_parse_unique_query_params_rejects_case_insensitive_duplicates():
    assert parse_unique_query_params("a=1&b=2") == {"a": "1", "b": "2"}
    with pytest.raises(ValueError, match="duplicate"):
        parse_unique_query_params("service_name=A&service_name=B")
    with pytest.raises(ValueError, match="duplicate"):
        parse_unique_query_params("service_name=A&SERVICE_NAME=B")
    with pytest.raises(ValueError, match="duplicate"):
        parse_unique_query_params("Encrypt=yes&encrypt=no")


def test_postgres_url_normalizes_and_rejects_cross_dialect():
    assert (
        normalize_postgres_sqlalchemy_url(
            "postgresql://u:p@h:5432/db"
        )
        == "postgresql+psycopg2://u:p@h:5432/db"
    )
    assert (
        normalize_postgres_sqlalchemy_url(
            "postgres://u:p@h:5432/db"
        )
        == "postgresql+psycopg2://u:p@h:5432/db"
    )
    for raw in (
        "mysql://u:secret@h/db",
        "mssql://u:secret@h/db",
        "oracle://u:secret@h/?service_name=X",
        "sqlite+pysqlite:///:memory:",
    ):
        with pytest.raises(ValueError, match="postgresql") as raised:
            normalize_postgres_sqlalchemy_url(raw)
        assert "secret" not in str(raised.value)
        assert raw not in str(raised.value)

    url = PostgresConnector(
        {}, {"dsn": "postgresql://reader:secret-pass@pg:5432/analytics"}
    )._connection_url()
    assert url.startswith("postgresql+psycopg2://reader:secret-pass@pg:5432/")


def test_cross_dialect_url_schemes_are_rejected_without_echoing_secrets():
    cases = [
        (normalize_oracle_sqlalchemy_url, "postgresql://u:secret@h/db"),
        (normalize_oracle_sqlalchemy_url, "mssql://u:secret@h/db"),
        (normalize_mssql_sqlalchemy_url, "oracle://u:secret@h/?service_name=X"),
        (normalize_mssql_sqlalchemy_url, "mysql://u:secret@h/db"),
        (normalize_mysql_sqlalchemy_url, "postgresql://u:secret@h/db"),
        (normalize_postgres_sqlalchemy_url, "mysql://u:secret@h/db"),
    ]
    for normalize, raw in cases:
        with pytest.raises(ValueError) as raised:
            normalize(raw)
        message = str(raised.value)
        assert "secret" not in message
        assert raw not in message


def test_sql_connectors_reject_cross_dialect_dsn_without_echoing_secrets():
    secret = "super-secret-pass"
    checks = [
        (OracleConnector, f"postgresql://reader:{secret}@pg:5432/db"),
        (MssqlConnector, f"oracle://reader:{secret}@ora:1521/?service_name=X"),
        (MySqlConnector, f"postgresql://reader:{secret}@pg:5432/db"),
        (PostgresConnector, f"mysql://reader:{secret}@my:3306/db"),
    ]
    for connector_cls, dsn in checks:
        with pytest.raises(ValueError) as raised:
            connector_cls({}, {"dsn": dsn})._connection_url()
        assert secret not in str(raised.value)
        assert dsn not in str(raised.value)
