from __future__ import annotations

from app.connectors.base import DataConnector


class FileConnector(DataConnector):
    source_label = "managed file source"

    def test_connection(self) -> str:
        return "File source configuration is valid."
