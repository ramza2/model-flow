from __future__ import annotations

import json

from app.connectors.base import DataConnector
from app.connectors.file import FileConnector
from app.connectors.mssql import MssqlConnector
from app.connectors.mysql import MySqlConnector
from app.connectors.oracle import OracleConnector
from app.connectors.postgres import PostgresConnector
from app.connectors.rest_api import RestApiConnector
from app.core.security import decrypt_secret
from app.db.models import DataSource, DataSourceType


def _json_dict(value: str | None) -> dict:
    try:
        result = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return result if isinstance(result, dict) else {}


_CONNECTOR_TYPES: dict[DataSourceType, type[DataConnector]] = {
    DataSourceType.file: FileConnector,
    DataSourceType.postgres: PostgresConnector,
    DataSourceType.mysql: MySqlConnector,
    DataSourceType.mssql: MssqlConnector,
    DataSourceType.oracle: OracleConnector,
    DataSourceType.rest_api: RestApiConnector,
}


def connector_for_source(source: DataSource) -> DataConnector:
    connector_type = _CONNECTOR_TYPES.get(source.source_type)
    if connector_type is None:
        raise ValueError(
            f"Unsupported data source type: {source.source_type.value}."
        )
    config = _json_dict(source.config_json)
    secrets = (
        _json_dict(decrypt_secret(source.secret_encrypted))
        if source.secret_encrypted
        else {}
    )
    return connector_type(config, secrets)
