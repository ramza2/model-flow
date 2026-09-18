from __future__ import annotations

import json
from abc import ABC
from dataclasses import dataclass
from typing import Any

import pandas as pd


class ConnectorError(ValueError):
    """Connector configuration or read error safe to surface through API wrappers."""


class ConnectorOperationNotSupported(ConnectorError):
    """Raised when a connector does not implement an optional operation."""


@dataclass(frozen=True)
class ConnectorPreview:
    columns: list[str]
    rows: list[dict[str, Any]]

    def as_dict(self) -> dict[str, Any]:
        return {"columns": self.columns, "rows": self.rows}


def frame_preview(frame: pd.DataFrame, limit: int) -> ConnectorPreview:
    limited = frame.head(limit)
    rows = json.loads(limited.to_json(orient="records", date_format="iso"))
    return ConnectorPreview(
        columns=[str(column) for column in limited.columns],
        rows=rows,
    )


class DataConnector(ABC):
    source_label = "data source"
    connection_failure_message = "Connection failed."
    supports_import = False

    def test_connection(self) -> str:
        raise ConnectorOperationNotSupported(
            f"{self.source_label} does not support connection testing."
        )

    def list_schemas(self) -> list[str]:
        return []

    def list_tables(self, schema: str | None = None) -> list[dict[str, str | None]]:
        return []

    def preview(self, resource: str, limit: int = 20) -> ConnectorPreview:
        raise ConnectorOperationNotSupported(
            f"{self.source_label} does not support preview."
        )

    def read_frame(self, resource: str) -> pd.DataFrame:
        raise ConnectorOperationNotSupported(
            f"{self.source_label} does not support imports."
        )

    def close(self) -> None:
        return None
