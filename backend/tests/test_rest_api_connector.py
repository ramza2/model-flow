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



def test_rest_connector_rejects_credentials_embedded_in_base_url():
    with pytest.raises(ValueError, match="credentials"):
        RestApiConnector(
            {
                "base_url": "https://user:password@api.example.com/v1",
                "auth_type": "none",
            },
            {},
        )


def test_rest_connector_rejects_resource_path_escape():
    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com/v1",
            "resource_path": "/customers",
            "auth_type": "none",
        },
        {},
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=[{"id": 1}])
        ),
    )

    with pytest.raises(ValueError, match="remain under"):
        connector.read_frame("../admin")



def test_rest_connector_uses_encrypted_secret_query_parameter():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["serviceKey"] == "safety-secret"
        assert request.url.params["returnType"] == "json"
        return httpx.Response(200, json={"body": [{"value": 7}]})

    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com",
            "resource_path": "/values",
            "data_path": "body",
            "auth_type": "none",
            "query_params": {"returnType": "json"},
            "secret_query_param_name": "serviceKey",
        },
        {"query_param_secret": "safety-secret"},
        transport=httpx.MockTransport(handler),
    )

    assert connector.read_frame("").to_dict(orient="records") == [{"value": 7}]


def test_rest_connector_page_number_pagination_collects_all_rows():
    requested_pages: list[int] = []
    rows = [
        {"id": 1},
        {"id": 2},
        {"id": 3},
        {"id": 4},
        {"id": 5},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["pageNo"])
        page_size = int(request.url.params["numOfRows"])
        requested_pages.append(page)
        start = (page - 1) * page_size
        return httpx.Response(
            200,
            json={
                "pageNo": page,
                "numOfRows": page_size,
                "totalCount": len(rows),
                "body": rows[start : start + page_size],
            },
        )

    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com",
            "resource_path": "/values",
            "data_path": "body",
            "auth_type": "none",
            "pagination_mode": "page_number",
            "pagination_page_param": "pageNo",
            "pagination_page_size_param": "numOfRows",
            "pagination_page_size": 2,
            "pagination_start_page": 1,
            "pagination_total_count_path": "totalCount",
            "pagination_max_pages": 10,
        },
        {},
        transport=httpx.MockTransport(handler),
    )

    frame = connector.read_frame("")
    assert frame.to_dict(orient="records") == rows
    assert requested_pages == [1, 2, 3]


def test_rest_connector_preview_only_requests_first_paginated_page():
    requested_pages: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["pageNo"])
        requested_pages.append(page)
        return httpx.Response(
            200,
            json={
                "totalCount": 50,
                "body": [{"id": page * 10 + index} for index in range(10)],
            },
        )

    connector = RestApiConnector(
        {
            "base_url": "https://api.example.com",
            "resource_path": "/values",
            "data_path": "body",
            "auth_type": "none",
            "pagination_mode": "page_number",
            "pagination_page_param": "pageNo",
            "pagination_page_size_param": "numOfRows",
            "pagination_page_size": 10,
            "pagination_start_page": 1,
            "pagination_total_count_path": "totalCount",
        },
        {},
        transport=httpx.MockTransport(handler),
    )

    preview = connector.preview("", limit=2).as_dict()
    assert len(preview["rows"]) == 2
    assert requested_pages == [1]
