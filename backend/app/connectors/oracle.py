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
    parse_unique_query_params,
    reject_select_side_effects,
    strip_sql_literals_and_comments,
    validate_table_name,
)

_ALLOWED_ORACLE_URL_SCHEMES = frozenset({"oracle", "oracle+oracledb"})
# Thin-mode Host/Port and URL modes: service_name only (no SID / wallet / thick).
_ALLOWED_ORACLE_QUERY_KEYS = frozenset({"service_name"})
_ORACLE_URL_USERNAME_REQUIRED = (
    "Oracle Connection URL requires an explicit username."
)
_ORACLE_SERVICE_NAME_REQUIRED = (
    "Oracle data source requires a non-empty service_name."
)
_ORACLE_DUPLICATE_QUERY = (
    "Oracle connection URL includes duplicate query parameters."
)

# Application-level defense in depth (DB also uses SET TRANSACTION READ ONLY).
_ORACLE_FORBIDDEN_KEYWORDS = re.compile(
    r"\b("
    r"insert|update|delete|merge|call|exec|execute|"
    r"drop|alter|create|truncate|begin|declare|grant|revoke"
    r")\b",
    re.IGNORECASE,
)
# Sequence NEXTVAL advances state even inside SELECT.
_ORACLE_SEQUENCE_NEXTVAL = re.compile(
    r"\.\s*nextval\b",
    re.IGNORECASE,
)
# identifier( or schema.pkg.fn( — used to gate UDF / package calls.
_ORACLE_CALL_PATTERN = re.compile(
    r"(?P<qual>(?:[A-Za-z_][\w$#]*\s*\.\s*)+)?(?P<name>[A-Za-z_][\w$#]*)\s*\(",
    re.IGNORECASE,
)
# Allowlisted SQL / Oracle built-ins + type names used as TYPE(n) in CAST.
# Package-qualified calls are always rejected (autonomous UDF / package risk).
_ORACLE_ALLOWED_CALL_NAMES = frozenset(
    {
        # aggregates / numeric
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "round",
        "trunc",
        "abs",
        "floor",
        "ceil",
        "mod",
        "greatest",
        "least",
        "sign",
        "power",
        "sqrt",
        # null / conditional
        "nvl",
        "nvl2",
        "coalesce",
        "nullif",
        "decode",
        # conversion
        "cast",
        "to_char",
        "to_number",
        "to_date",
        "to_timestamp",
        "to_timestamp_tz",
        "convert",
        "ascii",
        "chr",
        # string
        "upper",
        "lower",
        "initcap",
        "trim",
        "ltrim",
        "rtrim",
        "substr",
        "substring",
        "length",
        "replace",
        "instr",
        "lpad",
        "rpad",
        "concat",
        "regexp_replace",
        "regexp_substr",
        "regexp_like",
        "regexp_count",
        "regexp_instr",
        # datetime
        "extract",
        "sysdate",
        "current_date",
        "current_timestamp",
        "systimestamp",
        "localtimestamp",
        "numtodsinterval",
        "numtoyminterval",
        # session / context (read-only)
        "sys_context",
        "userenv",
        # SQL constructs that use parentheses
        "exists",
        "in",
        "any",
        "all",
        "some",
        "as",
        # window / analytic
        "over",
        "rank",
        "dense_rank",
        "row_number",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "ntile",
        # datatype names appearing as TYPE(precision) in CAST / columns
        "varchar2",
        "nvarchar2",
        "varchar",
        "char",
        "nchar",
        "number",
        "numeric",
        "decimal",
        "float",
        "binary_float",
        "binary_double",
        "raw",
        "timestamp",
        "interval",
        "clob",
        "nclob",
        "blob",
        "date",
        "integer",
        "int",
        "smallint",
    }
)


def normalize_oracle_sqlalchemy_url(raw: str) -> str:
    """Accept only oracle / oracle+oracledb URLs; never echo credentials."""
    value = raw.strip()
    if not value:
        raise ValueError("Connection URL / DSN is required.")
    # urlparse rejects underscores in schemes (e.g. oracle+cx_oracle); detect first.
    lower = value.lower()
    if lower.startswith("oracle+oracledb:"):
        return value
    if lower.startswith("oracle:"):
        parsed = urlparse(value)
        return urlunparse(parsed._replace(scheme="oracle+oracledb"))
    if "://" in value or lower.startswith("oracle"):
        raise ValueError(
            "Oracle connection URL must use an oracle or oracle+oracledb scheme."
        )
    raise ValueError("Connection URL / DSN must include a scheme.")


