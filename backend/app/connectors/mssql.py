from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Iterator
from urllib.parse import quote_plus, unquote, urlencode, urlparse, urlunparse

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine

from app.connectors.base import ConnectorPreview, frame_preview
from app.connectors.sql_relational import (
    SqlAlchemyRelationalConnector,
    build_import_query,
    parse_unique_query_params,
    reject_select_side_effects,
    strip_sql_literals_and_comments,
    validate_table_name,
)

_ALLOWED_MSSQL_URL_SCHEMES = frozenset({"mssql", "mssql+pyodbc"})
_ODBC_DRIVER_18 = "ODBC Driver 18 for SQL Server"
# Explicit allowlist only — blocks odbc_connect, Windows/AD/Kerberos bypasses.
_ALLOWED_MSSQL_ODBC_QUERY_KEYS = frozenset(
    {"driver", "encrypt", "trustservercertificate"}
)
_ALLOWED_ODBC_YES_NO = frozenset({"yes", "no"})
_MSSQL_URL_USERNAME_REQUIRED = (
    "MSSQL Connection URL requires an explicit username."
)

# SQL Server has no transaction-level READ ONLY; validation must be strict.
_MSSQL_FORBIDDEN_KEYWORDS = re.compile(
    r"\b(insert|update|delete|merge|exec|execute|drop|alter|create|truncate)\b",
    re.IGNORECASE,
)
# SELECT INTO creates a table on SQL Server (distinct from MySQL INTO OUTFILE).
_MSSQL_SELECT_INTO = re.compile(
    r"\binto\s+(?!outfile\b|dumpfile\b)",
    re.IGNORECASE,
)
# NEXT VALUE FOR mutates sequence state even though it looks like SELECT.
_MSSQL_NEXT_VALUE_FOR = re.compile(
    r"\bnext\s+value\s+for\b",
    re.IGNORECASE,
)


def normalize_mssql_sqlalchemy_url(raw: str) -> str:
    """Accept only mssql / mssql+pyodbc URLs; never echo credentials."""
    value = raw.strip()
    if not value:
        raise ValueError("Connection URL / DSN is required.")
    parsed = urlparse(value)
    scheme = (parsed.scheme or "").lower()
    if not scheme:
        raise ValueError("Connection URL / DSN must include a scheme.")
    if scheme not in _ALLOWED_MSSQL_URL_SCHEMES:
        raise ValueError(
            "Microsoft SQL Server connection URL must use an mssql scheme."
        )
    if scheme == "mssql":
        return urlunparse(parsed._replace(scheme="mssql+pyodbc"))
    return value


def reject_mssql_side_effects(sql: str) -> None:
    """Stricter than shared SELECT checks — SQL Server lacks txn READ ONLY."""
    reject_select_side_effects(sql)
    cleaned = strip_sql_literals_and_comments(sql)
    if _MSSQL_FORBIDDEN_KEYWORDS.search(cleaned):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )
    if _MSSQL_SELECT_INTO.search(cleaned):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )
    if _MSSQL_NEXT_VALUE_FOR.search(cleaned):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )


def build_mssql_import_query(engine: Engine, resource: str) -> str:
    value = resource.strip()
    if value.endswith(";"):
        value = value[:-1].rstrip()
    if not value or ";" in value:
        raise ValueError("Data imports accept one read-only SELECT or table name.")
    query = build_import_query(engine, resource)
    # Table-name conversions are already safe SELECT *; validate free SQL strictly.
    if not validate_table_name(value):
        reject_mssql_side_effects(query)
    return query


def _odbc_yes_no(value: bool) -> str:
    return "yes" if value else "no"


def _require_mssql_url_username(url: str) -> None:
    """Reject URLs that would let SQLAlchemy inject Trusted_Connection=Yes."""
    parsed = urlparse(url)
    raw_user = parsed.username
    if raw_user is None:
        raise ValueError(_MSSQL_URL_USERNAME_REQUIRED)
    # Percent-decoded empty / whitespace usernames are fail-closed.
    if not unquote(raw_user).strip():
        raise ValueError(_MSSQL_URL_USERNAME_REQUIRED)


def _normalize_odbc_yes_no_value(value: str) -> str:
    """Allow only yes/no (case-insensitive); reject injection-style values."""
    normalized = value.strip().lower()
    if normalized not in _ALLOWED_ODBC_YES_NO:
        raise ValueError(
            "Microsoft SQL Server connection URL Encrypt and "
            "TrustServerCertificate must be yes or no."
        )
    return normalized


def _sanitize_mssql_odbc_query_params(
    params: dict[str, str],
) -> dict[str, str]:
    """Keep only allowlisted ODBC query keys; never echo URL/credentials."""
    sanitized: dict[str, str] = {}
    for key, value in params.items():
        canonical = key.lower()
        if canonical not in _ALLOWED_MSSQL_ODBC_QUERY_KEYS:
            raise ValueError(
                "Microsoft SQL Server connection URL includes an unsupported "
                "query parameter."
            )
        if canonical == "driver":
            # parse_qsl already percent-decodes (+ → space).
            if value.strip() != _ODBC_DRIVER_18:
                raise ValueError(
                    "Microsoft SQL Server connection URL must use "
                    "ODBC Driver 18 for SQL Server."
                )
            sanitized["driver"] = _ODBC_DRIVER_18
        elif canonical == "encrypt":
            sanitized["Encrypt"] = _normalize_odbc_yes_no_value(value)
        else:
            sanitized["TrustServerCertificate"] = _normalize_odbc_yes_no_value(
                value
            )
    return sanitized


