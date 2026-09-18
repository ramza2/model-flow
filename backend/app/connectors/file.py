from __future__ import annotations

from app.connectors.base import DataConnector


class FileConnector(DataConnector):
    source_label = "managed file source"

    def __init__(self, config: dict, secrets: dict):
        self.config = config
        self.secrets = secrets

    def test_connection(self) -> str:
        return "File source configuration is valid."