def _skip_oracle_sql_trivia(sql: str, start: int) -> int:
    """Skip whitespace and non-nested ``--`` / ``/* */`` comments after a token.

    Used after a closing double-quoted identifier so comment-glue forms such as
    ``"SIDE_EFFECT_PROBE"/*x*/()`` cannot bypass the quoted-call check.
    """
    i = start
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch.isspace():
            i += 1
            continue
        if ch == "-" and nxt == "-":
            i += 2
            while i < n and sql[i] not in "\r\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i = min(i + 2, n)
            continue
        break
    return i


def reject_oracle_quoted_function_calls(sql: str) -> None:
    """Reject double-quoted identifiers used as function calls.

    Shared ``strip_sql_literals_and_comments`` treats ``"..."`` as a string
    literal and removes it. In Oracle, double quotes denote identifiers, so
    ``SELECT "SIDE_EFFECT_PROBE"() FROM dual`` would otherwise bypass the
    unquoted UDF allowlist after stripping. Scan the original SQL while still
    ignoring comments and single-quoted string literals. After a closing
    quote, skip trivia (whitespace / comments) before testing for ``(``.
    """
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            while i < n and sql[i] not in "\r\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i = min(i + 2, n)
            continue
        if ch == "'":
            i += 1
            while i < n:
                if sql[i] == "'" and i + 1 < n and sql[i + 1] == "'":
                    i += 2
                    continue
                if sql[i] == "'":
                    i += 1
                    break
                i += 1
            continue
        if ch == '"':
            i += 1
            while i < n:
                if sql[i] == '"' and i + 1 < n and sql[i + 1] == '"':
                    # Oracle doubled quote inside a quoted identifier.
                    i += 2
                    continue
                if sql[i] == '"':
                    i += 1
                    break
                i += 1
            i = _skip_oracle_sql_trivia(sql, i)
            if i < n and sql[i] == "(":
                raise ValueError(
                    "Data imports accept only a read-only SELECT or table name."
                )
            continue
        i += 1


def reject_oracle_function_calls(cleaned: str) -> None:
    """Fail closed on package/UDF calls; allow common read-only SQL builtins.

    Oracle READ ONLY applies to the caller transaction only. A SELECT that
    invokes a stored function with PRAGMA AUTONOMOUS_TRANSACTION can still
    commit side effects. Package-qualified calls are always rejected.
    Bare calls must be in the built-in allowlist (COUNT, NVL, CAST, …).
    """
    for match in _ORACLE_CALL_PATTERN.finditer(cleaned):
        qual = (match.group("qual") or "").strip()
        name = match.group("name").lower()
        if qual:
            raise ValueError(
                "Data imports accept only a read-only SELECT or table name."
            )
        if name not in _ORACLE_ALLOWED_CALL_NAMES:
            raise ValueError(
                "Data imports accept only a read-only SELECT or table name."
            )


def reject_oracle_side_effects(sql: str) -> None:
    """Shared SELECT checks plus Oracle PL/SQL / procedure / NEXTVAL / UDF guards."""
    # Quoted-identifier calls must be checked on the original SQL before the
    # shared stripper removes double-quoted tokens as if they were literals.
    reject_oracle_quoted_function_calls(sql)
    reject_select_side_effects(sql)
    cleaned = strip_sql_literals_and_comments(sql)
    if _ORACLE_FORBIDDEN_KEYWORDS.search(cleaned):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )
    if _ORACLE_SEQUENCE_NEXTVAL.search(cleaned):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )
    reject_oracle_function_calls(cleaned)


def quote_oracle_identifier(engine: Engine, name: str) -> str:
    """Quote Oracle identifiers using dialect denormalize (inspector → DB case)."""
    denorm = engine.dialect.denormalize_name(name)
    return engine.dialect.identifier_preparer.quote(denorm)


def build_oracle_import_query(engine: Engine, resource: str) -> str:
    value = resource.strip()
    if value.endswith(";"):
        value = value[:-1].rstrip()
    if not value or ";" in value:
        raise ValueError("Data imports accept one read-only SELECT or table name.")
    if validate_table_name(value):
        parts = value.split(".", 1)
        quoted = [quote_oracle_identifier(engine, part) for part in parts]
        return f"SELECT * FROM {'.'.join(quoted)}"
    if not re.match(r"^(select|with)\b", value, flags=re.IGNORECASE):
        raise ValueError(
            "Data imports accept only a read-only SELECT or table name."
        )
    reject_oracle_side_effects(value)
    return value