def ensure_mssql_odbc_query(
    url: str,
    *,
    encrypt: bool = True,
    trust_server_certificate: bool = False,
) -> str:
    """Allowlist ODBC query params and ensure Driver 18 + TLS defaults."""
    _require_mssql_url_username(url)
    parsed = urlparse(url)
    try:
        raw_params = parse_unique_query_params(parsed.query)
    except ValueError as exc:
        if "duplicate" in str(exc).lower():
            raise ValueError(
                "Microsoft SQL Server connection URL includes duplicate "
                "query parameters."
            ) from None
        raise
    params = _sanitize_mssql_odbc_query_params(raw_params)

    if "driver" not in params:
        params["driver"] = _ODBC_DRIVER_18
    if "Encrypt" not in params:
        params["Encrypt"] = _odbc_yes_no(encrypt)
    if "TrustServerCertificate" not in params:
        params["TrustServerCertificate"] = _odbc_yes_no(trust_server_certificate)

    return urlunparse(parsed._replace(query=urlencode(params)))


class MssqlConnector(SqlAlchemyRelationalConnector):
    """Microsoft SQL Server via ODBC Driver 18 + pyodbc."""

    source_label = "Microsoft SQL Server data source"
    connection_failure_message = (
        "Connection failed. Check the host, database, and credentials."
    )
    default_port = 1433
    sqlalchemy_drivername = "mssql+pyodbc"
    connect_args: dict = {}

    def _secret_url(self) -> str | None:
        raw = self.secrets.get("url") or self.secrets.get("dsn")
        if not raw:
            return None
        return normalize_mssql_sqlalchemy_url(str(raw))

    def _bool_option(self, key: str, default: bool) -> bool:
        raw = self.config.get(key)
        if raw is None:
            return default
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in {"1", "true", "yes", "y"}

    def _tls_options(self) -> tuple[bool, bool]:
        # ODBC Driver 18 defaults: encrypt on, verify server certificate.
        return (
            self._bool_option("encrypt", True),
            self._bool_option("trust_server_certificate", False),
        )

    def _connection_url(self) -> str:
        encrypt, trust = self._tls_options()
        secret_url = self._secret_url()
        if secret_url:
            return ensure_mssql_odbc_query(
                secret_url,
                encrypt=encrypt,
                trust_server_certificate=trust,
            )

        required = ("host", "database", "user")
        missing = [
            key
            for key in required
            if not (self.config.get(key) or self.secrets.get(key))
        ]
        if missing:
            raise ValueError(f"Data source is missing: {', '.join(missing)}.")
        user = quote_plus(str(self.config.get("user") or self.secrets.get("user")))
        password = quote_plus(str(self.secrets.get("password", "")))
        auth = f"{user}:{password}" if self.secrets.get("password") else user
        host = str(self.config.get("host") or self.secrets.get("host"))
        port = int(
            self.config.get("port") or self.secrets.get("port") or self.default_port
        )
        database = quote_plus(
            str(self.config.get("database") or self.secrets.get("database"))
        )
        query = urlencode(
            {
                "driver": _ODBC_DRIVER_18,
                "Encrypt": _odbc_yes_no(encrypt),
                "TrustServerCertificate": _odbc_yes_no(trust),
            }
        )
        return f"mssql+pyodbc://{auth}@{host}:{port}/{database}?{query}"

    def _engine(self) -> Engine:
        return create_engine(
            self._connection_url(),
            pool_pre_ping=True,
        )

    @classmethod
    def _import_query(cls, engine: Engine, resource: str) -> str:
        return build_mssql_import_query(engine, resource)

    @contextmanager
    def _read_only_transaction(self, connection: Connection) -> Iterator[Connection]:
        # SQL Server has no SET/START TRANSACTION READ ONLY equivalent.
        # Safety is query validation (+ disposable fixture SELECT-only user).
        with connection.begin():
            yield connection

    def _read(self, resource: str, *, limit: int | None = None) -> pd.DataFrame:
        """Bounded preview uses fetchmany — SQL Server does not support LIMIT."""
        engine = self._engine()
        try:
            query = self._import_query(engine, resource)
            with engine.connect() as connection:
                with self._read_only_transaction(connection):
                    result = connection.execute(text(query))
                    columns = list(result.keys())
                    if limit is not None:
                        rows = result.fetchmany(int(limit))
                    else:
                        rows = result.fetchall()
                    return pd.DataFrame.from_records(rows, columns=columns)
        finally:
            engine.dispose()

    def preview(self, resource: str, limit: int = 20) -> ConnectorPreview:
        return frame_preview(self._read(resource, limit=limit), limit)
