"""API coverage for read-only historical PipelineVersion lookup."""

from __future__ import annotations

import json

from app.db.models import Pipeline, PipelineVersion
from app.db.session import TestingSessionLocal


def test_get_pipeline_version_returns_exact_stored_graph(client, auth_headers):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "pipeline-version-read"},
    ).json()
    graph_v1 = {
        "nodes": [
            {
                "id": "load",
                "position": {"x": 0, "y": 0},
                "data": {"node_type": "notification", "label": "Notify", "config": {}},
            }
        ],
        "edges": [],
    }
    pipeline = client.post(
        f"/api/v1/projects/{project['id']}/pipelines",
        headers=auth_headers,
        json={"name": "versioned", "graph": graph_v1},
    ).json()
    assert pipeline["version"]["version"] == 1
    version_id = pipeline["version"]["id"]

    graph_v2 = {
        "nodes": [
            {
                "id": "load",
                "position": {"x": 0, "y": 0},
                "data": {"node_type": "notification", "label": "Notify", "config": {}},
            },
            {
                "id": "second",
                "position": {"x": 200, "y": 0},
                "data": {"node_type": "notification", "label": "Second", "config": {}},
            },
        ],
        "edges": [{"source": "load", "target": "second", "data": {"branch": "always"}}],
    }
    saved = client.post(
        f"/api/v1/projects/{project['id']}/pipelines/{pipeline['id']}/versions",
        headers=auth_headers,
        json={"graph": graph_v2},
    )
    assert saved.status_code == 201

    historical = client.get(
        f"/api/v1/projects/{project['id']}/pipeline-versions/{version_id}",
        headers=auth_headers,
    )
    assert historical.status_code == 200
    body = historical.json()
    assert body["id"] == version_id
    assert body["version"] == 1
    assert body["pipeline_id"] == pipeline["id"]
    assert len(body["graph"]["nodes"]) == 1
    assert body["graph"]["nodes"][0]["id"] == "load"

    latest = client.get(
        f"/api/v1/projects/{project['id']}/pipelines/{pipeline['id']}",
        headers=auth_headers,
    ).json()
    assert latest["version"]["version"] == 2
    assert len(latest["version"]["graph"]["nodes"]) == 2


def test_get_pipeline_version_missing_and_cross_project(client, auth_headers):
    project_a = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "pipeline-version-a"},
    ).json()
    project_b = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": "pipeline-version-b"},
    ).json()
    pipeline = client.post(
        f"/api/v1/projects/{project_a['id']}/pipelines",
        headers=auth_headers,
        json={
            "name": "scoped",
            "graph": {
                "nodes": [
                    {
                        "id": "n1",
                        "position": {"x": 0, "y": 0},
                        "data": {"node_type": "notification", "config": {}},
                    }
                ],
                "edges": [],
            },
        },
    ).json()
    version_id = pipeline["version"]["id"]

    missing = client.get(
        f"/api/v1/projects/{project_a['id']}/pipeline-versions/999999",
        headers=auth_headers,
    )
    assert missing.status_code == 404

    cross = client.get(
        f"/api/v1/projects/{project_b['id']}/pipeline-versions/{version_id}",
        headers=auth_headers,
    )
    assert cross.status_code == 404


def test_get_pipeline_version_requires_auth(client):
    response = client.get("/api/v1/projects/1/pipeline-versions/1")
    assert response.status_code in {401, 403}