def _require_oracle_url_username(url: str) -> None:
    parsed = urlparse(url)
    raw_user = parsed.username
    if raw_user is None:
        raise ValueError(_ORACLE_URL_USERNAME_REQUIRED)
    if not unquote(raw_user).strip():
        raise ValueError(_ORACLE_URL_USERNAME_REQUIRED)


def _sanitize_oracle_query_params(params: dict[str, str]) -> dict[str, str]:
    """Allow only service_name; reject thick/wallet/SID and injection values."""
    sanitized: dict[str, str] = {}
    for key, value in params.items():
        canonical = key.lower()
        if canonical not in _ALLOWED_ORACLE_QUERY_KEYS:
            raise ValueError(
                "Oracle connection URL includes an unsupported query parameter."
            )
        cleaned = value.strip()
        if not cleaned:
            raise ValueError(_ORACLE_SERVICE_NAME_REQUIRED)
        # Reject delimiter / attribute injection (fail-closed; do not trust quoting).
        if any(ch in cleaned for ch in (";", "\x00", "\n", "\r")):
            raise ValueError(
                "Oracle connection URL service_name contains invalid characters."
            )
        sanitized["service_name"] = cleaned
    return sanitized


def ensure_oracle_service_name_query(url: str) -> str:
    """Require username + allowlisted service_name query; never echo secrets."""
    _require_oracle_url_username(url)
    parsed = urlparse(url)
    try:
        raw_params = parse_unique_query_params(parsed.query)
    except ValueError as exc:
        if "duplicate" in str(exc).lower():
            raise ValueError(_ORACLE_DUPLICATE_QUERY) from None
        raise
    params = _sanitize_oracle_query_params(raw_params)
    if "service_name" not in params:
        raise ValueError(_ORACLE_SERVICE_NAME_REQUIRED)
    # Do not carry a database path that could be mistaken for SID/service.
    path = parsed.path or ""
    if path not in {"", "/"}:
        raise ValueError(
            "Oracle Connection URL must use service_name query parameter, "
            "not a database path."
        )
    return urlunparse(
        parsed._replace(path="/", query=urlencode(params))
    )


class OracleConnector(SqlAlchemyRelationalConnector):
    """Oracle Database via SQLAlchemy + python-oracledb Thin mode."""

    source_label = "Oracle Database data source"
    connection_failure_message = (
        "Connection failed. Check the host, service name, and credentials."
    )
    default_port = 1521
    sqlalchemy_drivername = "oracle+oracledb"
    connect_args: dict = {}

    def _secret_url(self) -> str | None:
        raw = self.secrets.get("url") or self.secrets.get("dsn")
        if not raw:
            return None
        return normalize_oracle_sqlalchemy_url(str(raw))

    def _connection_url(self) -> str:
        secret_url = self._secret_url()
        if secret_url:
            return ensure_oracle_service_name_query(secret_url)

        required = ("host", "service_name", "user")
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
        service_name = str(
            self.config.get("service_name") or self.secrets.get("service_name")
        ).strip()
        if not service_name:
            raise ValueError(_ORACLE_SERVICE_NAME_REQUIRED)
        if any(ch in service_name for ch in (";", "\x00", "\n", "\r")):
            raise ValueError(
                "Oracle service_name contains invalid characters."
            )
        query = urlencode({"service_name": service_name})
        return f"oracle+oracledb://{auth}@{host}:{port}/?{query}"

    def _engine(self) -> Engine:
        # Thin mode is python-oracledb default; Instant Client / thick is out of scope.
        return create_engine(
            self._connection_url(),
            pool_pre_ping=True,
        )

    @classmethod
    def _import_query(cls, engine: Engine, resource: str) -> str:
        return build_oracle_import_query(engine, resource)

    @contextmanager
    def _read_only_transaction(self, connection: Connection) -> Iterator[Connection]:
        """Oracle: begin, then SET TRANSACTION READ ONLY as the first statement."""
        with connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            yield connection

    def _read(self, resource: str, *, limit: int | None = None) -> pd.DataFrame:
        """Bounded preview uses fetchmany — Oracle has no LIMIT clause."""
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

    def test_connection(self) -> str:
        engine = self._engine()
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1 FROM dual"))
            return "Connection succeeded."
        finally:
            engine.dispose()
