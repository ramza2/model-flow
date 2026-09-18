from __future__ import annotations

import httpx
import pytest

from app.connectors.rest_api import RestApiConnector


def test_rest_connector_uses_bearer_auth_query_params_and_data_path():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/v1/customers"
        assert request.url.params["limit"] == "2"
        assert request.headers["Authorization"] == "Bearer secret-token"
        return httpx.Response(
            200,
            json={
                "data": {
                    "items": [
                        {"id": 1, "name": "Ada", "profile": {"tier": "gold"}},
                        {"id": 2, "name": "Linus", "profile": {"tier": "silver"}},
                    ]
                }
            },
        )

    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com/v1",
            "resource_path": "/customers",
            "data_path": "data.items",
            "auth_type": "bearer",
            "query_params": {"limit": 2},
        },
        {"bearer_token": "secret-token"},
        transport=httpx.MockTransport(handler),
    )

    assert connector.test_connection() == "Connection succeeded. JSON response received."
    preview = connector.preview("", limit=1).as_dict()
    assert preview["columns"] == ["id", "name", "profile.tier"]
    assert preview["rows"] == [{"id": 1, "name": "Ada", "profile.tier": "gold"}]

    frame = connector.read_frame("/customers")
    assert frame.to_dict(orient="records") == [
        {"id": 1, "name": "Ada", "profile.tier": "gold"},
        {"id": 2, "name": "Linus", "profile.tier": "silver"},
    ]


def test_rest_connector_uses_configured_api_key_header():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Service-Key"] == "api-secret"
        return httpx.Response(200, json=[{"value": 7}])

    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com",
            "resource_path": "/values",
            "auth_type": "api_key",
            "api_key_header": "X-Service-Key",
        },
        {"api_key": "api-secret"},
        transport=httpx.MockTransport(handler),
    )

    assert connector.read_frame("").to_dict(orient="records") == [{"value": 7}]


def test_rest_connector_rejects_absolute_resource_override():
    connector = RestApiConnector(
        {"base_url": "https://api.example.com", "auth_type": "none"},
        {},
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
    )

    with pytest.raises(ValueError, match="relative path"):
        connector.read_frame("https://other.example.com/data")


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ([], "no tabular rows"),
        (["a", "b"], "object or an array of JSON objects"),
    ],
)
def test_rest_connector_rejects_non_tabular_payloads(payload, message):
    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com",
            "resource_path": "/data",
            "auth_type": "none",
        },
        {},
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=payload)
        ),
    )

    with pytest.raises(ValueError, match=message):
        connector.read_frame("")


def test_rest_connector_reports_missing_data_path():
    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com",
            "resource_path": "/data",
            "data_path": "payload.rows",
            "auth_type": "none",
        },
        {},
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"data": []})
        ),
    )

    with pytest.raises(ValueError, match="data_path segment"):
        connector.read_frame("")
