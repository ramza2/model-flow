from __future__ import annotations

import json
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
import pandas as pd

from app.connectors.base import ConnectorPreview, DataConnector, frame_preview

_MAX_RESPONSE_BYTES = 20 * 1024 * 1024


class RestApiConnector(DataConnector):
    source_label = "REST API data source"
    connection_failure_message = (
        "Connection failed. Check the base URL, resource path, and credentials."
    )
    supports_import = True

    def __init__(
        self,
        config: dict,
        secrets: dict,
        *,
        transport: httpx.BaseTransport | None = None,
    ):
        self.config = config
        self.secrets = secrets
        self.transport = transport

        self.base_url = str(config.get("base_url") or "").strip()
        parsed = urlparse(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("REST API base_url must be an absolute http(s) URL.")
        if parsed.username or parsed.password:
            raise ValueError(
                "REST API credentials must not be embedded in base_url."
            )

        self.resource_path = str(config.get("resource_path") or "").strip()
        self.data_path = str(config.get("data_path") or "").strip()
        self.auth_type = str(config.get("auth_type") or "none").strip().lower()
        if self.auth_type not in {"none", "bearer", "api_key"}:
            raise ValueError("REST API auth_type must be none, bearer, or api_key.")

        timeout_value = config.get("timeout_seconds", 10)
        try:
            self.timeout_seconds = float(timeout_value)
        except (TypeError, ValueError) as exc:
            raise ValueError("REST API timeout_seconds must be numeric.") from exc
        if not 1 <= self.timeout_seconds <= 60:
            raise ValueError("REST API timeout_seconds must be between 1 and 60.")

        query_params = config.get("query_params", {})
        if query_params is None:
            query_params = {}
        if not isinstance(query_params, dict):
            raise ValueError("REST API query_params must be a JSON object.")
        self.query_params = query_params

        self.api_key_header = str(
            config.get("api_key_header") or "X-API-Key"
        ).strip()
        if self.auth_type == "api_key" and not self.api_key_header:
            raise ValueError("REST API api_key_header is required for API key auth.")

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.auth_type == "bearer":
            token = str(
                self.secrets.get("bearer_token")
                or self.secrets.get("token")
                or ""
            ).strip()
            if not token:
                raise ValueError("REST API bearer token is missing.")
            headers["Authorization"] = f"Bearer {token}"
        elif self.auth_type == "api_key":
            api_key = str(self.secrets.get("api_key") or "").strip()
            if not api_key:
                raise ValueError("REST API API key is missing.")
            headers[self.api_key_header] = api_key
        return headers

    def _resource_url(self, resource: str) -> str:
        selected = resource.strip() or self.resource_path
        parsed = urlparse(selected)
        if parsed.scheme or parsed.netloc:
            raise ValueError(
                "REST API resource must be a relative path under the configured base URL."
            )
        base = self.base_url.rstrip("/") + "/"
        target = urljoin(base, selected.lstrip("/"))
        base_parsed = urlparse(base)
        target_parsed = urlparse(target)
        base_path = base_parsed.path.rstrip("/") + "/"
        if (
            target_parsed.scheme != base_parsed.scheme
            or target_parsed.netloc != base_parsed.netloc
            or not target_parsed.path.startswith(base_path)
        ):
            raise ValueError(
                "REST API resource must remain under the configured base URL."
            )
        return target

    def _request_json(self, resource: str) -> Any:
        with httpx.Client(
            timeout=self.timeout_seconds,
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            with client.stream(
                "GET",
                self._resource_url(resource),
                headers=self._headers(),
                params=self.query_params or None,
            ) as response:
                response.raise_for_status()
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > _MAX_RESPONSE_BYTES:
                        raise ValueError(
                            "REST API response exceeds the 20 MiB connector safety limit."
                        )
                    chunks.append(chunk)
        try:
            return json.loads(b"".join(chunks))
        except (TypeError, ValueError) as exc:
            raise ValueError("REST API response is not valid JSON.") from exc

    def _extract_data(self, payload: Any) -> Any:
        current = payload
        if self.data_path:
            for segment in self.data_path.split("."):
                segment = segment.strip()
                if not segment:
                    continue
                if isinstance(current, dict) and segment in current:
                    current = current[segment]
                    continue
                if isinstance(current, list) and segment.isdigit():
                    index = int(segment)
                    if index < len(current):
                        current = current[index]
                        continue
                raise ValueError(
                    f"REST API data_path segment '{segment}' was not found."
                )
        return current

    def _frame_from_payload(self, payload: Any) -> pd.DataFrame:
        data = self._extract_data(payload)
        if isinstance(data, dict):
            records = [data]
        elif isinstance(data, list) and all(isinstance(row, dict) for row in data):
            records = data
        else:
            raise ValueError(
                "REST API data must be a JSON object or an array of JSON objects."
            )
        if not records:
            raise ValueError("REST API response contains no tabular rows.")
        frame = pd.json_normalize(records, sep=".")
        if not len(frame.columns):
            raise ValueError("REST API response contains no tabular columns.")
        return frame

    def test_connection(self) -> str:
        self._request_json(self.resource_path)
        return "Connection succeeded. JSON response received."

    def preview(self, resource: str, limit: int = 20) -> ConnectorPreview:
        frame = self._frame_from_payload(self._request_json(resource))
        return frame_preview(frame, limit)

    def read_frame(self, resource: str) -> pd.DataFrame:
        return self._frame_from_payload(self._request_json(resource))
